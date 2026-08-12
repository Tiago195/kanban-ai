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
import type { MemoryIndexService } from '../memory/memory-index.service';
import type { MemoryGitService } from '../memory/memory-git.service';
import type { MemoryBootstrapService } from '../memory/memory-bootstrap.service';

/**
 * US-ROB3 — testes da promoção de dependentes READY ao fechar uma task.
 * Prisma fake in-memory modela cards (task/story), suas dependências e a coluna
 * de board da story. Exercitamos `promoteReadyDependents` via acesso caixa-branca
 * e observamos as chamadas a `onStoryEnterInProgress` (stubada).
 */

interface CardRow {
  id: string;
  type: 'task' | 'story';
  execState?: string | null;
  parentId?: string | null;
  /** ids das tasks das quais este card depende (arestas dependsOn). */
  dependsOn?: string[];
  /** título da coluna de board (só relevante para story). */
  columnTitle?: string;
  isTaskColumn?: boolean;
}

function makePrisma(cards: CardRow[]): PrismaService {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const cardShape = (c: CardRow) => ({
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
    boardColumn: c.columnTitle
      ? { title: c.columnTitle, isTaskColumn: c.isTaskColumn ?? false }
      : null,
  });
  return {
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
      async findUnique(args: { where: { id: string } }) {
        const c = byId.get(args.where.id);
        return c ? cardShape(c) : null;
      },
      async findMany(args: { where: { parentId: string } }) {
        return cards
          .filter((c) => c.type === 'task' && c.parentId === args.where.parentId)
          .map(cardShape);
      },
      async update() {
        return undefined;
      },
    },
    activity: { create: async () => undefined },
  } as unknown as PrismaService;
}

function makeConfig(overrides: Partial<AppConfig['agent']> = {}): AppConfig {
  return {
    agent: {
      maxConcurrentSessions: 3,
      watchdogIntervalMs: 120_000,
      autostartDependents: true,
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
  const workspaces = { cleanupWorktree: async () => undefined, resolveWorkdir: async () => '/repo' } as unknown as WorkspaceService;
  const validation = { validate: async () => ({ passed: true, problems: [] }) } as unknown as ValidationRunner;
  const runner = { run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner;
  const memoryIndex = { query: async () => [] } as unknown as MemoryIndexService;
  const memoryGit = { readNeuron: async () => null } as unknown as MemoryGitService;
  const memoryBootstrap = { bootstrapFromRepo: async () => [] } as unknown as MemoryBootstrapService;
  return new Orchestrator(
    prisma,
    makeSessions(config),
    validation,
    workspaces,
    realtime,
    runner,
    config,
    memoryIndex,
    memoryGit,
    memoryBootstrap,
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (orch: Orchestrator) => orch as unknown as any;

/** Stub de onStoryEnterInProgress que registra as stories acordadas. */
function spyWake(orch: Orchestrator): string[] {
  const woken: string[] = [];
  priv(orch).onStoryEnterInProgress = async (storyId: string) => {
    woken.push(storyId);
  };
  return woken;
}

test('US-ROB3: fechar pai promove dependente READY (idle) da story In Progress', async () => {
  // TK-A (done) ← TK-B depende de TK-A; TK-B idle na story US-1 (In Progress).
  const prisma = makePrisma([
    { id: 'TK-A', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'TK-B', type: 'task', execState: 'idle', parentId: 'US-1', dependsOn: ['TK-A'] },
    { id: 'US-1', type: 'story', columnTitle: 'In Progress', isTaskColumn: false },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma);
  const woken = spyWake(orch);

  await priv(orch).promoteReadyDependents('TK-A');
  assert.deepEqual(woken, ['US-1'], 'a story-dona é acordada uma vez');
});

test('US-ROB3: flag off → no-op (não acorda ninguém)', async () => {
  const prisma = makePrisma([
    { id: 'TK-A', type: 'task', execState: 'done', parentId: 'US-1' },
    { id: 'TK-B', type: 'task', execState: 'idle', parentId: 'US-1', dependsOn: ['TK-A'] },
    { id: 'US-1', type: 'story', columnTitle: 'In Progress', isTaskColumn: false },
  ]);
  const orch = makeOrchestrator(makeConfig({ autostartDependents: false }), prisma);
  const woken = spyWake(orch);

  await priv(orch).promoteReadyDependents('TK-A');
  assert.deepEqual(woken, [], 'flag off: nenhuma story acordada');
});

test('US-ROB3: dependente de story NÃO In Progress não é acordado (invariante 6)', async () => {
  const prisma = makePrisma([
    { id: 'TK-A', type: 'task', execState: 'done', parentId: 'US-2' },
    { id: 'TK-B', type: 'task', execState: 'idle', parentId: 'US-2', dependsOn: ['TK-A'] },
    { id: 'US-2', type: 'story', columnTitle: 'To Do', isTaskColumn: false },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma);
  const woken = spyWake(orch);

  await priv(orch).promoteReadyDependents('TK-A');
  assert.deepEqual(woken, [], 'story fora de In Progress não é acordada');
});

test('US-ROB3: dependente ainda com deps pendentes NÃO é promovido', async () => {
  // TK-B depende de TK-A (fechada) e TK-C (ainda idle) → não está READY.
  const prisma = makePrisma([
    { id: 'TK-A', type: 'task', execState: 'done', parentId: 'US-3' },
    { id: 'TK-C', type: 'task', execState: 'idle', parentId: 'US-3' },
    { id: 'TK-B', type: 'task', execState: 'idle', parentId: 'US-3', dependsOn: ['TK-A', 'TK-C'] },
    { id: 'US-3', type: 'story', columnTitle: 'In Progress', isTaskColumn: false },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma);
  const woken = spyWake(orch);

  await priv(orch).promoteReadyDependents('TK-A');
  assert.deepEqual(woken, [], 'com dep pendente (TK-C) não promove');
});

test('US-ROB3: story já com auto-play rodando não é re-acordada', async () => {
  const prisma = makePrisma([
    { id: 'TK-A', type: 'task', execState: 'done', parentId: 'US-4' },
    { id: 'TK-B', type: 'task', execState: 'idle', parentId: 'US-4', dependsOn: ['TK-A'] },
    { id: 'US-4', type: 'story', columnTitle: 'In Progress', isTaskColumn: false },
  ]);
  const orch = makeOrchestrator(makeConfig(), prisma);
  const woken = spyWake(orch);
  priv(orch).isAutoRunning = () => true; // já rodando

  await priv(orch).promoteReadyDependents('TK-A');
  assert.deepEqual(woken, [], 'auto-play ativo: não re-acorda (idempotente)');
});
