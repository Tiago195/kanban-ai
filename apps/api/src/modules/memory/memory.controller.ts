import { Body, Controller, Get, Post, Query, Req, UseGuards, UsePipes } from '@nestjs/common';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { PrismaService } from '../../shared/db/prisma.service';
import { MemoryAuthGuard, MEMORY_AGENT_KEY } from './memory-auth.guard';
import type { RequestWithMemoryAgent } from './memory-auth.guard';
import type { MemoryAgentIdentity } from './memory-auth.tokens';
import { MemoryGitService } from './memory-git.service';
import { MemoryBootstrapService } from './memory-bootstrap.service';
import { MemoryGcService } from './memory-gc.service';
import { MemoryLockService } from './memory-lock.service';
import { MemoryPolicyService } from './memory-policy.service';
import { MemoryReviewService } from './memory-review.service';
import { MemoryWriteService } from './memory-write.service';
import {
  memoryAcquireSchema,
  memoryBootstrapSchema,
  memoryEnsureNeuronSchema,
  memoryGcSummarizeSchema,
  memoryGcSweepStaleSchema,
  memoryHeartbeatSchema,
  memoryReadQuerySchema,
  memoryReleaseSchema,
  memoryResolveSchema,
  memoryWriteSchema,
  type MemoryAcquireDto,
  type MemoryBootstrapDto,
  type MemoryEnsureNeuronDto,
  type MemoryGcSummarizeDto,
  type MemoryGcSweepStaleDto,
  type MemoryHeartbeatDto,
  type MemoryReadQueryDto,
  type MemoryReleaseDto,
  type MemoryResolveDto,
  type MemoryWriteDto,
} from './memory.schema';

/**
 * Controller HTTP da **memória** (EP-82 — segundo plano de controle via MCP,
 * ADR-0020). Traduz o control plane REST nos serviços de domínio: leitura
 * global do HEAD, escrita otimista (CAS), lease advisory (acquire/heartbeat/
 * release) e arbitragem de REVIEW. Nenhuma regra vive aqui — apenas a borda.
 */
