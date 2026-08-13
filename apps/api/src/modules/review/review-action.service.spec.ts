import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReviewActionService } from './review-action.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { AppConfig } from '../../shared/config/config';
import type { ServerEvent } from '@kanban-ai/shared';

/**
 * US-OBS2-4 — testes do ReviewActionService (I/O) com fakes leves.
 *
 * Cobre o DOD:
 *   - record cria e EMITE `review.action_flagged` na primeira vez;
 *   - record é suprimido dentro do cooldown (rate-limit) — sem row, sem evento;
 *   - record é suprimido enquanto snoozed;
 *   - snooze grava `snoozedUntil` e passa a suprimir os próximos records.
 *
 * Observabilidade — NÃO move/cancela a story, não reintroduz DOR/acceptance.
 */

interface Row {
  id: string;
  cardId: string;
  kind: string;
  detail: unknown;
  ts: Date;
  snoozedUntil: Date | null;
}

const HOUR = 3_600_000;

function makeFakes(cooldownMs = HOUR) {
  const store: Row[] = [];
  let seq = 0;
  const events: ServerEvent[] = [];

  const prisma = {
    reviewAction: {
      findFirst: async ({
        where,
      }: {
        where: { cardId: string; kind: string };
      }) => {
        const matches = store
          .filter((r) => r.cardId === where.cardId && r.kind === where.kind)
          .sort((a, b) => b.ts.getTime() - a.ts.getTime());
        return matches[0] ?? null;
      },
      findMany: async ({ where }: { where: { cardId: string } }) =>
        store
          .filter((r) => r.cardId === where.cardId)
          .sort((a, b) => b.ts.getTime() - a.ts.getTime()),
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.find((r) => r.id === where.id) ?? null,
      create: async ({
        data,
      }: {
        data: { cardId: string; kind: string; detail: unknown; ts?: Date };
      }) => {
        const row: Row = {
          id: `ra_${++seq}`,
          cardId: data.cardId,
          kind: data.kind,
          detail: data.detail,
          ts: data.ts ?? new Date(),
          snoozedUntil: null,
        };
        store.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { snoozedUntil?: Date };
      }) => {
        const row = store.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        if (data.snoozedUntil !== undefined) row.snoozedUntil = data.snoozedUntil;
        return row;
      },
    },
  } as unknown as PrismaService;

  const realtime = {
    broadcast: (event: ServerEvent) => events.push(event),
  } as unknown as RealtimeService;

  const config = {
    agent: { reviewActionCooldownMs: cooldownMs },
  } as unknown as AppConfig;

  return { service: new ReviewActionService(prisma, realtime, config), store, events };
}

test('record: primeira vez cria row e emite review.action_flagged', async () => {
  const { service, store, events } = makeFakes();
  const now = 1_000_000_000;
  const action = await service.record(
    { cardId: 'story-1', kind: 'no_comment_streak', detail: { streak: 10, threshold: 10 } },
    now,
  );
  assert.ok(action);
  assert.equal(action?.cardId, 'story-1');
  assert.equal(action?.kind, 'no_comment_streak');
  assert.equal(action?.snoozedUntil, null);
  assert.equal(store.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'review.action_flagged');
});

test('record: dentro do cooldown suprime (sem row nova, sem evento)', async () => {
  const { service, store, events } = makeFakes(HOUR);
  const now = 1_000_000_000;
  await service.record({ cardId: 'story-1', kind: 'no_comment_streak', detail: {} }, now);
  const second = await service.record(
    { cardId: 'story-1', kind: 'no_comment_streak', detail: {} },
    now + HOUR / 2,
  );
  assert.equal(second, null);
  assert.equal(store.length, 1);
  assert.equal(events.length, 1);
});

test('record: após o cooldown expirar, sinaliza de novo', async () => {
  const { service, store } = makeFakes(HOUR);
  const now = 1_000_000_000;
  await service.record({ cardId: 'story-1', kind: 'no_comment_streak', detail: {} }, now);
  const second = await service.record(
    { cardId: 'story-1', kind: 'no_comment_streak', detail: {} },
    now + HOUR + 1,
  );
  assert.ok(second);
  assert.equal(store.length, 2);
});

test('snooze suprime os próximos records até expirar', async () => {
  const { service, store } = makeFakes(0); // cooldown off → só o snooze suprime
  const now = 1_000_000_000;
  const first = await service.record(
    { cardId: 'story-1', kind: 'no_comment_streak', detail: {} },
    now,
  );
  assert.ok(first);
  await service.snooze(first!.id, now + HOUR);

  // Dentro do snooze → suprimido.
  const during = await service.record(
    { cardId: 'story-1', kind: 'no_comment_streak', detail: {} },
    now + HOUR / 2,
  );
  assert.equal(during, null);

  // Após o snooze → volta a sinalizar.
  const after = await service.record(
    { cardId: 'story-1', kind: 'no_comment_streak', detail: {} },
    now + HOUR + 1,
  );
  assert.ok(after);
  assert.equal(store.length, 2);
});
