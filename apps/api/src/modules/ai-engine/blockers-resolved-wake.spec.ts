import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator } from './orchestrator';

/**
 * US-BLOCK3 — blocker-dependency auto-wake (reverso do M3).
 *
 * Estratégia (mesma de promote-dependents.spec / orchestrator-guards.spec):
 * instanciamos o Orchestrator com fakes leves e exercitamos
 * `wakeBlockersResolvedDependents(cardId)` via acesso caixa-branca. Observamos os
 * wakes espionando `enqueueWakeup` (caminho durável preferido) e
 * `onStoryEnterInProgress` (fallback in-process). O Prisma fake in-memory modela
 * cards (execState + coluna), arestas TaskDependency e o `AgentRuntimeState`
 * (para o `blockerSetHash` guardado no stateJson).
 *
 * Cobre: (a) cadeia A→B→C; (b) `cancelled` deixa a aresta aberta; (c)
 * idempotência (1 wake por conjunto; refechar o mesmo conjunto não re-dispara).
 */

interface CardRow {
  id: string;
  type: 'task' | 'story';
  execState?: string | null;
  parentId?: string | null;
  /** ids das tasks das quais este card depende (arestas dependsOn). */
  dependsOn?: string[];
  /** título da coluna de board (relevante p/ story e p/ satisfação por coluna). */
  columnTitle?: string;
  isTaskColumn?: boolean;
}

interface RuntimeRow {
  sessionId: string;
  storyId: string;
  stateJson: string;
}

function makePrisma(cards: CardRow[]) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const runtime = new Map<string, RuntimeRow>();

  const svc = {
    taskDependency: {
      async findMany(args: { where: { dependsOnId: string } }) {
        const dep = args.where.dependsOnId;
        return cards
          .filter((c) => (c.dependsOn ?? []).includes(dep))
          .map((c) => ({ dependentId: c.id }));
      },
      async deleteMany() {
        return { count: 0 };
      },
    },
    card: {
      async findUnique(args: { where: { id: string }; select?: Record<string, unknown> }) {
        const c = byId.get(args.where.id);
        if (!c) return null;
        // loadTask shape (dependsOn/execState/dodItems/iterations/...).
        return {
          id: c.id,
          type: c.type,
          execState: c.execState ?? 'idle',
          createdAt: new Date(0),
          needsHuman: false,
          dependsOn: (c.dependsOn ?? []).map((dependsOnId) => ({ dependsOnId })),
          iterations: [],
          dodItems: [],
          parentId: c.parentId ?? null,
          title: c.id,
          description: '',
          boardColumn: c.columnTitle && !c.isTaskColumn ? { title: c.columnTitle } : null,
          taskColumn: c.columnTitle && c.isTaskColumn ? { title: c.columnTitle } : null,
        };
      },
      async findMany(args: { where: { parentId: string } }) {
        return cards
          .filter((c) => c.type === 'task' && c.parentId === args.where.parentId)
          .map((c) => ({
            id: c.id,
            type: c.type,
            execState: c.execState ?? 'idle',
            createdAt: new Date(0),
            needsHuman: false,
            dependsOn: (c.dependsOn ?? []).map((dependsOnId) => ({ dependsOnId })),
            iterations: [],
            dodItems: [],
          }));
      },
      async update() {
        return undefined;
      },
    },
    agentRuntimeState: {
      async findUnique(args: { where: { sessionId: string } }) {
        return runtime.get(args.where.sessionId) ?? null;
      },
      async upsert(args: {
        where: { sessionId: string };
        update: { stateJson: string };
        create: RuntimeRow;
      }) {
        const existing = runtime.get(args.where.sessionId);
        if (existing) {
          existing.stateJson = args.update.stateJson;
        } else {
          runtime.set(args.where.sessionId, { ...args.create });
        }
        return undefined;
      },
    },
    activity: { create: async () => undefined },
  } as unknown as PrismaService;
  return { svc, runtime };
}

function makeConfig(overrides: Partial<AppConfig['agent']> = {}): AppConfig {
  return {
    agent: {
      maxConcurrentSessions: 3,
      watchdogIntervalMs: 120_000,
      autostartDependents: true,
      wakeupQueueEnabled: false,
      ...overrides,
    },
  } as unknown as AppConfig;
}

function makeSessions(config: AppConfig): AgentSessionManager {
  const prisma = { agentRuntimeState: { upsert: async () => undefined } } as unknown as PrismaService;
  return new AgentSessionManager(config, prisma);
}

