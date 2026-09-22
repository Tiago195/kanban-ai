import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardsService } from './cards.service';
import { updateCardSchema } from './cards.schema';
import { setBoardAdapterSchema } from '../boards/boards.schema';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { Orchestrator } from '../ai-engine/orchestrator';
import type { ModelsService } from '../models/models.service';
import type { AppConfig } from '../../shared/config/config';

/**
 * US-F3.10 — leitura/escrita do adapter na API de cards.
 *
 *  - `resolvedAdapter` anexado pela MESMA cascata em memória de
 *    `resolvedModel` (findAll, sem N+1) e por `resolveAdapter` (findOne);
 *  - cauda global = config.agentAdapter (default do processo sem config);
 *  - escrita validada contra o catálogo de kinds (updateCardSchema e
 *    setBoardAdapterSchema rejeitam vendor desconhecido).
 */

interface Row {
  id: string;
  boardId: string;
  type: string;
  parentId?: string | null;
  model?: string | null;
  adapter?: string | null;
}

function makeService(
  rows: Row[],
  board: { defaultAdapter?: string | null } = {},
  config?: Partial<AppConfig>,
): CardsService {
  const data = rows.map((r) => ({
    labels: [],
    assignees: [],
    parentId: r.parentId ?? null,
    boardColumnId: null,
    taskColumnId: null,
    model: r.model ?? null,
    adapter: r.adapter ?? null,
    ...r,
  }));
  const prisma = {
    getSchemaHealth: () => ({ ok: true, missing: [] }),
    card: { findMany: async () => data },
    column: { findMany: async () => [] },
    board: {
      findMany: async () => [
        { id: 'b1', defaultModel: null, defaultAdapter: board.defaultAdapter ?? null },
      ],
    },
  } as unknown as PrismaService;
  return new CardsService(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as Orchestrator,
    { defaultModelId: () => 'default-model' } as unknown as ModelsService,
    config as AppConfig | undefined,
  );
}

test('US-F3.10: findAll anexa resolvedAdapter pela cascata em memória (card > pai > board > global)', async () => {
  const svc = makeService(
    [
      { id: 'e1', boardId: 'b1', type: 'epic', adapter: 'claude' },
      { id: 's1', boardId: 'b1', type: 'story', parentId: 'e1' },
      { id: 't1', boardId: 'b1', type: 'task', parentId: 's1', adapter: 'gemini' },
      { id: 't2', boardId: 'b1', type: 'task', parentId: 's1' },
      { id: 's2', boardId: 'b1', type: 'story' },
    ],
    { defaultAdapter: 'tanstack' },
    { agentAdapter: 'copilot-cli' } as Partial<AppConfig>,
  );
  const result = (await svc.findAll({ boardId: 'b1' })) as Array<{
    id: string;
    resolvedAdapter: string;
  }>;
  const byId = new Map(result.map((c) => [c.id, c.resolvedAdapter]));
  assert.equal(byId.get('t1'), 'gemini', 'próprio card vence');
  assert.equal(byId.get('t2'), 'claude', 'herda da hierarquia (epic)');
  assert.equal(byId.get('s1'), 'claude', 'story herda do epic');
  assert.equal(byId.get('s2'), 'tanstack', 'sem hierarquia cai no board.defaultAdapter');
});

test('US-F3.10: cauda global = config.agentAdapter; sem config, default do processo (mock)', async () => {
  const withConfig = makeService(
    [{ id: 's1', boardId: 'b1', type: 'story' }],
    {},
    { agentAdapter: 'copilot-cli' } as Partial<AppConfig>,
  );
  const r1 = (await withConfig.findAll({ boardId: 'b1' })) as Array<{ resolvedAdapter: string }>;
  assert.equal(r1[0].resolvedAdapter, 'copilot-cli');

  const withoutConfig = makeService([{ id: 's1', boardId: 'b1', type: 'story' }]);
  const r2 = (await withoutConfig.findAll({ boardId: 'b1' })) as Array<{ resolvedAdapter: string }>;
  assert.equal(r2[0].resolvedAdapter, 'mock', 'sem config injetada, default do processo');
});

test('US-F3.10: valor desconhecido persistido é ignorado na leitura (cascata continua)', async () => {
  const svc = makeService(
    [{ id: 's1', boardId: 'b1', type: 'story', adapter: 'vendor-fantasma' }],
    { defaultAdapter: 'claude' },
  );
  const r = (await svc.findAll({ boardId: 'b1' })) as Array<{ resolvedAdapter: string }>;
  assert.equal(r[0].resolvedAdapter, 'claude');
});

test('US-F3.10: updateCardSchema aceita adapter do catálogo (e null para limpar) e rejeita desconhecido', () => {
  assert.equal(updateCardSchema.safeParse({ adapter: 'gemini' }).success, true);
  assert.equal(updateCardSchema.safeParse({ adapter: null }).success, true);
  assert.equal(updateCardSchema.safeParse({ adapter: 'vendor-fantasma' }).success, false);
});

test('US-F3.10: setBoardAdapterSchema valida o defaultAdapter do quadro', () => {
  assert.equal(setBoardAdapterSchema.safeParse({ defaultAdapter: 'tanstack' }).success, true);
  assert.equal(setBoardAdapterSchema.safeParse({ defaultAdapter: null }).success, true);
  assert.equal(setBoardAdapterSchema.safeParse({ defaultAdapter: 'x' }).success, false);
  assert.equal(setBoardAdapterSchema.safeParse({}).success, false);
});
