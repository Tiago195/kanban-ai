import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator } from './orchestrator';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner, AgentRunResult } from './runners/agent-runner.interface';
import type { CompletionMetadata } from '@kanban-ai/shared';

/**
 * EP-CTX (ADR-0040) — enriquecimento de contexto no re-dispatch.
 *
 * Cobre as 3 stories via white-box no Orchestrator (mesma estratégia da
 * orchestrator-guards / block-taxonomy specs):
 *   - US-CTX1: buildContext.priorAttempt + injeção "Tentativa anterior".
 *   - US-CTX2: writeCompletionMetadata grava Card.completionMetadata;
 *     buildPrompt injeta "Handoff estruturado".
 *   - US-CTX3: classifyRunLiveness (função pura) + applyContinuationPolicy
 *     (incrementa/zera contador, respeita cap, limpa motivo).
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

function makeConfig(continuationCap = 2): AppConfig {
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
    continuationCap,
    continuationDelayMs: 10,
    wakeupQueueEnabled: false,
  };
  return { agent } as unknown as AppConfig;
}

interface FakePrisma {
  svc: PrismaService;
  updates: Array<{ where: unknown; data: Record<string, unknown> }>;
  runtimeUpserts: Array<{ where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }>;
  runtimeUpdateManys: Array<{ where: unknown; data: Record<string, unknown> }>;
}

function makePrisma(opts?: {
  cardUpdate?: FakePrisma['updates'];
  runtimeFindUnique?: () => Promise<unknown>;
}): FakePrisma {
  const updates: FakePrisma['updates'] = opts?.cardUpdate ?? [];
  const runtimeUpserts: FakePrisma['runtimeUpserts'] = [];
  const runtimeUpdateManys: FakePrisma['runtimeUpdateManys'] = [];
  const svc = {
    activity: { create: async () => undefined },
    iteration: { findMany: async () => [], findFirst: async () => null, count: async () => 0 },
    agentMessage: { create: async () => undefined, findFirst: async () => null, findMany: async () => [] },
    card: {
      findUnique: async () => ({ derivedDepth: 0 }),
      findMany: async () => [],
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return args.data;
      },
      count: async () => 0,
    },
    agentRuntimeState: {
      findUnique: opts?.runtimeFindUnique ?? (async () => null),
      update: async () => undefined,
      upsert: async (args: { where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        runtimeUpserts.push(args);
        return undefined;
      },
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        runtimeUpdateManys.push(args);
        return { count: 1 };
      },
    },
    dodItem: { count: async () => 0 },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(svc),
  } as unknown as PrismaService;
  return { svc, updates, runtimeUpserts, runtimeUpdateManys };
}

function makeOrchestrator(prisma: FakePrisma, config = makeConfig()) {
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

function runResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    detail: '',
    summary: '',
    dodTouched: [],
    nextStep: '',
    done: false,
    ...overrides,
  };
}

// ── US-CTX3: classifyRunLiveness (função pura) ─────────────────────────────

test('classifyRunLiveness: fatalError → failed', () => {
  const { orch } = makeOrchestrator(makePrisma());
  const r = priv(orch).classifyRunLiveness(runResult({ fatalError: 'boom' }), '', [], 'implementing');
  assert.equal(r, 'failed');
});

test('classifyRunLiveness: done/handoffState=done → completed', () => {
  const { orch } = makeOrchestrator(makePrisma());
  assert.equal(priv(orch).classifyRunLiveness(runResult({ done: true }), '', [], 'done'), 'completed');
});

test('classifyRunLiveness: handoffState=blocked → blocked', () => {
  const { orch } = makeOrchestrator(makePrisma());
  assert.equal(priv(orch).classifyRunLiveness(runResult(), '', [], 'blocked'), 'blocked');
});

test('classifyRunLiveness: awaiting-input → needs_followup', () => {
  const { orch } = makeOrchestrator(makePrisma());
  assert.equal(priv(orch).classifyRunLiveness(runResult(), '', [], 'awaiting-input'), 'needs_followup');
});

test('classifyRunLiveness: diff não-vazio → advanced', () => {
  const { orch } = makeOrchestrator(makePrisma());
  assert.equal(priv(orch).classifyRunLiveness(runResult(), 'diff --git a b', [], 'implementing'), 'advanced');
});

test('classifyRunLiveness: touched não-vazio → advanced', () => {
  const { orch } = makeOrchestrator(makePrisma());
  assert.equal(priv(orch).classifyRunLiveness(runResult(), '', ['dod-1'], 'implementing'), 'advanced');
});

test('classifyRunLiveness: só summary/nextStep sem diff → plan_only', () => {
  const { orch } = makeOrchestrator(makePrisma());
  assert.equal(
    priv(orch).classifyRunLiveness(runResult({ summary: 'planejei X', nextStep: 'implementar' }), '', [], 'implementing'),
    'plan_only',
  );
});

test('classifyRunLiveness: nada → empty_response', () => {
  const { orch } = makeOrchestrator(makePrisma());
  assert.equal(priv(orch).classifyRunLiveness(runResult(), '', [], 'implementing'), 'empty_response');
});

// ── US-CTX3: applyContinuationPolicy ───────────────────────────────────────

test('applyContinuationPolicy: plan_only dentro do cap incrementa e grava motivo', async () => {
  const prisma = makePrisma({ runtimeFindUnique: async () => ({ continuationAttempt: 0 }) });
  const { orch } = makeOrchestrator(prisma);
  await priv(orch).applyContinuationPolicy('story-1', 'plan_only', runResult({ nextStep: 'implementar Y' }));
  assert.equal(prisma.runtimeUpserts.length, 1);
  const up = prisma.runtimeUpserts[0].update as { continuationAttempt: number; livenessReason: string };
  assert.equal(up.continuationAttempt, 1);
  assert.match(up.livenessReason, /implementar Y|PLANEJOU/);
});

test('applyContinuationPolicy: no cap NÃO faz upsert, limpa motivo', async () => {
  const prisma = makePrisma({ runtimeFindUnique: async () => ({ continuationAttempt: 2 }) });
  const { orch } = makeOrchestrator(prisma, makeConfig(2));
  await priv(orch).applyContinuationPolicy('story-1', 'plan_only', runResult());
  assert.equal(prisma.runtimeUpserts.length, 0, 'não deve empurrar mais continuação');
  // Limpa o motivo via card? Não — via agentRuntimeState.update. Verificamos que
  // NÃO houve upsert com incremento.
});

test('applyContinuationPolicy: advanced zera contador (updateMany reset)', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma);
  await priv(orch).applyContinuationPolicy('story-1', 'advanced', runResult());
  assert.equal(prisma.runtimeUpserts.length, 0);
  assert.equal(prisma.runtimeUpdateManys.length, 1);
  const data = prisma.runtimeUpdateManys[0].data as { continuationAttempt: number; livenessReason: null };
  assert.equal(data.continuationAttempt, 0);
  assert.equal(data.livenessReason, null);
});

test('applyContinuationPolicy: cap=0 (desligado) só reseta', async () => {
  const prisma = makePrisma({ runtimeFindUnique: async () => ({ continuationAttempt: 0 }) });
  const { orch } = makeOrchestrator(prisma, makeConfig(0));
  await priv(orch).applyContinuationPolicy('story-1', 'plan_only', runResult());
  assert.equal(prisma.runtimeUpserts.length, 0);
  assert.equal(prisma.runtimeUpdateManys.length, 1, 'deve resetar estado residual');
});

// ── US-CTX2: writeCompletionMetadata ───────────────────────────────────────

test('writeCompletionMetadata: grava changed_files (flows+evidence, dedup) e verification', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma);
  const context = {
    files: ['a.ts', 'b.ts'],
  } as unknown as Awaited<ReturnType<Orchestrator['buildContext']>>;
  const rr = runResult({
    summary: 'fiz X',
    evidence: { checks: [{ name: 'test', passed: true }], filesChanged: ['b.ts', 'c.ts'] },
    nextStep: 'nada',
  });
  await priv(orch).writeCompletionMetadata('task-1', context, rr);
  const u = prisma.updates.find((x) => 'completionMetadata' in (x.data as object));
  assert.ok(u, 'deve gravar completionMetadata');
  const meta = (u!.data as { completionMetadata: CompletionMetadata }).completionMetadata;
  assert.deepEqual([...meta.changed_files!].sort(), ['a.ts', 'b.ts', 'c.ts']);
  assert.match(meta.verification!, /test: passed/);
});

test('writeCompletionMetadata: sem evidence estruturada usa summary como verification', async () => {
  const prisma = makePrisma();
  const { orch } = makeOrchestrator(prisma);
  const context = { files: [] } as unknown as Awaited<ReturnType<Orchestrator['buildContext']>>;
  await priv(orch).writeCompletionMetadata('task-1', context, runResult({ summary: 'resumo livre' }));
  const u = prisma.updates.find((x) => 'completionMetadata' in (x.data as object));
  const meta = (u!.data as { completionMetadata: CompletionMetadata }).completionMetadata;
  assert.equal(meta.verification, 'resumo livre');
});

// ── US-CTX1 + US-CTX2 + US-CTX3: injeção no buildPrompt ────────────────────

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    taskTitle: 'T',
    project: '',
    notes: '',
    flowNames: [],
    files: [],
    storyId: 's1',
    affectedFlows: [],
    dodItems: [],
    iterationHistory: [],
    siblingHandoffs: [],
    epicNotes: [],
    lastDiff: '',
    taskDescription: '',
    storyContext: null,
    epicContext: null,
    priorAttempt: null,
    parentHandoffs: [],
    continuationReason: null,
    ...overrides,
  } as unknown as Awaited<ReturnType<Orchestrator['buildContext']>>;
}

const profile = { id: 'p', name: 'P', firstStep: 'go', phases: [{ id: 'implementing' }] } as any;

test('buildPrompt: injeta bloco de tentativa anterior (US-CTX1)', () => {
  const { orch } = makeOrchestrator(makePrisma());
  const ctx = baseContext({ priorAttempt: { lastError: 'ENOENT', lastOutcome: 'error' } });
  const prompt = priv(orch).buildPrompt(profile.phases[0], profile, ctx);
  assert.match(prompt, /Tentativa anterior/);
  assert.match(prompt, /ENOENT/);
  assert.match(prompt, /Outcome da última iteração: error/);
});

test('buildPrompt: injeta handoff estruturado (US-CTX2)', () => {
  const { orch } = makeOrchestrator(makePrisma());
  const ctx = baseContext({
    parentHandoffs: [
      { key: 'TK-1', title: 'irmã', metadata: { changed_files: ['x.ts'], verification: 'test: passed', residual_risk: 'flaky' } },
    ],
  });
  const prompt = priv(orch).buildPrompt(profile.phases[0], profile, ctx);
  assert.match(prompt, /Handoff estruturado/);
  assert.match(prompt, /TK-1 — irmã/);
  assert.match(prompt, /x\.ts/);
  assert.match(prompt, /Risco residual: flaky/);
});

test('buildPrompt: injeta continuação direcionada (US-CTX3)', () => {
  const { orch } = makeOrchestrator(makePrisma());
  const ctx = baseContext({ continuationReason: 'execute o próximo passo agora' });
  const prompt = priv(orch).buildPrompt(profile.phases[0], profile, ctx);
  assert.match(prompt, /Continuação direcionada/);
  assert.match(prompt, /execute o próximo passo agora/);
});

test('buildPrompt: sem enriquecimento não injeta nenhum bloco CTX', () => {
  const { orch } = makeOrchestrator(makePrisma());
  const prompt = priv(orch).buildPrompt(profile.phases[0], profile, baseContext());
  assert.doesNotMatch(prompt, /Tentativa anterior|Handoff estruturado|Continuação direcionada/);
});
