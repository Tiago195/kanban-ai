import { Injectable, Logger } from '@nestjs/common';
import { MemoryLockState } from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';
import { MEMORY_DEFAULT_BRANCH, MemoryGitService } from './memory-git.service';

/** TTL default do lease advisory (ms) — renovado por heartbeat (US-193). */
export const MEMORY_LEASE_TTL_MS = 60_000;

/** Resultado de `acquire` (espelha AcquireLockResponse do shared). */
export interface AcquireResult {
  baseCommit: string;
  leaseId: string;
  expiresAt: number;
}

/**
 * Serviço de **locks advisory + presença** da memória (ADR-0027, **EP-78**).
 *
 * O lock é **advisory** (coordenação social — "estou editando isto agora"),
 * NÃO um portão de escrita: o que protege contra _lost-update_ é o
 * compare-and-swap do write (EP-79). Aqui vive só o LEASE:
 * - `acquire` (US-192): FREE → EDITING, devolve `baseCommit` (HEAD do path) +
 *   `leaseId` + `expiresAt`.
 * - `heartbeat` (US-193): empurra `expiresAt` enquanto a sessão está viva.
 * - `release` (US-194): EDITING → FREE explicitamente.
 * - expiração por TTL (US-193): lease vencido é auto-liberado (sessão morta).
 *
 * O estado do lease é projetado no índice (`MemoryIndex`), que é descartável;
 * a fonte da verdade do CONTEÚDO continua sendo o git (Camada 1).
 */
@Injectable()
export class MemoryLockService {
  private readonly logger = new Logger(MemoryLockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gitStore: MemoryGitService,
  ) {}

  /**
   * US-192 — Adquire o lease advisory de um neurônio (FREE → EDITING). Idempotente
   * para o MESMO holder (re-acquire renova o lease e devolve o mesmo baseCommit).
   * Se um OUTRO holder tem lease ativo (não expirado), lança `MemoryLockHeldError`.
   * Um lease expirado é considerado livre e sobrescrito (auto-release lazy).
   */
  async acquire(path: string, holder: string, ttlMs = MEMORY_LEASE_TTL_MS): Promise<AcquireResult> {
    const now = Date.now();
    const current = await this.prisma.memoryIndex.findUnique({ where: { path } });
    const heldByOther =
      current &&
      current.lockState === MemoryLockState.EDITING &&
      current.holder &&
      current.holder !== holder &&
      current.expiresAt &&
      current.expiresAt.getTime() > now;
    if (heldByOther) {
      throw new MemoryLockHeldError(path, current!.holder!);
    }

    const baseCommit =
      current?.headCommit ?? (await this.gitStore.resolveHead(MEMORY_DEFAULT_BRANCH));
    const reacquire = current?.holder === holder && current?.leaseId;
    const leaseId = reacquire ? current!.leaseId! : this.newLeaseId(holder);
    const expiresAt = new Date(now + ttlMs);

    await this.prisma.memoryIndex.upsert({
      where: { path },
      create: {
        path,
        headCommit: baseCommit,
        lockState: MemoryLockState.EDITING,
        holder,
        leaseId,
        expiresAt,
        baseCommit,
      },
      update: {
        lockState: MemoryLockState.EDITING,
        holder,
        leaseId,
        expiresAt,
        baseCommit,
      },
    });
    return { baseCommit, leaseId, expiresAt: expiresAt.getTime() };
  }

  /**
   * US-193 — Renova o lease por heartbeat: empurra `expiresAt = now + ttl`.
   * Só o holder corrente pode renovar. Se o lease já venceu (auto-release), a
   * renovação é rejeitada com `MemoryLeaseExpiredError` (a sessão deve re-adquirir).
   */
  async heartbeat(path: string, holder: string, ttlMs = MEMORY_LEASE_TTL_MS): Promise<number> {
    const now = Date.now();
    const current = await this.prisma.memoryIndex.findUnique({ where: { path } });
    if (
      !current ||
      current.lockState !== MemoryLockState.EDITING ||
      current.holder !== holder
    ) {
      throw new MemoryNotHolderError(path, holder);
    }
    if (!current.expiresAt || current.expiresAt.getTime() <= now) {
      // Lease vencido: libera (sessão considerada morta) e recusa o heartbeat.
      await this.autoRelease(path);
      throw new MemoryLeaseExpiredError(path);
    }
    const expiresAt = new Date(now + ttlMs);
    await this.prisma.memoryIndex.update({ where: { path }, data: { expiresAt } });
    return expiresAt.getTime();
  }

