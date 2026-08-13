import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LoopMetrics } from '@kanban-ai/shared';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { Orchestrator } from '../ai-engine/orchestrator';
import type { AppConfig } from '../../shared/config/config';
import { DashboardService } from './dashboard.service';

/**
 * US-OBS1 — testes do read-model agregado da frota (`DashboardService`).
 *
 * Usamos fakes leves (estratégia dos specs do núcleo): um Prisma fake in-memory
 * que modela cards (epic/story/task) + colunas (via boardColumn/taskColumn) e
 * iterações, e um Orchestrator fake que devolve `LoopMetrics` por story.
 */

interface CardRow {
  id: string;
  type: 'epic' | 'story' | 'task';
  key?: string;
  title?: string;
  execState?: string | null;
  parentId?: string | null;
  /** Título da coluna de board (epic/story). */
  boardColumnTitle?: string | null;
  /** Título da coluna do mini-kanban (task). */
  taskColumnTitle?: string | null;
  updatedAt?: Date;
  /** CAMPO SENSÍVEL — nunca deve escapar para o dashboard. */
  aiProject?: string | null;
}

interface IterationRow {
  cardId: string;
  index: number;
  ts: Date;
}

const SECRET_PROJECT = '/home/secret-user/private-repo';

function makePrisma(cards: CardRow[], iterations: IterationRow[]): PrismaService {
  return {
    card: {
      async findMany(args: {
        where?: { type?: string; boardColumn?: { title?: string } };
        select?: Record<string, unknown>;
      }) {
        let rows = cards;
        if (args.where?.type) rows = rows.filter((c) => c.type === args.where!.type);
        if (args.where?.boardColumn?.title) {
          const title = args.where.boardColumn.title;
          rows = rows.filter((c) => c.boardColumnTitle === title);
        }
        // Projeta apenas o shape pedido pelo service (nunca expõe aiProject a
        // menos que ele o selecione — o que este teste garante que NÃO ocorre).
        return rows.map((c) => ({
          id: c.id,
          type: c.type,
          key: c.key ?? c.id,
          title: c.title ?? c.id,
          execState: c.execState ?? 'idle',
          updatedAt: c.updatedAt ?? new Date(0),
          boardColumn: c.boardColumnTitle ? { title: c.boardColumnTitle } : null,
          taskColumn: c.taskColumnTitle ? { title: c.taskColumnTitle } : null,
        }));
      },
    },
    iteration: {
      async findFirst(args: {
        where: { card: { parentId: string } };
        orderBy: { index: 'desc' };
      }) {
        const parentId = args.where.card.parentId;
        const taskIds = cards
          .filter((c) => c.type === 'task' && c.parentId === parentId)
          .map((c) => c.id);
        const its = iterations
          .filter((it) => taskIds.includes(it.cardId))
          .sort((a, b) => b.index - a.index);
        const last = its[0];
        return last ? { ts: last.ts } : null;
      },
    },
  } as unknown as PrismaService;
}

function makeOrchestrator(metricsByStory: Record<string, Partial<LoopMetrics>>): Orchestrator {
  return {
    async computeStoryMetrics(storyId: string): Promise<LoopMetrics> {
      const m = metricsByStory[storyId] ?? {};
      return {
        storyId,
        taskCount: m.taskCount ?? 0,
        iterationCount: m.iterationCount ?? 0,
        avgIterationsPerTask: m.avgIterationsPerTask ?? 0,
        derivedTaskRate: m.derivedTaskRate ?? 0,
        okIterationRate: m.okIterationRate ?? 0,
        avgDurationMs: m.avgDurationMs ?? null,
        totalInputTokens: m.totalInputTokens ?? 0,
        totalOutputTokens: m.totalOutputTokens ?? 0,
        perTask: m.perTask ?? [],
      };
    },
  } as unknown as Orchestrator;
}

function makeConfig(staleMinutes: number): AppConfig {
  return { dashboard: { staleMinutes } } as unknown as AppConfig;
}

