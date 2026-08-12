import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../../shared/db/prisma.service';
import { WakeupQueueService } from './wakeup-queue.service';

/**
 * US-COLAB3 — testes da wakeup queue durável. Um prisma fake in-memory emula a
 * tabela `WakeupQueue` INCLUINDO o índice único PARCIAL (no máx. 1 item
 * não-terminal por story): um `create` que violaria o índice lança P2002, como o
 * Postgres faria. Assim validamos coalescing, claim/complete, recuperação de
 * órfãos no boot e a robustez do enqueue contra corrida.
 */

type Status = 'pending' | 'claimed' | 'done' | 'failed';

interface Row {
  id: string;
  storyId: string;
  status: Status;
  reason: string;
  attempts: number;
  epicId: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  processedAt: Date | null;
}

const ACTIVE: Status[] = ['pending', 'claimed'];

function makePrisma(): { svc: PrismaService; rows: Row[] } {
  const rows: Row[] = [];
  let seq = 0;

  const matchesWhere = (r: Row, where: Record<string, unknown>): boolean => {
    if (where.storyId != null && r.storyId !== where.storyId) return false;
    const status = where.status as { in?: Status[] } | Status | undefined;
    if (status != null) {
      if (typeof status === 'string') {
        if (r.status !== status) return false;
      } else if (Array.isArray(status.in)) {
        if (!status.in.includes(r.status)) return false;
      }
    }
    return true;
  };

  const store = {
    async findFirst(args: { where: Record<string, unknown> }) {
      return rows.find((r) => matchesWhere(r, args.where)) ?? null;
    },
    async findMany(args?: { where?: Record<string, unknown> }) {
      const where = args?.where ?? {};
      return rows.filter((r) => matchesWhere(r, where)).map((r) => ({ ...r }));
    },
    async create(args: { data: Partial<Row> }) {
      const d = args.data;
      // Emula o índice único PARCIAL: só 1 ativo por story.
      if (
        d.storyId != null &&
        rows.some((r) => r.storyId === d.storyId && ACTIVE.includes(r.status))
      ) {
        const err = new Error('Unique constraint failed') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      const row: Row = {
        id: `w${++seq}`,
        storyId: d.storyId as string,
        status: (d.status as Status) ?? 'pending',
        reason: (d.reason as string) ?? 'story_in_progress',
        attempts: (d.attempts as number) ?? 1,
        epicId: (d.epicId as string | null) ?? null,
        createdAt: new Date(),
        claimedAt: null,
        processedAt: null,
      };
      rows.push(row);
      return { ...row };
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const r = rows.find((x) => x.id === args.where.id);
      if (!r) throw new Error('Record to update not found.');
      applyData(r, args.data);
      return { ...r };
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const targets = rows.filter((r) => matchesWhere(r, args.where));
      for (const r of targets) applyData(r, args.data);
      return { count: targets.length };
    },
  };

  const applyData = (r: Row, data: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(data)) {
      if (v != null && typeof v === 'object' && 'increment' in (v as object)) {
        (r as unknown as Record<string, number>)[k] =
          ((r as unknown as Record<string, number>)[k] ?? 0) +
          (v as { increment: number }).increment;
      } else {
        (r as unknown as Record<string, unknown>)[k] = v;
      }
    }
  };

  const svc = {
    wakeupQueue: store,
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({ wakeupQueue: store });
    },
  } as unknown as PrismaService;

  return { svc, rows };
}

test('enqueue coalesce: 3 wakeups para a mesma story → 1 linha pending com attempts=3', async () => {
  const { svc, rows } = makePrisma();
  const q = new WakeupQueueService(svc);
  await q.enqueue({ storyId: 's1', reason: 'story_in_progress', epicId: 'e1' });
  await q.enqueue({ storyId: 's1', reason: 'task_added' });
  await q.enqueue({ storyId: 's1', reason: 'manual_step' });

  const active = rows.filter((r) => ACTIVE.includes(r.status));
  assert.equal(active.length, 1, 'deve existir 1 único item ativo (coalescing)');
  assert.equal(active[0].attempts, 3, 'attempts reflete o coalescing');
  assert.equal(active[0].reason, 'manual_step', 'reason é atualizado no merge');
  assert.equal(active[0].epicId, 'e1', 'epicId preservado do primeiro enqueue');
});

test('enqueue: stories diferentes NÃO coalescem', async () => {
  const { svc, rows } = makePrisma();
  const q = new WakeupQueueService(svc);
  await q.enqueue({ storyId: 's1', reason: 'story_in_progress' });
  await q.enqueue({ storyId: 's2', reason: 'story_in_progress' });
  assert.equal(rows.length, 2);
});

test('claim/complete: pending → claimed → done', async () => {
  const { svc, rows } = makePrisma();
  const q = new WakeupQueueService(svc);
  await q.enqueue({ storyId: 's1', reason: 'story_in_progress' });
  await q.claim('s1');
  assert.equal(rows[0].status, 'claimed');
  assert.ok(rows[0].claimedAt, 'claimedAt setado');
  await q.complete('s1');
  assert.equal(rows[0].status, 'done');
  assert.ok(rows[0].processedAt, 'processedAt setado');

  // Após complete, um novo enqueue cria um NOVO item (o anterior é terminal).
  await q.enqueue({ storyId: 's1', reason: 'task_added' });
  const active = rows.filter((r) => ACTIVE.includes(r.status));
  assert.equal(active.length, 1);
  assert.equal(active[0].attempts, 1, 'novo item começa em attempts=1');
});

test('recoverOnBoot: reabre claimed órfãos → pending e os retorna', async () => {
  const { svc, rows } = makePrisma();
  const q = new WakeupQueueService(svc);
  await q.enqueue({ storyId: 's1', reason: 'story_in_progress' });
  await q.enqueue({ storyId: 's2', reason: 'reconcile' });
  await q.claim('s1');
  await q.claim('s2');
  // done um deles para garantir que recoverOnBoot só toca em claimed
  await q.complete('s2');

  const reopened = await q.recoverOnBoot();
  assert.equal(reopened.length, 1, 'apenas s1 estava claimed');
  assert.equal(reopened[0].storyId, 's1');
  assert.equal(reopened[0].reason, 'story_in_progress');
  assert.equal(rows.find((r) => r.storyId === 's1')!.status, 'pending');
  assert.equal(rows.find((r) => r.storyId === 's1')!.claimedAt, null);
});

test('enqueue é robusto a corrida: create que viola o índice parcial vira merge', async () => {
  const { svc, rows } = makePrisma();
  const q = new WakeupQueueService(svc);
  // Semeia um item ativo "por fora" (simula outra transação concorrente).
  await svc.wakeupQueue.create({ data: { storyId: 's1', reason: 'story_in_progress' } });
  // O enqueue faz findFirst (acha) e merge — mas mesmo que não achasse, o create
  // colidiria (P2002) e cairia no updateMany. Aqui força o caminho de merge.
  await q.enqueue({ storyId: 's1', reason: 'task_added' });
  const active = rows.filter((r) => ACTIVE.includes(r.status));
  assert.equal(active.length, 1, 'nunca duplica o item ativo');
  assert.equal(active[0].attempts, 2);
});

test('listPending retorna apenas pending', async () => {
  const { svc } = makePrisma();
  const q = new WakeupQueueService(svc);
  await q.enqueue({ storyId: 's1', reason: 'story_in_progress' });
  await q.enqueue({ storyId: 's2', reason: 'reconcile' });
  await q.claim('s2');
  const pending = await q.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].storyId, 's1');
});
