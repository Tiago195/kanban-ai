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
 * EP-BLOCK / US-BLOCK4 (ADR-0039) — loop-breaker de recorrência de bloqueio
 * (cross-run). Exercita os helpers duráveis `recordBlockRecurrence` (conta a
 * MESMA causa; reseta para 1 quando a causa muda; escala na N-ésima) e
 * `resetBlockRecurrence` (zera ao concluir a story). O estado vive em
 * `AgentRuntimeState` (durável, sobrevive a recovery/restart), aqui simulado
 * por uma linha em memória — cobrindo o cenário bloqueia → recovery → bloqueia
 * mesma causa → escala.
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

function makeConfig(maxConsecutiveBlocks: number): AppConfig {
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
    maxConsecutiveBlocks,
  };
  return { agent } as unknown as AppConfig;
}

interface RuntimeRow {
  lastBlockReason: string | null;
  consecutiveBlockCount: number;
}

interface FakePrisma {
  svc: PrismaService;
  runtime: Map<string, RuntimeRow>;
  cardUpdates: Array<Record<string, unknown>>;
}

/** Prisma fake com um `AgentRuntimeState` em memória (durável entre chamadas). */
function makePrisma(): FakePrisma {
  const runtime = new Map<string, RuntimeRow>();
  const cardUpdates: FakePrisma['cardUpdates'] = [];
  const svc = {
    activity: { create: async () => undefined },
    agentMessage: { create: async () => undefined, findFirst: async () => null },
    card: {
      findUnique: async () => ({ execState: 'idle', parentId: 'story-1' }),
      update: async (args: { data: Record<string, unknown> }) => {
        cardUpdates.push(args.data);
        return args.data;
      },
      count: async () => 0,
    },
    column: { findFirst: async () => null },
    agentRuntimeState: {
      findUnique: async (args: { where: { storyId: string } }) =>
        runtime.get(args.where.storyId) ?? null,
      upsert: async (args: {
        where: { storyId: string };
        create: RuntimeRow;
        update: RuntimeRow;
      }) => {
        const key = args.where.storyId;
        if (runtime.has(key)) {
          runtime.set(key, { ...runtime.get(key)!, ...args.update });
        } else {
          runtime.set(key, {
            lastBlockReason: args.create.lastBlockReason,
            consecutiveBlockCount: args.create.consecutiveBlockCount,
          });
        }
        return runtime.get(key);
      },
      updateMany: async (args: { where: { storyId: string }; data: Partial<RuntimeRow> }) => {
        const row = runtime.get(args.where.storyId);
        if (row) runtime.set(args.where.storyId, { ...row, ...args.data });
        return { count: row ? 1 : 0 };
      },
    },
  } as unknown as PrismaService;
  return { svc, runtime, cardUpdates };
}

function makeOrchestrator(prisma: FakePrisma, maxConsecutiveBlocks: number) {
  const config = makeConfig(maxConsecutiveBlocks);
  const sessionPrisma = {
    agentRuntimeState: { upsert: async () => undefined },
  } as unknown as PrismaService;
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

test('recordBlockRecurrence: mesma causa incrementa o contador', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma, 5);
  await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  const row = prisma.runtime.get('story-1')!;
  assert.equal(row.consecutiveBlockCount, 2, 'mesma causa deve incrementar');
});

test('recordBlockRecurrence: causa diferente reseta para 1', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma, 5);
  await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  await priv(orch).recordBlockRecurrence('story-1', 'capability', 'motivo diferente');
  const row = prisma.runtime.get('story-1')!;
  assert.equal(row.consecutiveBlockCount, 1, 'causa diferente deve resetar para 1');
});

test('recordBlockRecurrence: N-ésima recorrência sinaliza escalar (cross-run)', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma, 2);
  const first = await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  assert.equal(first, false, '1ª ocorrência não escala');
  // simula recovery/restart: o estado persiste em runtime (durável).
  const second = await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  assert.equal(second, true, '2ª ocorrência da MESMA causa deve escalar');
});

test('recordBlockRecurrence: cap<=0 desliga o gate', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma, 0);
  const r = await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  assert.equal(r, false, 'gate desligado nunca escala');
  assert.equal(prisma.runtime.size, 0, 'gate desligado não toca o estado durável');
});

test('resetBlockRecurrence: zera o contador ao concluir a story', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma, 5);
  await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  await priv(orch).recordBlockRecurrence('story-1', 'dependency', 'dependency:task-1');
  await priv(orch).resetBlockRecurrence('story-1');
  const row = prisma.runtime.get('story-1')!;
  assert.equal(row.consecutiveBlockCount, 0, 'complete zera o contador');
  assert.equal(row.lastBlockReason, null, 'complete limpa a última causa');
});

test('setExecState(blocked-dep) recorrente escala a humano na N-ésima vez', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma, 2);
  // 1º blocked-dep: card em idle → entra em blocked-dep (conta 1, não escala).
  await priv(orch).setExecState('task-1', 'blocked-dep');
  // saiu de blocked-dep (unblock) e re-bloqueou: 2ª entrada da MESMA causa.
  await priv(orch).setExecState('task-1', 'blocked-dep');
  const escalated = prisma.cardUpdates.find(
    (d) => (d as { needsHuman?: boolean }).needsHuman === true,
  );
  assert.ok(escalated, '2ª recorrência de dependência deve escalar (needsHuman=true)');
  assert.equal((escalated as { blockKind?: string }).blockKind, 'dependency');
});