test('columns: agrega counts por coluna na ordem de BOARD_COLUMNS', async () => {
  const cards: CardRow[] = [
    { id: 'e1', type: 'epic', boardColumnTitle: 'Backlog' },
    { id: 's1', type: 'story', boardColumnTitle: 'Backlog' },
    { id: 's2', type: 'story', boardColumnTitle: 'In Progress' },
    { id: 't1', type: 'task', parentId: 's2', taskColumnTitle: 'In Progress' },
    { id: 't2', type: 'task', parentId: 's2', taskColumnTitle: 'In Progress' },
    { id: 't3', type: 'task', parentId: 's2', taskColumnTitle: 'Done' },
    // card sem coluna: ignorado
    { id: 's3', type: 'story', boardColumnTitle: null },
  ];
  const service = new DashboardService(
    makePrisma(cards, []),
    makeOrchestrator({}),
    makeConfig(30),
  );

  const dash = await service.getFleetDashboard();

  assert.deepEqual(
    dash.columns.map((c) => c.column),
    ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'],
  );
  const backlog = dash.columns.find((c) => c.column === 'Backlog')!;
  assert.equal(backlog.epics, 1);
  assert.equal(backlog.stories, 1);
  assert.equal(backlog.tasks, 0);
  assert.equal(backlog.total, 2);

  const inProgress = dash.columns.find((c) => c.column === 'In Progress')!;
  assert.equal(inProgress.stories, 1);
  assert.equal(inProgress.tasks, 2);
  assert.equal(inProgress.total, 3);

  const done = dash.columns.find((c) => c.column === 'Done')!;
  assert.equal(done.tasks, 1);
  assert.equal(done.total, 1);
});

test('staleStories: só marca stories In Progress acima do threshold, ordenadas desc', async () => {
  const now = Date.now();
  const cards: CardRow[] = [
    // story ativa e MUITO stale (última iteração há 90 min)
    { id: 's1', type: 'story', key: 'US-1', title: 'Stale', boardColumnTitle: 'In Progress' },
    { id: 't1', type: 'task', parentId: 's1', taskColumnTitle: 'In Progress' },
    // story ativa recente (iteração há 5 min → abaixo do threshold 30)
    { id: 's2', type: 'story', key: 'US-2', title: 'Fresh', boardColumnTitle: 'In Progress' },
    { id: 't2', type: 'task', parentId: 's2', taskColumnTitle: 'In Progress' },
    // story ativa media (45 min)
    { id: 's3', type: 'story', key: 'US-3', title: 'Medium', boardColumnTitle: 'In Progress' },
    { id: 't3', type: 'task', parentId: 's3', taskColumnTitle: 'In Progress' },
    // story NÃO In Progress: nunca é stale, mesmo velha
    { id: 's4', type: 'story', key: 'US-4', title: 'Backlog', boardColumnTitle: 'Backlog', updatedAt: new Date(0) },
  ];
  const iterations: IterationRow[] = [
    { cardId: 't1', index: 0, ts: new Date(now - 90 * 60_000) },
    { cardId: 't2', index: 0, ts: new Date(now - 5 * 60_000) },
    { cardId: 't3', index: 0, ts: new Date(now - 45 * 60_000) },
  ];
  const service = new DashboardService(
    makePrisma(cards, iterations),
    makeOrchestrator({}),
    makeConfig(30),
  );

  const dash = await service.getFleetDashboard();

  // US-2 (fresh) e US-4 (backlog) fora; US-1 e US-3 dentro, ordenados desc.
  assert.deepEqual(dash.staleStories.map((s) => s.key), ['US-1', 'US-3']);
  assert.ok(dash.staleStories[0].staleMinutes >= dash.staleStories[1].staleMinutes);
  assert.ok(dash.staleStories[0].staleMinutes >= 89);
  assert.ok(dash.staleStories[0].lastIterationAt !== null);
});

