import { Body, Controller, Get, Post, Query, UsePipes } from '@nestjs/common';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { PrismaService } from '../../shared/db/prisma.service';
import { MemoryGitService } from './memory-git.service';
import { MemoryLockService } from './memory-lock.service';
import { MemoryPolicyService } from './memory-policy.service';
import { MemoryReviewService } from './memory-review.service';
import { MemoryWriteService } from './memory-write.service';
import {
  memoryAcquireSchema,
  memoryHeartbeatSchema,
  memoryReadQuerySchema,
  memoryReleaseSchema,
  memoryResolveSchema,
  memoryWriteSchema,
  type MemoryAcquireDto,
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
export class MemoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly git: MemoryGitService,
    private readonly write: MemoryWriteService,
    private readonly lock: MemoryLockService,
    private readonly review: MemoryReviewService,
    private readonly policy: MemoryPolicyService,
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
   * Escrita otimista (US-207) — delega ao compare-and-swap da EP-79. Quando
   * `module` é informado (EP-83/US-211), aplica o enforcement de escopo (US-212):
   * fora do escopo do agent a escrita NÃO aplica direto — vira proposta em
   * REVIEW (ponte EP-80) e a resposta é o `MemoryReviewItem`.
   */
  @Post('write')
  @UsePipes(new ZodValidationPipe(memoryWriteSchema))
  write_(@Body() dto: MemoryWriteDto) {
    if (dto.module) {
      const scopePrefix = this.policy.scopeFor(dto.module);
      const scope = this.policy.classifyWrite({ scopePrefix, path: dto.path });
      if (scope === 'out-of-scope') {
        const holder = this.policy.agentIdFor({ sessionId: dto.sessionId });
        return this.review.enterReview({
          path: dto.path,
          reason: 'out-of-scope',
          sessionId: dto.sessionId,
          holder,
          baseCommit: dto.baseCommit,
        });
      }
    }
    return this.write.commit(dto);
  }

  /** Aquisição de lease advisory (US-208) — retorna `baseCommit`. */
  @Post('acquire')
  @UsePipes(new ZodValidationPipe(memoryAcquireSchema))
  acquire(@Body() dto: MemoryAcquireDto) {
    return this.lock.acquire(dto.path, dto.holder, dto.ttlMs);
  }

  /** Renovação de TTL do lease (US-208). */
  @Post('heartbeat')
  @UsePipes(new ZodValidationPipe(memoryHeartbeatSchema))
  async heartbeat(@Body() dto: MemoryHeartbeatDto) {
    const expiresAt = await this.lock.heartbeat(dto.path, dto.holder, dto.ttlMs);
    return { path: dto.path, holder: dto.holder, expiresAt };
  }

  /** Liberação do lease (US-208) — dispara o merge do ramo efêmero. */
  @Post('release')
  @UsePipes(new ZodValidationPipe(memoryReleaseSchema))
  async release(@Body() dto: MemoryReleaseDto) {
    await this.lock.release(dto.path, dto.holder);
    return { path: dto.path, released: true };
  }

  /** Arbitragem de um REVIEW (US-209) — ponte fina para a EP-80. */
  @Post('resolve')
  @UsePipes(new ZodValidationPipe(memoryResolveSchema))
  resolve(@Body() dto: MemoryResolveDto) {
    return this.review.resolve(dto);
  }
}
