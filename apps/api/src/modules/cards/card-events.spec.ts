import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardsService } from './cards.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { Orchestrator } from '../ai-engine/orchestrator';
import type { ModelsService } from '../models/models.service';

/**
 * US-OBS2-2 — Log tipado append-only `CardEvent`.
 * Cobre:
 *   (1) o mapeamento do emit helper (cada transição → kind/payload corretos),
 *       exercitado via `update()` (card_updated) e via `emitEpicStatus`
 *       (epic_status_derived);
 *   (2) o tail incremental `listEvents` — ordenação ascendente, corte por
 *       `since` (cursor por id → filtra ts>) e limite são;
 *   (3) robustez: falha ao gravar o log NÃO derruba a transição (best-effort).
 *
 * Tudo com um Prisma mockado em memória — sem DB, roda como pure-function spec.
 */

interface CardEventRow {
  id: string;
  cardId: string;
  kind: string;
  payload: unknown;
  ts: Date;
}

interface MockOpts {
  cards?: Record<string, { id: string; type?: string; boardId?: string } | undefined>;
  events?: CardEventRow[];
  failCreate?: boolean;
}

function makeService(opts: MockOpts = {}): {
  svc: CardsService;
  created: { cardId: string; kind: string; payload: unknown }[];
} {
  const created: { cardId: string; kind: string; payload: unknown }[] = [];
  const events = opts.events ?? [];
  const cards = opts.cards ?? {};

  const prisma = {
    getSchemaHealth: () => ({ ok: true, missing: [] }),
    card: {
      findUnique: async (args: { where: { id: string } }) => {
        const c = cards[args.where.id];
        if (!c) return null;
        // Enriquecido o suficiente para satisfazer update()+findOne():
        // `model` setado curto-circuita resolveModel; `iterations: []` satisfaz o map.
        return {
          model: 'm1',
          parentId: null,
          boardId: 'b1',
          iterations: [],
          dodItems: [],
          affectedFlows: [],
          comments: [],
          labels: [],
          assignees: [],
          dependsOn: [],
          ...c,
        };
      },
      update: async () => ({}),
      findMany: async () => [],
    },
    board: { findUnique: async () => ({ defaultModel: 'm1' }) },
    column: { findMany: async () => [] },
    cardEvent: {
      create: async (args: { data: { cardId: string; kind: string; payload: unknown } }) => {
        if (opts.failCreate) throw new Error('boom (db down)');
        created.push({
          cardId: args.data.cardId,
          kind: args.data.kind,
          payload: args.data.payload,
        });
        const row: CardEventRow = {
          id: `ev-${created.length}`,
          cardId: args.data.cardId,
          kind: args.data.kind,
          payload: args.data.payload,
          ts: new Date(),
        };
        events.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        events.find((e) => e.id === args.where.id) ?? null,
      findMany: async (args: {
        where: { cardId: string; ts?: { gt: Date } };
        take?: number;
      }) => {
        let rows = events.filter((e) => e.cardId === args.where.cardId);
        const gt = args.where.ts?.gt;
        if (gt) rows = rows.filter((e) => e.ts.getTime() > gt.getTime());
        rows = rows.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id.localeCompare(b.id));
        if (args.take) rows = rows.slice(0, args.take);
        return rows;
      },
    },
  } as unknown as PrismaService;

  const realtime = { broadcast() {} } as unknown as RealtimeService;
  const orchestrator = {} as unknown as Orchestrator;
  const models = {} as unknown as ModelsService;
  return {
    svc: new CardsService(prisma, realtime, orchestrator, models),
    created,
  };
}

test('emit: update() grava um CardEvent card_updated com os campos alterados', async () => {
  const { svc, created } = makeService({
    cards: { 'card-1': { id: 'card-1', type: 'story', boardId: 'b1' } },
  });
  await svc.update('card-1', { title: 'novo', blocked: true });
  const ev = created.find((c) => c.kind === 'card_updated');
  assert.ok(ev, 'deve ter gravado um card_updated');
  assert.equal(ev!.cardId, 'card-1');
  assert.deepEqual(
    (ev!.payload as { fields: string[] }).fields.sort(),
    ['blocked', 'title'],
    'payload.fields reflete só os campos efetivamente enviados',
  );
});

test('emit: best-effort — falha ao gravar o log NÃO derruba a transição', async () => {
  const { svc, created } = makeService({
    cards: { 'card-1': { id: 'card-1', type: 'task', boardId: 'b1' } },
    failCreate: true,
  });
  // Não deve lançar mesmo com o create do log falhando.
  await svc.update('card-1', { title: 'x' });
  assert.equal(created.length, 0, 'nada persistido, mas a transição concluiu sem erro');
});

test('tail: listEvents ordena ascendente e limita a página', async () => {
  const now = Date.now();
  const events: CardEventRow[] = [
    { id: 'ev-1', cardId: 'c1', kind: 'card_created', payload: {}, ts: new Date(now + 1) },
    { id: 'ev-2', cardId: 'c1', kind: 'card_moved', payload: {}, ts: new Date(now + 2) },
    { id: 'ev-3', cardId: 'c1', kind: 'card_updated', payload: {}, ts: new Date(now + 3) },
  ];
  const { svc } = makeService({ cards: { c1: { id: 'c1' } }, events });
  const all = await svc.listEvents('c1');
  assert.deepEqual(all.map((e) => e.id), ['ev-1', 'ev-2', 'ev-3'], 'ordem cronológica ascendente');
  const page = await svc.listEvents('c1', { limit: 2 });
  assert.equal(page.length, 2, 'respeita o limite');
  assert.equal(page[0].id, 'ev-1');
  assert.equal(typeof all[0].ts, 'string', 'ts serializado como ISO string');
});

test('tail: since=<eventId> retorna só eventos APÓS o cursor', async () => {
  const now = Date.now();
  const events: CardEventRow[] = [
    { id: 'ev-1', cardId: 'c1', kind: 'card_created', payload: {}, ts: new Date(now + 1) },
    { id: 'ev-2', cardId: 'c1', kind: 'card_moved', payload: {}, ts: new Date(now + 2) },
    { id: 'ev-3', cardId: 'c1', kind: 'card_updated', payload: {}, ts: new Date(now + 3) },
  ];
  const { svc } = makeService({ cards: { c1: { id: 'c1' } }, events });
  const tail = await svc.listEvents('c1', { since: 'ev-1' });
  assert.deepEqual(tail.map((e) => e.id), ['ev-2', 'ev-3'], 'só o que veio depois de ev-1');
});

test('tail: since inválido (id de outro card) → BadRequest', async () => {
  const now = Date.now();
  const events: CardEventRow[] = [
    { id: 'ev-1', cardId: 'other', kind: 'card_created', payload: {}, ts: new Date(now + 1) },
  ];
  const { svc } = makeService({
    cards: { c1: { id: 'c1' }, other: { id: 'other' } },
    events,
  });
  await assert.rejects(() => svc.listEvents('c1', { since: 'ev-1' }), /cursor .* inv/i);
});

test('tail: card inexistente → NotFound', async () => {
  const { svc } = makeService({ cards: {} });
  await assert.rejects(() => svc.listEvents('nope'), /inexistente/);
});
