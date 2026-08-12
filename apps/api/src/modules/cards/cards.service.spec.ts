import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardsService } from './cards.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { Orchestrator } from '../ai-engine/orchestrator';
import type { ModelsService } from '../models/models.service';

/**
 * US-COLAB1 — isolamento multi-tenant por coluna `tenantId` nullable (ADR-0030).
 * Cobre os 3 casos do DOD:
 *   (a) sem `tenantId` na query → mesmo conjunto de antes (retrocompat, sem
 *       cláusula de tenant no where).
 *   (b) `tenantId=t1` → só cards com esse tenantId exato (filtro estrito; cards
 *       globais tenantId=null NÃO vazam).
 *   (c) card criado sem `tenantId` nasce com tenantId=null e só aparece em
 *       queries sem filtro de tenant.
 */

interface CardRow {
  id: string;
  boardId: string;
  type: 'epic' | 'story' | 'task';
  tenantId: string | null;
  model?: string | null;
  parentId?: string | null;
  boardColumnId?: string | null;
  taskColumnId?: string | null;
  labels?: { labelId: string }[];
  assignees?: { assigneeId: string }[];
}

/** Aplica um subconjunto do where do Prisma (boardId + tenantId) ao dataset. */
function applyWhere(rows: CardRow[], where: Record<string, unknown> | undefined): CardRow[] {
  if (!where) return rows;
  return rows.filter((r) => {
    if ('boardId' in where && r.boardId !== where.boardId) return false;
    if ('tenantId' in where && r.tenantId !== where.tenantId) return false;
    return true;
  });
}

function makeService(rows: CardRow[]): {
  svc: CardsService;
  lastWhere: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const data = rows.map((r) => ({
    labels: r.labels ?? [],
    assignees: r.assignees ?? [],
    parentId: r.parentId ?? null,
    boardColumnId: r.boardColumnId ?? null,
    taskColumnId: r.taskColumnId ?? null,
    model: r.model ?? null,
    ...r,
  }));
  const prisma = {
    getSchemaHealth: () => ({ ok: true, missing: [] }),
    card: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        captured = args?.where;
        return applyWhere(data as unknown as CardRow[], args?.where);
      },
    },
    board: { findMany: async () => [] },
  } as unknown as PrismaService;
  const realtime = { broadcast() {} } as unknown as RealtimeService;
  const orchestrator = {} as unknown as Orchestrator;
  const models = { defaultModelId: () => 'default-model' } as unknown as ModelsService;
  return { svc: new CardsService(prisma, realtime, orchestrator, models), lastWhere: () => captured };
}

const BOARD = '11111111-1111-1111-1111-111111111111';
const dataset: CardRow[] = [
  { id: 'c-global-1', boardId: BOARD, type: 'story', tenantId: null },
  { id: 'c-global-2', boardId: BOARD, type: 'task', tenantId: null, parentId: 'c-global-1' },
  { id: 'c-t1-1', boardId: BOARD, type: 'story', tenantId: 't1' },
  { id: 'c-t2-1', boardId: BOARD, type: 'story', tenantId: 't2' },
];

test('findAll: (a) sem tenantId retorna o mesmo conjunto de antes (retrocompat)', async () => {
  const { svc, lastWhere } = makeService(dataset);
  const result = (await svc.findAll({ boardId: BOARD })) as { id: string }[];
  assert.deepEqual(
    result.map((c) => c.id).sort(),
    ['c-global-1', 'c-global-2', 'c-t1-1', 'c-t2-1'],
    'todos os cards do board (nenhuma cláusula de tenant)',
  );
  assert.ok(!('tenantId' in (lastWhere() ?? {})), 'where NÃO deve conter tenantId quando ausente');
});

test('findAll: (b) tenantId=t1 retorna só cards com tenantId=t1 (estrito, sem vazar globais)', async () => {
  const { svc, lastWhere } = makeService(dataset);
  const result = (await svc.findAll({ boardId: BOARD, tenantId: 't1' })) as { id: string }[];
  assert.deepEqual(result.map((c) => c.id).sort(), ['c-t1-1'], 'só o card do t1');
  assert.equal((lastWhere() as { tenantId?: string }).tenantId, 't1');
});

test('findAll: (c) card global (tenantId=null) só aparece em query sem filtro de tenant', async () => {
  const { svc } = makeService(dataset);
  const withoutFilter = (await svc.findAll({ boardId: BOARD })) as { id: string }[];
  assert.ok(
    withoutFilter.some((c) => c.id === 'c-global-1'),
    'card global aparece sem filtro',
  );
  const withT1 = (await svc.findAll({ boardId: BOARD, tenantId: 't1' })) as { id: string }[];
  assert.ok(
    !withT1.some((c) => c.id === 'c-global-1'),
    'card global NÃO vaza para dentro do tenant t1',
  );
});