function makeOrchestrator(config: AppConfig, prisma: PrismaService): Orchestrator {
  const noop = () => undefined;
  const realtime = { broadcast: noop } as unknown as RealtimeService;
  const workspaces = {
    cleanupWorktree: async () => undefined,
    resolveWorkdir: async () => '/repo',
  } as unknown as WorkspaceService;
  const validation = { validate: async () => ({ passed: true, problems: [] }) } as unknown as ValidationRunner;
  const runner = { run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner;
  return new Orchestrator(
    prisma,
    makeSessions(config),
    validation,
    workspaces,
    realtime,
    runner,
    config,
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (orch: Orchestrator) => orch as unknown as any;

/** Espiona os wakes: enqueueWakeup (durável) + onStoryEnterInProgress (fallback). */
function spyWakes(orch: Orchestrator): { enqueued: Array<{ storyId: string; reason: string }>; woken: string[] } {
  const enqueued: Array<{ storyId: string; reason: string }> = [];
  const woken: string[] = [];
  priv(orch).enqueueWakeup = async (storyId: string, reason: string) => {
    enqueued.push({ storyId, reason });
  };
  priv(orch).onStoryEnterInProgress = async (storyId: string) => {
    woken.push(storyId);
  };
  return { enqueued, woken };
}

test('US-BLOCK3 (a): cadeia A→B→C — fechar A NÃO acorda C enquanto B aberto', async () => {
  // C depende de B; B depende de A. Fechar A não resolve o conjunto de C.
  const prisma = makePrisma([
    { id: 'A', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'B', type: 'task', execState: 'implementing', parentId: 'US-1', dependsOn: ['A'] },
    { id: 'C', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['B'] },
    { id: 'US-1', type: 'story', columnTitle: 'In Progress' },
    { id: 'US-2', type: 'story', columnTitle: 'In Progress' },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma.svc);
  const { enqueued, woken } = spyWakes(orch);

  // Fechar A: dependente é B. B não está resolvido? A (blocker de B) está done.
  await priv(orch).wakeBlockersResolvedDependents('A');
  // A resolve B → B acorda (US-1). C NÃO é dependente de A, então não acorda.
  assert.deepEqual(
    enqueued.map((e) => e.storyId),
    ['US-1'],
    'fechar A resolve os blockers de B (US-1); C permanece bloqueado por B',
  );
  assert.ok(!enqueued.some((e) => e.storyId === 'US-2'), 'C (US-2) não acorda enquanto B aberto');
  assert.ok(woken.includes('US-1'));
});

test('US-BLOCK3 (a): fechar B acorda C (1 wake blockers_resolved)', async () => {
  const prisma = makePrisma([
    { id: 'A', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'B', type: 'task', execState: 'done', parentId: 'US-1', dependsOn: ['A'] },
    { id: 'C', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['B'] },
    { id: 'US-1', type: 'story', columnTitle: 'In Progress' },
    { id: 'US-2', type: 'story', columnTitle: 'In Progress' },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma.svc);
  const { enqueued } = spyWakes(orch);

  await priv(orch).wakeBlockersResolvedDependents('B');
  assert.equal(enqueued.length, 1, 'exatamente 1 wake');
  assert.deepEqual(enqueued[0], { storyId: 'US-2', reason: 'blockers_resolved' });
});

test('US-BLOCK3 (a): dependente com múltiplos blockers só acorda quando TODOS fecham', async () => {
  // C depende de A (done) e B (aberto) → fechar A não acorda; fechar B acorda.
  const cards: CardRow[] = [
    { id: 'A', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'B', type: 'task', execState: 'implementing', parentId: 'US-1' },
    { id: 'C', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['A', 'B'] },
    { id: 'US-1', type: 'story', columnTitle: 'In Progress' },
    { id: 'US-2', type: 'story', columnTitle: 'In Progress' },
  ];
  const prisma = makePrisma(cards);
  const orch = makeOrchestrator(makeConfig(), prisma.svc);
  const { enqueued } = spyWakes(orch);

  await priv(orch).wakeBlockersResolvedDependents('A');
  assert.equal(enqueued.length, 0, 'B ainda aberto → C não acorda');

  // Fecha B e re-dispara pelo fechamento de B.
  cards.find((c) => c.id === 'B')!.execState = 'done';
  await priv(orch).wakeBlockersResolvedDependents('B');
  assert.deepEqual(enqueued, [{ storyId: 'US-2', reason: 'blockers_resolved' }]);
});

test('US-BLOCK3 (a): satisfação por COLUNA "Done" (caminho de board não toca execState)', async () => {
  // Blocker foi movido para a coluna Done pela UI: execState continua 'idle',
  // mas a coluna "Done" satisfaz a aresta.
  const prisma = makePrisma([
    { id: 'A', type: 'task', execState: 'idle', parentId: 'US-1', columnTitle: 'Done', isTaskColumn: true },
    { id: 'C', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['A'] },
    { id: 'US-2', type: 'story', columnTitle: 'In Progress' },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma.svc);
  const { enqueued } = spyWakes(orch);

  await priv(orch).wakeBlockersResolvedDependents('A');
  assert.deepEqual(enqueued, [{ storyId: 'US-2', reason: 'blockers_resolved' }]);
});

test('US-BLOCK3 (b): cancelled deixa a aresta ABERTA — não acorda', async () => {
  // A "cancelada" (execState != done, coluna != Done). Não satisfaz o blocker.
  const prisma = makePrisma([
    { id: 'A', type: 'task', execState: 'cancelled', parentId: 'US-1', columnTitle: 'Cancelled', isTaskColumn: true },
    { id: 'C', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['A'] },
    { id: 'US-2', type: 'story', columnTitle: 'In Progress' },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma.svc);
  const { enqueued, woken } = spyWakes(orch);

  await priv(orch).wakeBlockersResolvedDependents('A');
  assert.deepEqual(enqueued, [], 'blocker cancelado não resolve a aresta');
  assert.deepEqual(woken, [], 'story permanece bloqueada');
});

test('US-BLOCK3 (invariante 6): story fora de In Progress não é acordada', async () => {
  const prisma = makePrisma([
    { id: 'A', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'C', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['A'] },
    { id: 'US-2', type: 'story', columnTitle: 'To Do' },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma.svc);
  const { enqueued } = spyWakes(orch);

  await priv(orch).wakeBlockersResolvedDependents('A');
  assert.deepEqual(enqueued, [], 'story não In Progress não acorda (invariante 6)');
});

test('US-BLOCK3 (c): idempotência — fechar/refechar o MESMO conjunto não dispara 2º wake', async () => {
  const prisma = makePrisma([
    { id: 'A', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'C', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['A'] },
    { id: 'US-2', type: 'story', columnTitle: 'In Progress' },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma.svc);
  const { enqueued } = spyWakes(orch);

  await priv(orch).wakeBlockersResolvedDependents('A');
  assert.equal(enqueued.length, 1, '1º fechamento acorda');

  // Re-dispara pelo MESMO conjunto de blockers → blockerSetHash já registrado.
  await priv(orch).wakeBlockersResolvedDependents('A');
  assert.equal(enqueued.length, 1, 'mesmo conjunto: não re-dispara (blockerSetHash)');

  // Persistiu o hash no stateJson do AgentRuntimeState de US-2.
  const row = prisma.runtime.get('US-2');
  assert.ok(row, 'linha de runtime criada');
  const state = JSON.parse(row!.stateJson) as { blockersResolvedHash?: string };
  assert.ok(state.blockersResolvedHash, 'blockerSetHash persistido');
});

test('US-BLOCK3 (c): conjunto de blockers DIFERENTE volta a disparar', async () => {
  // Story bloqueia por A; resolve (wake 1). Depois passa a depender de A+D e
  // ambos fecham → conjunto novo (hash diferente) dispara wake 2.
  const cards: CardRow[] = [
    { id: 'A', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'D', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'C', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['A'] },
    { id: 'US-2', type: 'story', columnTitle: 'In Progress' },
  ];
  const prisma = makePrisma(cards);
  const orch = makeOrchestrator(makeConfig(), prisma.svc);
  const { enqueued } = spyWakes(orch);

  await priv(orch).wakeBlockersResolvedDependents('A');
  assert.equal(enqueued.length, 1);

  // Conjunto muda para {A, D} — hash diferente do anterior.
  cards.find((c) => c.id === 'C')!.dependsOn = ['A', 'D'];
  await priv(orch).wakeBlockersResolvedDependents('D');
  assert.equal(enqueued.length, 2, 'conjunto diferente re-dispara');
});
