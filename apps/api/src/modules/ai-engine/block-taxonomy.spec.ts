import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator } from './orchestrator';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';

/**
 * EP-BLOCK / US-BLOCK1 (ADR-0039) — taxonomia typed de bloqueio.
 *
 * Estratégia (mesma da orchestrator-guards.spec): instanciamos o Orchestrator
 * com fakes leves e exercitamos os caminhos que gravam `Card.blockKind`:
 *   - escalateToHuman(...) grava blockKind='capability' (default) + needsHuman.
 *   - setExecState(taskId, 'blocked-dep') grava blockKind='dependency'.
 *   - sair de blocked-dep para outro estado LIMPA blockKind (=null).
 *
 * São todos aditivos/retrocompatíveis: needsHuman/needsHumanReason continuam.
 */

interface RecordedBroadcast {
  type: string;
  [k: string]: unknown;
}

function makeRealtime(): { svc: RealtimeService; events: RecordedBroadcast[] } {
  const events: RecordedBroadcast[] = [];
  const svc = {
    broadcast(event: RecordedBroadcast) {
      events.push(event);
    },
  } as unknown as RealtimeService;
  return { svc, events };
}

function makeConfig(): AppConfig {
  const agent = {
    maxConcurrentSessions: 3,
    watchdogIntervalMs: 120_000,
    autoStepIntervalMs: 1_500,
    hitlTimeoutMs: 600_000,
    maxValidationFailures: 3,
    maxIterationsPerTask: 30,
    maxUnproductiveIterations: 0,
    maxDerivedDepth: 3,
    maxDerivedPerProblem: 2,
    maxTaskDurationMs: 0,
    maxTaskTokens: 0,
    serializeByRepo: false,
    thrashDetectionEnabled: false,
    thrashSimilarityThreshold: 0.9,
    thrashWindow: 3,
    maxConsecutiveBlocks: 0,
  };
  return { agent } as unknown as AppConfig;
}

interface FakePrisma {
  svc: PrismaService;
  updates: Array<{ where: unknown; data: Record<string, unknown> }>;
}

function makePrisma(cardFindUnique?: () => Promise<unknown>): FakePrisma {
  const updates: FakePrisma['updates'] = [];
  const svc = {
    activity: { create: async () => undefined },
    iteration: { findMany: async () => [], count: async () => 0 },
    agentMessage: { create: async () => undefined, findFirst: async () => null, findMany: async () => [] },
    card: {
      findUnique: cardFindUnique ?? (async () => ({ derivedDepth: 0 })),
      findMany: async () => [],
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return args.data;
      },
      count: async () => 0,
    },
    column: { findFirst: async () => null, findMany: async () => [] },
    label: { findFirst: async () => null },
    board: { findUnique: async () => ({ id: 'b1', seq: 1 }), update: async () => undefined },
    taskDependency: { create: async () => undefined },
    agentRuntimeState: {
      findUnique: async () => null,
      upsert: async () => undefined,
      updateMany: async () => ({ count: 0 }),
    },
    dodItem: { count: async () => 0 },
    assignee: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(svc),
  } as unknown as PrismaService;
  return { svc, updates };
}

function makeOrchestrator(prisma: FakePrisma) {
  const config = makeConfig();
  const sessionPrisma = { agentRuntimeState: { upsert: async () => undefined } } as unknown as PrismaService;
  const sessions = new AgentSessionManager(config, sessionPrisma);
  const realtime = makeRealtime();
  const orch = new Orchestrator(
    prisma.svc,
    sessions,
    { validate: async () => ({ passed: true, problems: [] }) } as unknown as ValidationRunner,
    {
      resolveWorkdir: async () => '/repo',
      resolveTargetRepo: (p?: string | null) => (p ? p : null),
      cleanupWorktree: async () => undefined,
    } as unknown as WorkspaceService,
    realtime.svc,
    { run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner,
    config,
    undefined,
    undefined as unknown as ConstructorParameters<typeof Orchestrator>[8],
  );
  return { orch, realtime };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (orch: Orchestrator) => orch as unknown as any;

test('escalateToHuman: grava blockKind=capability por default + needsHuman', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma);
  await priv(orch).escalateToHuman('task-1', 'story-1', 'motivo', 'log');
  const u = prisma.updates.find((x) => (x.data as { needsHuman?: boolean }).needsHuman === true);
  assert.ok(u, 'deve marcar needsHuman=true');
  assert.equal((u!.data as { blockKind?: string }).blockKind, 'capability');
});

test('escalateToHuman: respeita blockKind explícito', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma);
  await priv(orch).escalateToHuman('task-1', 'story-1', 'motivo', 'log', 'needs_input');
  const u = prisma.updates.find((x) => (x.data as { needsHuman?: boolean }).needsHuman === true);
  assert.ok(u);
  assert.equal((u!.data as { blockKind?: string }).blockKind, 'needs_input');
});

test('setExecState(blocked-dep): grava blockKind=dependency', async () => {
  const prisma = makePrisma(async () => ({ execState: 'idle' }));
  const { orch } = makeOrchestrator(prisma);
  await priv(orch).setExecState('task-1', 'blocked-dep');
  const u = prisma.updates.find((x) => (x.data as { blockKind?: string }).blockKind === 'dependency');
  assert.ok(u, 'deve gravar blockKind=dependency ao entrar em blocked-dep');
});

test('setExecState: sair de blocked-dep limpa blockKind (=null)', async () => {
  const prisma = makePrisma(async () => ({ execState: 'blocked_dep' }));
  const { orch } = makeOrchestrator(prisma);
  await priv(orch).setExecState('task-1', 'implementing');
  const u = prisma.updates.find((x) => 'blockKind' in (x.data as object));
  assert.ok(u, 'deve tocar blockKind ao sair de blocked-dep');
  assert.equal((u!.data as { blockKind?: string | null }).blockKind, null);
});

test('setExecState: transição não-dep não mexe em blockKind', async () => {
  const prisma = makePrisma(async () => ({ execState: 'analyzing' }));
  const { orch } = makeOrchestrator(prisma);
  await priv(orch).setExecState('task-1', 'implementing');
  const u = prisma.updates.find((x) => 'blockKind' in (x.data as object));
  assert.equal(u, undefined, 'não deve tocar blockKind numa transição comum');
});
