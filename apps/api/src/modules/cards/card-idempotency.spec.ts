import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardsService } from './cards.service';

function deps() {
  const created: any[] = [];
  const prisma: any = {
    column: { findUnique: async () => ({ title: 'Backlog' }) },
    card: {
      findFirst: async ({ where }: any) =>
        created.find((c) => c.boardId === where.boardId && c.idempotencyKey === where.idempotencyKey) ??
        null,
      findUnique: async ({ where: { id } }: any) => created.find((c)=>c.id===id) ?? null,
      findMany: async () => [],
      update: async ({ where: { id }, data }: any) => { const i=created.findIndex((c)=>c.id===id); if(i>=0) created[i]={...created[i],...data}; return created[i]; },
    },
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
            const row = { id: `c-${created.length + 1}`, ...data };
            created.push(row);
            return row;
          },
        },
      }),
    getSchemaHealth: () => ({ ok: true }),
  };

  const realtime: any = { broadcast: () => undefined };
  const orchestrator: any = { enqueueWakeup: async () => undefined, onStoryEnterInProgress: async () => undefined };
  const models: any = {};
  return { service: new CardsService(prisma, realtime, orchestrator, models), created };
}

test('create with same idempotencyKey returns existing card (no-op)', async () => {
  const { service, created } = deps();

  const dto: any = {
    boardId: 'b1',
    type: 'story',
    title: 'S1',
    idempotencyKey: 'idem-1',
  };

  const first = await service.create(dto);
  const second = await service.create(dto);

  assert.equal(first.id, second.id);
  assert.equal(created.length, 1);
});

test('create without idempotencyKey creates normally', async () => {
  const { service, created } = deps();

  await service.create({ boardId: 'b1', type: 'story', title: 'A' } as any);
  await service.create({ boardId: 'b1', type: 'story', title: 'B' } as any);

  assert.equal(created.length, 2);
});
