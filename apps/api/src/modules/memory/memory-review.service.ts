import { Injectable, Logger } from '@nestjs/common';
import {
  MemoryConflict,
  MemoryLockState,
  MemoryReviewItem,
  MemoryReviewReason,
  ResolveResponse,
} from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';
import { MEMORY_DEFAULT_BRANCH, MemoryGitService } from './memory-git.service';
import { MemoryIndexService } from './memory-index.service';

/**
 * Serviço de **REVIEW + arbitragem** da memória (ADR-0027, **EP-80**).
 *
 * É o ponto de HITL/árbitro da colmeia. Nem o CAS (EP-79) nem o lock (EP-78)
 * decidem sozinhos quando **duas verdades colidem no mesmo trecho** ou quando
 * uma escrita vem **fora do escopo** do autor: nesses dois casos o neurônio sai
 * de `EDITING` e entra em `REVIEW`, e um **árbitro** (agent revisor ou humano)
 * fecha a disputa via `resolve`.
 *
 * Dois gatilhos de `EDITING → REVIEW` (US-200/201):
 * - `'semantic-conflict'` — o merge 3-way parou (`ours`/`theirs` colidem); o
 *   serviço monta um {@link MemoryConflict} (`base`/`ours`/`theirs`/`holder`) —
 *   US-202 — para o árbitro decidir sem re-derivar o contexto.
 * - `'out-of-scope'` — governança: a proposta não é do módulo do autor e não é
 *   aplicada direto; vira entrada em `REVIEW`.
 *
 * Dois desfechos de `resolve` (US-203), ambos `REVIEW → FREE`:
 * - **aceitar** (`content` presente): commita a mutação arbitrada seguindo a
 *   ordem de escrita canônica (git → índice → WS-EP81), poda o ramo do agent e
 *   devolve o novo `headCommit`;
 * - **descartar** (`content` ausente): nada é commitado, o `HEAD` estável
 *   permanece, o ramo do agent é podado.
 *
 * Emitir os eventos `memory.review`/`memory.conflict`/`memory.updated` no WS é
 * EP-81; aqui só marcamos o estado no índice e devolvemos o payload.
 */
@Injectable()
export class MemoryReviewService {
  private readonly logger = new Logger(MemoryReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gitStore: MemoryGitService,
    private readonly index: MemoryIndexService,
  ) {}

  /**
   * US-200/201/202 — `EDITING → REVIEW`. Marca o neurônio como em revisão
   * (`lockState=REVIEW`, `reviewQueued=true`) preservando o `HEAD` estável e
   * devolve o {@link MemoryReviewItem} que o WS transportará. Quando o motivo é
   * `'semantic-conflict'`, monta também o {@link MemoryConflict} (US-202) lendo
   * o lado `theirs` da ponta do ramo efêmero da sessão.
   *
   * @param baseCommit `HEAD` que o holder leu no `acquire` (âncora 3-way). Se
   *   ausente, usa o `baseCommit` já projetado ou o `HEAD` atual do path.
   */
  async enterReview(input: {
    path: string;
    reason: MemoryReviewReason;
    sessionId: string;
    holder: string;
    baseCommit?: string;
  }): Promise<MemoryReviewItem> {
    const row = await this.prisma.memoryIndex.findUnique({ where: { path: input.path } });
    const oursHead = row?.headCommit || (await this.resolveHeadSafe());
    const baseCommit = input.baseCommit ?? row?.baseCommit ?? oursHeadFallback(oursHead);

    let conflict: MemoryConflict | undefined;
    if (input.reason === 'semantic-conflict') {
      conflict = await this.buildConflict({
        path: input.path,
        baseCommit,
        oursHead,
        sessionId: input.sessionId,
        holder: input.holder,
      });
    }

    await this.prisma.memoryIndex.upsert({
      where: { path: input.path },
      create: {
        path: input.path,
        headCommit: oursHead,
        lockState: MemoryLockState.REVIEW,
        holder: input.holder,
        baseCommit,
        activeBranch: sessionBranchName(input.sessionId, input.path),
        reviewQueued: true,
      },
      update: {
        lockState: MemoryLockState.REVIEW,
        holder: input.holder,
        baseCommit,
        activeBranch: sessionBranchName(input.sessionId, input.path),
        reviewQueued: true,
      },
    });

    this.logger.debug(
      `Neuronio "${input.path}" entrou em REVIEW (${input.reason}); holder=${input.holder}.`,
    );
    return {
      path: input.path,
      baseCommit,
      reason: input.reason,
      conflict,
      holder: input.holder,
    };
  }

  /**
   * US-202 — Monta o {@link MemoryConflict} de um conflito semântico lendo os
   * dois lados: `ours` (o `HEAD` estável do path) e `theirs` (a ponta do ramo
   * efêmero `mem/ai/<sessao>/<path>` — a proposta que parou no merge).
   */
  async buildConflict(input: {
    path: string;
    baseCommit: string;
    oursHead: string;
    sessionId: string;
    holder: string;
  }): Promise<MemoryConflict> {
    const oursContent = (await this.gitStore.readNeuron(input.path, input.oursHead)) ?? '';
    const theirs = await this.gitStore.readSessionBranch({
      sessionId: input.sessionId,
      path: input.path,
    });
    return {
      path: input.path,
      baseCommit: input.baseCommit,
      ours: { ref: input.oursHead, content: oursContent },
      theirs: {
        ref: theirs?.ref ?? '',
        content: theirs?.content ?? '',
      },
      holder: input.holder,
    };
  }