test('staleStories: story sem iteração usa updatedAt da story', async () => {
  const now = Date.now();
  const cards: CardRow[] = [
    {
      id: 's1',
      type: 'story',
      key: 'US-1',
      title: 'NoIter',
      boardColumnTitle: 'In Progress',
      updatedAt: new Date(now - 120 * 60_000),
    },
  ];
  const service = new DashboardService(
    makePrisma(cards, []),
    makeOrchestrator({}),
    makeConfig(30),
  );

  const dash = await service.getFleetDashboard();
  assert.equal(dash.staleStories.length, 1);
  assert.equal(dash.staleStories[0].lastIterationAt, null);
  assert.ok(dash.staleStories[0].staleMinutes >= 119);
});

test('cost: soma tokens/iterações e pondera as taxas por iterationCount', async () => {
  const cards: CardRow[] = [
    { id: 's1', type: 'story', boardColumnTitle: 'In Progress' },
    { id: 's2', type: 'story', boardColumnTitle: 'In Progress' },
    // story fora de In Progress não entra no cost
    { id: 's3', type: 'story', boardColumnTitle: 'Backlog' },
  ];
  const metrics: Record<string, Partial<LoopMetrics>> = {
    s1: {
      iterationCount: 10,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      derivedTaskRate: 0.2,
      okIterationRate: 0.8,
    },
    s2: {
      iterationCount: 30,
      totalInputTokens: 3000,
      totalOutputTokens: 1500,
      derivedTaskRate: 0.6,
      okIterationRate: 0.4,
    },
  };
  const service = new DashboardService(
    makePrisma(cards, []),
    makeOrchestrator(metrics),
    makeConfig(30),
  );

  const dash = await service.getFleetDashboard();

  assert.equal(dash.cost.activeStories, 2);
  assert.equal(dash.cost.totalIterations, 40);
  assert.equal(dash.cost.totalInputTokens, 4000);
  assert.equal(dash.cost.totalOutputTokens, 2000);
  // ponderada: (0.2*10 + 0.6*30)/40 = 20/40 = 0.5
  assert.equal(dash.cost.derivedTaskRate, 0.5);
  // (0.8*10 + 0.4*30)/40 = 20/40 = 0.5
  assert.equal(dash.cost.okIterationRate, 0.5);
});

test('cost: sem stories ativas zera tudo (sem divisão por zero)', async () => {
  const service = new DashboardService(
    makePrisma([{ id: 's1', type: 'story', boardColumnTitle: 'Backlog' }], []),
    makeOrchestrator({}),
    makeConfig(30),
  );
  const dash = await service.getFleetDashboard();
  assert.equal(dash.cost.activeStories, 0);
  assert.equal(dash.cost.totalIterations, 0);
  assert.equal(dash.cost.derivedTaskRate, 0);
  assert.equal(dash.cost.okIterationRate, 0);
});

test('não-vazamento: o objeto retornado NÃO contém a string do aiProject', async () => {
  const cards: CardRow[] = [
    {
      id: 's1',
      type: 'story',
      key: 'US-1',
      title: 'Ativa',
      boardColumnTitle: 'In Progress',
      aiProject: SECRET_PROJECT,
    },
    { id: 't1', type: 'task', parentId: 's1', taskColumnTitle: 'In Progress', aiProject: SECRET_PROJECT },
  ];
  const service = new DashboardService(
    makePrisma(cards, [{ cardId: 't1', index: 0, ts: new Date(0) }]),
    makeOrchestrator({ s1: { iterationCount: 1, totalInputTokens: 10 } }),
    makeConfig(0),
  );

  const dash = await service.getFleetDashboard();
  const serialized = JSON.stringify(dash);
  assert.ok(
    !serialized.includes(SECRET_PROJECT),
    'dashboard vazou o caminho do aiProject (segredo)',
  );
  assert.ok(!serialized.includes('secret-user'), 'dashboard vazou parte do path sensível');

  // Sanidade: as chaves de contrato existem.
  assert.deepEqual(
    Object.keys(dash).sort(),
    ['columns', 'cost', 'generatedAt', 'staleStories'],
  );
});