@Controller('memory')
@UseGuards(MemoryAuthGuard)
export class MemoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly git: MemoryGitService,
    private readonly write: MemoryWriteService,
    private readonly lock: MemoryLockService,
    private readonly review: MemoryReviewService,
    private readonly policy: MemoryPolicyService,
    private readonly bootstrap: MemoryBootstrapService,
    private readonly gc: MemoryGcService,
  ) {}

  /**
   * Leitura GLOBAL do HEAD de um neurônio (US-207). Retorna o conteúdo do `main`
   * e o `headCommit` que um `write` subsequente deve repassar como `baseCommit`
   * (mesma âncora do CAS): projeção do índice quando presente, senão o HEAD git.
   */
  @Get('read')
  async read(
    @Query(new ZodValidationPipe(memoryReadQuerySchema)) query: MemoryReadQueryDto,
  ): Promise<{ path: string; content: string | null; headCommit: string }> {
    const [content, row] = await Promise.all([
      this.git.readNeuron(query.path),
      this.prisma.memoryIndex.findUnique({ where: { path: query.path } }),
    ]);
    const headCommit = row?.headCommit || (await this.git.resolveHead());
    return { path: query.path, content, headCommit };
  }

  /**
   * Escrita otimista (US-207) — delega ao compare-and-swap da EP-79.
   *
   * **Identidade/escopo do TOKEN (EP-C/US-C2):** quando a requisição está
   * autenticada (`MEMORY_API_TOKENS` ligado), o autor do ramo efêmero
   * (`sessionId`) e o `module` do enforcement de escopo vêm do TOKEN, NÃO do
   * body — fechando o buraco de "escrever como qualquer sessão". Um token com
   * escopo GLOBAL (`*`) escreve direto (sem `module`). Sem auth (dev local),
   * mantém o comportamento anterior baseado no body.
   *
   * Quando o `module` efetivo está presente (EP-83/US-211) e a escrita cai fora
   * do escopo (US-212), NÃO commita direto — vira proposta em REVIEW (ponte
   * EP-80) e a resposta é o `MemoryReviewItem`.
   */
  @Post('write')
  @UsePipes(new ZodValidationPipe(memoryWriteSchema))
  write_(@Body() dto: MemoryWriteDto, @Req() req: RequestWithMemoryAgent) {
    const identity = req[MEMORY_AGENT_KEY];
    // Identidade autenticada tem precedência: autor e escopo vêm do token.
    const sessionId = identity ? sessionOf(identity) : dto.sessionId;
    const module = identity ? identity.scope : dto.module;
    const effective: MemoryWriteDto = { ...dto, sessionId, module };

    if (module) {
      const scopePrefix = this.policy.scopeFor(module);
      const scope = this.policy.classifyWrite({ scopePrefix, path: effective.path });
      if (scope === 'out-of-scope') {
        const holder = identity?.agentId ?? this.policy.agentIdFor({ sessionId });
        return this.review.enterReview({
          path: effective.path,
          reason: 'out-of-scope',
          sessionId,
          holder,
          baseCommit: effective.baseCommit,
        });
      }
    }
    return this.write.commit(effective);
  }

  /** Aquisição de lease advisory (US-208) — retorna `baseCommit`. */
  @Post('acquire')
  @UsePipes(new ZodValidationPipe(memoryAcquireSchema))
  acquire(@Body() dto: MemoryAcquireDto, @Req() req: RequestWithMemoryAgent) {
    const holder = holderFrom(req, dto.holder);
    return this.lock.acquire(dto.path, holder, dto.ttlMs);
  }

  /** Renovação de TTL do lease (US-208). */
  @Post('heartbeat')
  @UsePipes(new ZodValidationPipe(memoryHeartbeatSchema))
  async heartbeat(@Body() dto: MemoryHeartbeatDto, @Req() req: RequestWithMemoryAgent) {
    const holder = holderFrom(req, dto.holder);
    const expiresAt = await this.lock.heartbeat(dto.path, holder, dto.ttlMs);
    return { path: dto.path, holder, expiresAt };
  }

  /** Liberação do lease (US-208) — dispara o merge do ramo efêmero. */
  @Post('release')
  @UsePipes(new ZodValidationPipe(memoryReleaseSchema))
  async release(@Body() dto: MemoryReleaseDto, @Req() req: RequestWithMemoryAgent) {
    const holder = holderFrom(req, dto.holder);
    await this.lock.release(dto.path, holder);
    return { path: dto.path, released: true };
  }

  /** Arbitragem de um REVIEW (US-209) — ponte fina para a EP-80. */
  @Post('resolve')
  @UsePipes(new ZodValidationPipe(memoryResolveSchema))
  resolve(@Body() dto: MemoryResolveDto, @Req() req: RequestWithMemoryAgent) {
    const identity = req[MEMORY_AGENT_KEY];
    // O árbitro autenticado (token) tem precedência sobre o body.
    const arbiter = identity?.agentId ?? dto.arbiter;
    return this.review.resolve({ ...dto, arbiter });
  }

  /**
   * Bootstrap da colmeia (US-213) — varre o repo-alvo e cria 1 neurônio inicial
   * por módulo. Idempotente: retorna os paths efetivamente criados nesta chamada.
   */
  @Post('bootstrap')
  @UsePipes(new ZodValidationPipe(memoryBootstrapSchema))
  async bootstrapRepo(@Body() dto: MemoryBootstrapDto) {
    const created = await this.bootstrap.bootstrapFromRepo(dto);
    return { created, count: created.length };
  }

  /**
   * Garantia lazy de neurônio (US-214) — dado um arquivo tocado, cria o neurônio
   * do seu módulo se ausente. Retorna o `neuronPath` garantido (ou `null`).
   */
  @Post('ensure-neuron')
  @UsePipes(new ZodValidationPipe(memoryEnsureNeuronSchema))
  async ensureNeuron(@Body() dto: MemoryEnsureNeuronDto) {
    const neuronPath = await this.bootstrap.ensureNeuronForFile(dto);
    return { neuronPath };
  }

  /**
   * GC — varredura de staleness (US-215). Arquiva neurônios de módulo que sumiram
   * do repo-alvo e reativa os que voltaram. Idempotente; nada é apagado do git.
   */
  @Post('gc/sweep-stale')
  @UsePipes(new ZodValidationPipe(memoryGcSweepStaleSchema))
  gcSweepStale(@Body() dto: MemoryGcSweepStaleDto) {
    return this.gc.sweepStale(dto);
  }

  /**
   * GC — sumarização de histórico longo (US-216). Retorna o bloco condensado
   * (ou `null` se o neurônio não tem histórico longo o bastante).
   */
  @Post('gc/summarize')
  @UsePipes(new ZodValidationPipe(memoryGcSummarizeSchema))
  async gcSummarize(@Body() dto: MemoryGcSummarizeDto) {
    const summary = await this.gc.summarizeHistory(dto.path, dto.keep);
    return { path: dto.path, summary };
  }

  /**
   * GC — poda de ramos efêmeros `mem/ai/*` órfãos (US-217). Idempotente. Retorna
   * os ramos podados nesta execução.
   */
  @Post('gc/prune-branches')
  async gcPruneBranches() {
    const pruned = await this.gc.pruneEphemeralBranches();
    return { pruned, count: pruned.length };
  }
}

/**
 * Deriva o `holder` de um lease: identidade autenticada (token) tem precedência
 * sobre o `holder` do body — o mesmo agent sempre coordena com a mesma
 * identidade estável, independentemente do que envie no corpo.
 */
function holderFrom(req: RequestWithMemoryAgent, bodyHolder: string): string {
  const identity = req[MEMORY_AGENT_KEY];
  return identity?.agentId ?? bodyHolder;
}

/**
 * Deriva um `sessionId` estável a partir da identidade do token: remove o
 * prefixo `ai:` do `agentId` (`ai:claude-1` → `claude-1`) para nomear o ramo
 * efêmero por autor. Mantém o `agentId` como âncora da identidade.
 */
function sessionOf(identity: MemoryAgentIdentity): string {
  return identity.agentId.replace(/^ai:/, '');
}
