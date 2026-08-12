import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';
import { MEMORY_DEFAULT_BRANCH, MemoryGitService } from './memory-git.service';
import { MemoryIndexService, NeuronProjection } from './memory-index.service';
import { MemoryEventsService } from './memory-events.service';

/** Nº máximo de tentativas do laço reread→rebase→write após 409 (US-199). */
export const MEMORY_WRITE_MAX_RETRIES = 3;

/** Resultado de uma escrita otimista integrada com sucesso. */
export interface WriteResult {
  oid: string;
  branch: string;
  headCommit: string;
  projection: NeuronProjection;
  retries: number;
}

/**
 * Serviço de **escrita otimista + compare-and-swap** da memória (ADR-0027,
 * **EP-79**).
 *
 * É a peça que garante que a memória não sofre _lost-update_ mesmo com N agents
 * escrevendo em paralelo. O modelo é OTIMISTA:
 * 1. o holder leu um `baseCommit` no `acquire` (EP-78);
 * 2. escreve num ramo efêmero por agent (`mem/ai/<sessao>/<path>`) — US-196;
 * 3. no fechamento, **compare-and-swap** (US-197): se o `HEAD` de `main` para o
 *    path avançou além do `baseCommit`, a escrita é **stale** → 409;
 * 4. quando limpo, faz **merge 3-way** (US-198) integrando em `main`;
 * 5. em 409, o laço **re-lê → rebase (novo base) → reescreve** (US-199) até
 *    `MEMORY_WRITE_MAX_RETRIES`.
 *
 * A ordem de escrita da colmeia é preservada: git commit/merge → reindexa (via
 * `MemoryIndexService`) → (emitir WS é EP-81, fora daqui).
 */
@Injectable()
export class MemoryWriteService {
  private readonly logger = new Logger(MemoryWriteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gitStore: MemoryGitService,
    private readonly index: MemoryIndexService,
    private readonly events: MemoryEventsService,
  ) {}

  /**
   * US-196 — Escrita OTIMISTA num ramo efêmero por agent, SEM tocar `main`.
   * Apenas materializa a proposta do holder no seu ramo `mem/ai/<sessao>/<path>`;
   * a integração (merge/CAS) acontece no `commit` (fechamento).
   */
  async writeOptimistic(input: {
    path: string;
    content: string;
    sessionId: string;
    message: string;
  }): Promise<{ oid: string; branch: string }> {
    return this.gitStore.writeNeuron(input);
  }

  /**
   * US-197/198/199 — Fecha a edição com **compare-and-swap** anti-stale, merge
   * 3-way e retry.
   *
   * `baseCommit` é o `HEAD` que o holder leu no `acquire`. Se, no fechamento, o
   * `HEAD` atual do path em `main` for diferente do `baseCommit`, a proposta é
   * **stale**: fazemos reread→rebase→write e tentamos de novo. Um conflito de
   * merge REAL (não apenas stale) NÃO é resolvido aqui — é sinalizado como
   * `MemoryStaleWriteError` com `reason: 'conflict'` para a Camada 2/EP-80.
   */
  async commit(input: {
    path: string;
    content: string;
    sessionId: string;
    baseCommit: string;
    message: string;
    maxRetries?: number;
  }): Promise<WriteResult> {
    const maxRetries = input.maxRetries ?? MEMORY_WRITE_MAX_RETRIES;
    let base = input.baseCommit;
    let content = input.content;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // US-197 — compare-and-swap: HEAD atual do path deve casar com a base lida.
      const currentHead = await this.currentPathHead(input.path);
      if (currentHead !== base) {
        if (attempt >= maxRetries) {
          throw new MemoryStaleWriteError(input.path, base, currentHead, 'stale');
        }
        // US-199 — rebase: adota o novo HEAD como base e reescreve a proposta.
        this.logger.debug(
          `CAS stale em "${input.path}" (base=${base} head=${currentHead}); rebase #${attempt + 1}.`,
        );
        base = currentHead;
        // A proposta textual do holder é reaplicada sobre o novo base (o merge
        // 3-way abaixo cuida da integração linha-a-linha).
        content = input.content;
      }

      // Materializa a proposta no ramo efêmero (idempotente por attempt).
      const { oid, branch } = await this.gitStore.writeNeuron({
        path: input.path,
        content,
        sessionId: input.sessionId,
        message: input.message,
      });

      // US-198 — merge 3-way do ramo efêmero em main.
      const merge = await this.gitStore.mergeSessionBranch({
        sessionId: input.sessionId,
        path: input.path,
      });
      if (merge.conflict) {
        // Conflito semântico real → não é stale simples; delega ao EP-80.
        throw new MemoryStaleWriteError(input.path, base, await this.currentPathHead(input.path), 'conflict');
      }

      // Sucesso: git integrou. Reindexa (ordem git → índice preservada).
      const headCommit = await this.gitStore.resolveHead(MEMORY_DEFAULT_BRANCH);
      const projection = await this.index.reindexOne(input.path);
      if (!projection) {
        throw new Error(`Falha ao reindexar "${input.path}" após merge ${oid}.`);
      }
      // EP-81 — 3º passo da ordem de escrita: emite memory.updated no WS.
      this.events.updated(input.path, headCommit, `ai:${input.sessionId}`);
      return { oid, branch, headCommit, projection, retries: attempt };
    }

    // Inalcançável (o laço retorna ou lança), mas satisfaz o compilador.
    throw new MemoryStaleWriteError(input.path, base, base, 'stale');
  }

  // ---------------------------------------------------------------------------
  // Helpers internos.
  // ---------------------------------------------------------------------------

  /**
   * HEAD "efetivo" do path: o `headCommit` projetado no índice quando o neurônio
   * existe, senão o HEAD de `main`. Serve de âncora do compare-and-swap sem
   * precisar diffar a árvore inteira a cada tentativa.
   */
  private async currentPathHead(path: string): Promise<string> {
    const row = await this.prisma.memoryIndex.findUnique({ where: { path } });
    if (row?.headCommit) {
      return row.headCommit;
    }
    return this.gitStore.resolveHead(MEMORY_DEFAULT_BRANCH);
  }
}

/**
 * Escrita rejeitada pelo compare-and-swap. `reason`:
 * - `stale`: o HEAD avançou além do baseCommit e o retry esgotou (409 anti-stale).
 * - `conflict`: o merge 3-way conflitou de fato → requer REVIEW/árbitro (EP-80).
 */
export class MemoryStaleWriteError extends Error {
  constructor(
    public readonly path: string,
    public readonly baseCommit: string,
    public readonly currentHead: string,
    public readonly reason: 'stale' | 'conflict',
  ) {
    super(
      reason === 'stale'
        ? `Escrita stale em "${path}": base ${baseCommit} != HEAD ${currentHead} (409).`
        : `Conflito ao integrar "${path}" em main; requer REVIEW (EP-80).`,
    );
    this.name = 'MemoryStaleWriteError';
  }
}
