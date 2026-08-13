import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReviewService } from './review.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { ServerEvent } from '@kanban-ai/shared';

/**
 * US-OBS3 (ADR-0037) — CRUD de comentários de review por linha.
 *
 * Cobre o DOD:
 *   - addComment persiste e EMITE `review.comment_added` pelo hub WS.
 *   - listByCard filtra pelo `cardId`.
 *   - resolve vira `resolved=true`.
 *
 * Observabilidade — NÃO reintroduz DOR/acceptance (ADR-0007).
 */

interface Row {
  id: string;
  cardId: string;
  iterationId: string | null;
  filePath: string;
  line: number;
  body: string;
  author: string;
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakes() {
  const store: Row[] = [];
  let seq = 0;
  const events: ServerEvent[] = [];

  const prisma = {
    reviewComment: {
      create: async ({ data }: { data: Omit<Row, 'id' | 'resolved' | 'createdAt' | 'updatedAt'> & { resolved?: boolean } }) => {
        const now = new Date();
        const row: Row = {
          id: `rc_${++seq}`,
          cardId: data.cardId,
          iterationId: data.iterationId ?? null,
          filePath: data.filePath,
          line: data.line,
          body: data.body,
          author: data.author,
          resolved: false,
          createdAt: now,
          updatedAt: now,
        };
        store.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { cardId: string } }) =>
        store.filter((r) => r.cardId === where.cardId),
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { resolved: boolean } }) => {
        const row = store.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        row.resolved = data.resolved;
        row.updatedAt = new Date();
        return row;
      },
    },
  } as unknown as PrismaService;

  const realtime = {
    broadcast: (event: ServerEvent) => {
      events.push(event);
    },
  } as unknown as RealtimeService;

  return { prisma, realtime, events };
}

test('addComment persiste e emite review.comment_added', async () => {
  const { prisma, realtime, events } = makeFakes();
  const service = new ReviewService(prisma, realtime);

  const comment = await service.addComment({
    cardId: 'card-1',
    filePath: 'src/a.ts',
    line: 10,
    body: 'nit: renomear',
    author: 'agent:copilot',
  });

  assert.equal(comment.cardId, 'card-1');
  assert.equal(comment.filePath, 'src/a.ts');
  assert.equal(comment.line, 10);
  assert.equal(comment.resolved, false);
  assert.equal(typeof comment.createdAt, 'string');

  assert.equal(events.length, 1);
  const evt = events[0];
  assert.equal(evt.type, 'review.comment_added');
  if (evt.type === 'review.comment_added') {
    assert.equal(evt.cardId, 'card-1');
    assert.equal(evt.comment.id, comment.id);
  }
});

test('listByCard filtra pelo cardId', async () => {
  const { prisma, realtime } = makeFakes();
  const service = new ReviewService(prisma, realtime);

  await service.addComment({ cardId: 'card-1', filePath: 'a.ts', line: 1, body: 'x', author: 'h' });
  await service.addComment({ cardId: 'card-2', filePath: 'b.ts', line: 2, body: 'y', author: 'h' });
  await service.addComment({ cardId: 'card-1', filePath: 'c.ts', line: 3, body: 'z', author: 'h' });

  const forCard1 = await service.listByCard('card-1');
  assert.equal(forCard1.length, 2);
  assert.ok(forCard1.every((c) => c.cardId === 'card-1'));
});

test('resolve vira resolved=true', async () => {
  const { prisma, realtime } = makeFakes();
  const service = new ReviewService(prisma, realtime);

  const created = await service.addComment({
    cardId: 'card-1',
    filePath: 'a.ts',
    line: 1,
    body: 'x',
    author: 'h',
  });
  assert.equal(created.resolved, false);

  const resolved = await service.resolve(created.id);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.id, created.id);
});