  /**
   * US-194 — Release explícito (EDITING → FREE). Só o holder corrente solta.
   * Limpa os campos de lease mantendo a projeção (title/tags/…) intacta.
   */
  async release(path: string, holder: string): Promise<void> {
    const current = await this.prisma.memoryIndex.findUnique({ where: { path } });
    if (!current || current.lockState !== MemoryLockState.EDITING) {
      return; // já livre — release é idempotente
    }
    if (current.holder !== holder) {
      throw new MemoryNotHolderError(path, holder);
    }
    await this.toFree(path);
  }

  /**
   * US-193 — Varredura de expiração: libera TODOS os leases vencidos (auto-release
   * das sessões mortas). Retorna quantos foram liberados. Pensado para ser
   * chamado por um tick periódico (o agendamento vive fora — EP-85/infra).
   */
  async expireStale(nowMs = Date.now()): Promise<number> {
    const stale = await this.prisma.memoryIndex.findMany({
      where: { lockState: MemoryLockState.EDITING, expiresAt: { lte: new Date(nowMs) } },
      select: { path: true },
    });
    for (const row of stale) {
      await this.autoRelease(row.path);
    }
    if (stale.length) {
      this.logger.log(`Leases expirados auto-liberados: ${stale.length}.`);
    }
    return stale.length;
  }

  /**
   * US-195 — Salvaguarda anti-deadlock: adquire uma LISTA de neurônios de forma
   * atômica-no-espírito. Ordena os paths (ordem de aquisição canônica → evita
   * hold-and-wait circular entre dois holders) e, se QUALQUER um estiver preso
   * por outro holder, desfaz os já adquiridos e lança — nunca fica com aquisição
   * parcial que possa travar outra sessão.
   */
  async acquireMany(
    paths: string[],
    holder: string,
    ttlMs = MEMORY_LEASE_TTL_MS,
  ): Promise<Map<string, AcquireResult>> {
    const ordered = [...new Set(paths)].sort();
    const acquired = new Map<string, AcquireResult>();
    try {
      for (const p of ordered) {
        acquired.set(p, await this.acquire(p, holder, ttlMs));
      }
      return acquired;
    } catch (err) {
      // Rollback: solta tudo que já pegou (não deixa deadlock parcial).
      for (const p of acquired.keys()) {
        await this.release(p, holder).catch(() => undefined);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers internos.
  // ---------------------------------------------------------------------------

  private async autoRelease(path: string): Promise<void> {
    await this.toFree(path);
  }

  private async toFree(path: string): Promise<void> {
    await this.prisma.memoryIndex.update({
      where: { path },
      data: {
        lockState: MemoryLockState.FREE,
        holder: null,
        leaseId: null,
        expiresAt: null,
        baseCommit: null,
        activeBranch: null,
      },
    });
  }

  private newLeaseId(holder: string): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `lease_${holder}_${Date.now().toString(36)}_${rand}`;
  }
}

/** Lease preso por OUTRO holder ativo (não expirado) — US-192. */
export class MemoryLockHeldError extends Error {
  constructor(
    public readonly path: string,
    public readonly holder: string,
  ) {
    super(`Neurônio "${path}" já está travado por "${holder}".`);
    this.name = 'MemoryLockHeldError';
  }
}

/** Operação de lease por quem NÃO é o holder corrente — US-193/US-194. */
export class MemoryNotHolderError extends Error {
  constructor(
    public readonly path: string,
    public readonly agentId: string,
  ) {
    super(`Agent "${agentId}" não é o holder do lease de "${path}".`);
    this.name = 'MemoryNotHolderError';
  }
}

/** Heartbeat após o lease vencer (auto-release já ocorreu) — US-193. */
export class MemoryLeaseExpiredError extends Error {
  constructor(public readonly path: string) {
    super(`Lease de "${path}" já expirou; readquira o lock.`);
    this.name = 'MemoryLeaseExpiredError';
  }
}