  /**
   * US-203 — Fecha um `REVIEW` (`REVIEW → FREE`). Dois desfechos:
   * - **aceitar** (`content` presente): commita a mutação arbitrada via a ordem
   *   canônica (git → índice), poda o ramo do agent e volta a `FREE` com o novo
   *   `headCommit`;
   * - **descartar** (`content` ausente): nada é commitado, o `HEAD` estável
   *   permanece; poda o ramo do agent e volta a `FREE`.
   *
   * Valida compare-and-swap anti-stale: se `baseCommit` não casa com o `HEAD`
   * estável atual do path, lança {@link MemoryReviewStaleError}.
   */
  async resolve(input: {
    path: string;
    baseCommit: string;
    content?: string;
    arbiter?: string;
    sessionId?: string;
  }): Promise<ResolveResponse> {
    const row = await this.prisma.memoryIndex.findUnique({ where: { path: input.path } });
    if (!row || row.lockState !== MemoryLockState.REVIEW) {
      throw new MemoryNotInReviewError(input.path);
    }

    const stableHead = row.headCommit || (await this.resolveHeadSafe());
    // Compare-and-swap anti-stale: a decisão do árbitro foi calculada sobre o
    // estado que ele examinou; se o HEAD avançou desde então, recusamos.
    if (input.baseCommit && input.baseCommit !== row.baseCommit && input.baseCommit !== stableHead) {
      throw new MemoryReviewStaleError(input.path, input.baseCommit, stableHead);
    }

    const sessionId = input.sessionId ?? sessionFromBranch(row.activeBranch);

    if (input.content !== undefined) {
      // Desfecho ACEITAR: commita a mutação arbitrada (git → índice).
      const message = `review: arbitragem de "${input.path}"${
        input.arbiter ? ` por ${input.arbiter}` : ''
      }`;
      const result = await this.index.commitAndReindex({
        path: input.path,
        content: input.content,
        sessionId: sessionId ?? `arbiter-${input.path}`,
        message,
      });
      const headCommit = result.projection.headCommit;
      await this.releaseFromReview(input.path, headCommit);
      await this.pruneIfSession(sessionId, input.path);
      this.logger.debug(`REVIEW de "${input.path}" fechado (aceitar) → ${headCommit}.`);
      return { headCommit };
    }

    // Desfecho DESCARTAR: HEAD estável permanece; só poda o ramo e libera.
    await this.releaseFromReview(input.path, stableHead);
    await this.pruneIfSession(sessionId, input.path);
    this.logger.debug(`REVIEW de "${input.path}" fechado (descartar); HEAD mantido ${stableHead}.`);
    return { headCommit: stableHead };
  }

  // ---------------------------------------------------------------------------
  // Helpers internos.
  // ---------------------------------------------------------------------------

  /** `REVIEW → FREE`: limpa holder/lease/fila e fixa o `headCommit` resultante. */
  private async releaseFromReview(path: string, headCommit: string): Promise<void> {
    await this.prisma.memoryIndex.update({
      where: { path },
      data: {
        lockState: MemoryLockState.FREE,
        holder: null,
        leaseId: null,
        expiresAt: null,
        baseCommit: null,
        activeBranch: null,
        reviewQueued: false,
        headCommit,
      },
    });
  }

  private async pruneIfSession(sessionId: string | undefined, path: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    await this.gitStore.pruneSessionBranch({ sessionId, path });
  }

  private async resolveHeadSafe(): Promise<string> {
    try {
      return await this.gitStore.resolveHead(MEMORY_DEFAULT_BRANCH);
    } catch {
      return '';
    }
  }
}

/** Nome do ramo efêmero por sessão para um path (`mem/ai/<sessao>/<path>`). */
function sessionBranchName(sessionId: string, path: string): string {
  const safeSession = sessionId.replace(/[^\w.-]+/g, '-');
  const filepath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return `mem/ai/${safeSession}/${filepath}`;
}

/** Extrai o `sessionId` de um `activeBranch` `mem/ai/<sessao>/<path>`. */
function sessionFromBranch(activeBranch: string | null | undefined): string | undefined {
  if (!activeBranch) {
    return undefined;
  }
  const m = /^mem\/ai\/([^/]+)\//.exec(activeBranch);
  return m?.[1];
}

/** Fallback do `ours`/base quando não há projeção prévia. */
function oursHeadFallback(head: string): string {
  return head;
}

/**
 * `resolve` recusado pelo compare-and-swap anti-stale: o `HEAD` estável avançou
 * enquanto o `REVIEW` estava aberto e a decisão do árbitro ficou defasada.
 */
export class MemoryReviewStaleError extends Error {
  constructor(
    public readonly path: string,
    public readonly baseCommit: string,
    public readonly currentHead: string,
  ) {
    super(
      `Arbitragem stale em "${path}": base ${baseCommit} != HEAD estavel ${currentHead}; recalcule.`,
    );
    this.name = 'MemoryReviewStaleError';
  }
}

/** `resolve` chamado para um neurônio que não está em `REVIEW`. */
export class MemoryNotInReviewError extends Error {
  constructor(public readonly path: string) {
    super(`Neuronio "${path}" nao esta em REVIEW; nada a arbitrar.`);
    this.name = 'MemoryNotInReviewError';
  }
}
