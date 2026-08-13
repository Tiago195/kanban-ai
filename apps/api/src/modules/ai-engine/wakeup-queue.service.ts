import { Injectable } from '@nestjs/common';
import type { WakeupReason } from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';

/**
 * US-COLAB3 — fila de wakeups durável, idempotente e com coalescing.
 *
 * O PROCESSAMENTO segue in-process (Orchestrator + AgentSessionManager); esta
 * camada só garante que a INTENÇÃO de acordar uma story seja:
 *  - durável (sobrevive a restart — fonte de verdade explícita além do board);
 *  - idempotente / coalescida (no máximo UM item não-terminal por story).
 *
 * SEM Redis/BullMQ (invariante 7 / ADR-0019 / ADR-0032): o estado da fila é uma
 * tabela Postgres; o executor continua sendo o `setInterval`/AgentSessionManager.
 *
 * US-SCHED1 — deferred monitors: items com `scheduledFor` são time-gated e só
 * devem ser claimed/fired quando `now >= scheduledFor`. Items com `scheduledFor
 * = null` são immediate (comportamento original).
 */
@Injectable()
export class WakeupQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enfileira (ou coalesce) um wakeup. Idempotente: se já existe um wakeup
   * NÃO-terminal (`pending`|`claimed`) para a story, faz MERGE (incrementa
   * `attempts`, atualiza `reason`/`epicId`) em vez de criar linha nova.
   *
   * Usa uma transação `findFirst` + `create`/`update` porque o índice único é
   * PARCIAL (Prisma v6 não expressa índice parcial no schema, então não dá para
   * usar `upsert`). O índice único parcial na migration é a rede de segurança
   * contra corrida: uma inserção concorrente que escapar do `findFirst` falha na
   * constraint e é reconvertida em merge.
   */
  async enqueue(input: {
    storyId: string;
    reason: WakeupReason;
    epicId?: string | null;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const active = await tx.wakeupQueue.findFirst({
        where: { storyId: input.storyId, status: { in: ['pending', 'claimed'] } },
        select: { id: true },
      });
      if (active) {
        await tx.wakeupQueue.update({
          where: { id: active.id },
          data: {
            attempts: { increment: 1 },
            reason: input.reason,
            ...(input.epicId != null ? { epicId: input.epicId } : {}),
          },
        });
        return;
      }
      try {
        await tx.wakeupQueue.create({
          data: {
            storyId: input.storyId,
            reason: input.reason,
            epicId: input.epicId ?? null,
          },
        });
      } catch (err: unknown) {
        // Corrida: outra transação criou o item ativo entre o findFirst e o
        // create; o índice único parcial rejeitou (P2002). Faz merge.
        if (isUniqueViolation(err)) {
          await tx.wakeupQueue.updateMany({
            where: { storyId: input.storyId, status: { in: ['pending', 'claimed'] } },
            data: { attempts: { increment: 1 }, reason: input.reason },
          });
          return;
        }
        throw err;
      }
    });
  }

  /**
   * US-SCHED1 — enfileira um deferred monitor (time-gated). Como `enqueue`, mas
   * com `scheduledFor` e metadata opcional. Idempotente/coalescing (máx 1 item
   * não-terminal por story). Se já existe um ativo, incrementa attempts e
   * atualiza scheduledFor + metadata.
   */
  async enqueueDeferred(input: {
    storyId: string;
    scheduledFor: Date;
    epicId?: string | null;
    notes?: string;
    timeoutAt?: Date;
    maxAttempts?: number;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const active = await tx.wakeupQueue.findFirst({
        where: { storyId: input.storyId, status: { in: ['pending', 'claimed'] } },
        select: { id: true },
      });
      if (active) {
        await tx.wakeupQueue.update({
          where: { id: active.id },
          data: {
            attempts: { increment: 1 },
            reason: 'monitor_due',
            scheduledFor: input.scheduledFor,
            ...(input.epicId != null ? { epicId: input.epicId } : {}),
            ...(input.notes != null ? { notes: input.notes } : {}),
            ...(input.timeoutAt != null ? { timeoutAt: input.timeoutAt } : {}),
            ...(input.maxAttempts != null ? { maxAttempts: input.maxAttempts } : {}),
          },
        });
        return;
      }
      try {
        await tx.wakeupQueue.create({
          data: {
            storyId: input.storyId,
            reason: 'monitor_due',
            scheduledFor: input.scheduledFor,
            epicId: input.epicId ?? null,
            notes: input.notes ?? null,
            timeoutAt: input.timeoutAt ?? null,
            maxAttempts: input.maxAttempts ?? null,
          },
        });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          await tx.wakeupQueue.updateMany({
            where: { storyId: input.storyId, status: { in: ['pending', 'claimed'] } },
            data: {
              attempts: { increment: 1 },
              reason: 'monitor_due',
              scheduledFor: input.scheduledFor,
            },
          });
          return;
        }
        throw err;
      }
    });
  }

  /** Marca o wakeup `pending` da story como reivindicado pelo processador. */
  async claim(storyId: string): Promise<void> {
    await this.prisma.wakeupQueue.updateMany({
      where: { storyId, status: 'pending' },
      data: { status: 'claimed', claimedAt: new Date() },
    });
  }

  /** Fecha o wakeup não-terminal da story (sucesso). */
  async complete(storyId: string): Promise<void> {
    await this.prisma.wakeupQueue.updateMany({
      where: { storyId, status: { in: ['pending', 'claimed'] } },
      data: { status: 'done', processedAt: new Date() },
    });
  }

  /** Marca como falho (mantido para auditoria); não some da fila silenciosamente. */
  async fail(storyId: string): Promise<void> {
    await this.prisma.wakeupQueue.updateMany({
      where: { storyId, status: { in: ['pending', 'claimed'] } },
      data: { status: 'failed', processedAt: new Date() },
    });
  }

  /**
   * Reabre no boot os wakeups `claimed` órfãos (a sessão in-process morreu com a
   * API). Devolve-os para `pending` e retorna a lista para reprocessamento.
   */
  async recoverOnBoot(): Promise<{ storyId: string; reason: WakeupReason }[]> {
    const orphans = await this.prisma.wakeupQueue.findMany({
      where: { status: 'claimed' },
      select: { storyId: true, reason: true },
    });
    if (orphans.length > 0) {
      await this.prisma.wakeupQueue.updateMany({
        where: { status: 'claimed' },
        data: { status: 'pending', claimedAt: null },
      });
    }
    return orphans as { storyId: string; reason: WakeupReason }[];
  }

  /** Lista os wakeups pendentes (drenagem in-process pelo Orchestrator). */
  async listPending(): Promise<
    { storyId: string; reason: WakeupReason; epicId: string | null }[]
  > {
    const rows = await this.prisma.wakeupQueue.findMany({
      where: { status: 'pending' },
      select: { storyId: true, reason: true, epicId: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows as { storyId: string; reason: WakeupReason; epicId: string | null }[];
  }

  /**
   * US-SCHED1 — lista wakeups cujo scheduledFor já passou (ou é null = immediate).
   * Time-gated: só retorna items prontos para serem processados agora.
   */
  async listDue(now = new Date()): Promise<
    { storyId: string; reason: WakeupReason; epicId: string | null }[]
  > {
    const rows = await this.prisma.wakeupQueue.findMany({
      where: {
        status: 'pending',
        OR: [
          { scheduledFor: null }, // immediate (existing behavior)
          { scheduledFor: { lte: now } }, // deferred monitor that is now due
        ],
      },
      select: { storyId: true, reason: true, epicId: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows as { storyId: string; reason: WakeupReason; epicId: string | null }[];
  }

  /**
   * US-SCHED1 — remove/limpa o monitor pendente de uma story (one-shot clear).
   * Auto-clear ao atingir terminal state, ou clear explícito via endpoint.
   */
  async clearMonitor(storyId: string): Promise<void> {
    await this.prisma.wakeupQueue.updateMany({
      where: { storyId, status: { in: ['pending', 'claimed'] }, reason: 'monitor_due' },
      data: { status: 'done', processedAt: new Date() },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
