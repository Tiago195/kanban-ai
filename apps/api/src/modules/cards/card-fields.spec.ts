import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardsService } from './cards.service';

function makeService() {
  const created: any[] = [];
  const db = new Map<string, any>();
  const prisma: any = {
    column: { findUnique: async () => ({ title: 'Backlog' }) },
    card: {
      findUnique: async ({ where: { id } }: any) => db.get(id) ?? null,
      update: async ({ where: { id }, data }: any) => {
        const cur = db.get(id);
        const next = { ...cur, ...data };
        db.set(id, next);
        return next;
      },
      findFirst: async () => null,
      findMany: async () => [],
    },
    loopProfile: { findUnique: async () => null, findMany: async () => [] },
    dodItem: { findMany: async () => [], count: async () => 0 },
    comment: { findMany: async () => [] },
    iteration: { findMany: async () => [] },
    assignee: { findUnique: async () => null },
    board: { findUnique: async () => ({ id: 'b1', seq: 0 }) },
    getSchemaHealth: () => ({ ok: true }),
    $transaction: async (fn: any) =>
      fn({
        board: {
          findUnique: async () => ({ id: 'b1', seq: created.length }),
          update: async () => undefined,
        },
        column: { findFirst: async () => ({ id: 'col-1' }) },
        card: {
          count: async () => 0,
          create: async ({ data }: any) => {
            const row = {
              id: `c-${created.length + 1}`,
              startInPlanMode: false,
              iterations: [],
              parentId: null,
              boardId: 'b1',
              model: null,
              ...data,
            };
            created.push(row);
            db.set(row.id, row);
            return row;
          },
        },
      }),
  };
  const realtime: any = { broadcast: () => undefined };
  const orchestrator: any = { enqueueWakeup: async () => undefined, onStoryEnterInProgress: async () => undefined };
  const models: any = { defaultModelId: () => 'default-model' };
  return { service: new CardsService(prisma, realtime, orchestrator, models), created, db };
}

test('priority persists on create', async () => {
  const { service } = makeService();
  const card = await service.create({ boardId: 'b1', type: 'story', title: 'S1', priority: 7 } as any);
  assert.equal(card.priority, 7);
});

test('startInPlanMode defaults false and is updatable', async () => {
  const { service, db } = makeService();
  const card = await service.create({ boardId: 'b1', type: 'story', title: 'S1' } as any);
  assert.equal(card.startInPlanMode, false);

  await service.update(card.id, { startInPlanMode: true } as any);
  assert.equal(db.get(card.id).startInPlanMode, true);
});
