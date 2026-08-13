import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator } from './orchestrator';
import type { MemoryIndexService } from '../memory/memory-index.service';
import type { MemoryGitService } from '../memory/memory-git.service';
import type { MemoryBootstrapService } from '../memory/memory-bootstrap.service';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';
import type { WakeupQueueService } from './wakeup-queue.service';
import type { BlockedDescriptor } from '@kanban-ai/shared';

/**
 * EP-BLOCK / US-BLOCK2 (ADR-0039) — routable blocked: unblock descriptor +
 * auto-notify owner.
 *
 * Estratégia (mesma de orchestrator-guards.spec / block-taxonomy.spec):
 * instanciamos o Orchestrator com fakes leves e exercitamos `routeBlockedCard`
 * e `setExecState` (reset do anti re-fire). Um `WakeupQueueService` fake registra
 * as chamadas de `enqueue`; o coalescing real da fila (Postgres) não é exercido
 * aqui — a idempotência a nível de card vem de `blockedOwnerNotifiedAt`.
 *
 * Cobre:
 *   (a) owner=agent dispara EXATAMENTE 1 wake `issue_unblock`.
 *   (b) dois blocks seguidos NÃO geram 2 wakes (blockedOwnerNotifiedAt).
 *   (c) owner=board → needsHuman, sem wake.
 *   (d) sem descriptor (prose-only) → needsHuman, sem wake.
 *   (e) reset de blockedOwnerNotifiedAt ao sair de blocked.
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
    // US-BLOCK2: a fila precisa estar ON para o wake de unblock ser enfileirado.
    wakeupQueueEnabled: true,
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
      findUnique: cardFindUnique ?? (async () => ({ blockedOwnerNotifiedAt: null })),
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
    dodItem: { count: async () => 0 },
    assignee: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(svc),
  } as unknown as PrismaService;
  return { svc, updates };
}

interface FakeWakeup {
  svc: WakeupQueueService;
  calls: Array<{ storyId: string; reason: string; epicId?: string | null }>;
}

function makeWakeup(): FakeWakeup {
  const calls: FakeWakeup['calls'] = [];
  const svc = {
    enqueue: async (input: { storyId: string; reason: string; epicId?: string | null }) => {
      calls.push(input);
    },
  } as unknown as WakeupQueueService;
  return { svc, calls };
}

function makeOrchestrator(prisma: FakePrisma, wakeup: FakeWakeup) {
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
    { query: async () => [], commitAndReindex: async () => ({ oid: 'x', branch: 'main', projection: {} }) } as unknown as MemoryIndexService,
    { readNeuron: async () => null } as unknown as MemoryGitService,
    { bootstrapFromRepo: async () => [] } as unknown as MemoryBootstrapService,
    wakeup.svc,
    undefined as unknown as ConstructorParameters<typeof Orchestrator>[11],
  );
  return { orch, realtime };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (orch: Orchestrator) => orch as unknown as any;

test('(a) owner=agent dispara exatamente 1 wake issue_unblock', async () => {
  const prisma = makePrisma(async () => ({ blockedOwnerNotifiedAt: null }));
  const wakeup = makeWakeup();
  const { orch } = makeOrchestrator(prisma, wakeup);
  const descriptor: BlockedDescriptor = { owner: 'agent-42', action: 'resolver dependência X' };

  const res = await orch.routeBlockedCard('card-1', 'story-1', descriptor);

  assert.equal(res.routedTo, 'agent');
  assert.equal(res.wakeEnqueued, true);
  const issue = wakeup.calls.filter((c) => c.reason === 'issue_unblock');
  assert.equal(issue.length, 1, 'deve enfileirar exatamente 1 wake issue_unblock');
  assert.equal(issue[0].storyId, 'story-1');
  // grava o descriptor + marca blockedOwnerNotifiedAt.
  const u = prisma.updates.find((x) => 'blockedOwnerNotifiedAt' in (x.data as object));
  assert.ok(u, 'deve gravar blockedOwnerNotifiedAt');
  assert.ok((u!.data as { blockedOwnerNotifiedAt?: Date }).blockedOwnerNotifiedAt instanceof Date);
  assert.deepEqual((u!.data as { blockedDescriptor?: unknown }).blockedDescriptor, descriptor);
});

test('(b) dois blocks seguidos NÃO geram 2 wakes (blockedOwnerNotifiedAt anti re-fire)', async () => {
  // O card JÁ foi notificado (blockedOwnerNotifiedAt no futuro relativo à entrada
  // em blocked) — simula o segundo block dentro do mesmo bloqueio.
  const notified = new Date(Date.now() + 60_000);
  const prisma = makePrisma(async () => ({ blockedOwnerNotifiedAt: notified }));
  const wakeup = makeWakeup();
  const { orch } = makeOrchestrator(prisma, wakeup);
  const descriptor: BlockedDescriptor = { owner: 'agent-42', action: 'resolver dependência X' };

  const enteredAt = new Date();
  const res = await orch.routeBlockedCard('card-1', 'story-1', descriptor, enteredAt);

  assert.equal(res.routedTo, 'agent');
  assert.equal(res.wakeEnqueued, false, 'não deve re-notificar quando já notificado neste bloqueio');
  assert.equal(
    wakeup.calls.filter((c) => c.reason === 'issue_unblock').length,
    0,
    'nenhum wake extra deve ser enfileirado',
  );
});

test('(b2) sequência real: 1º block notifica, 2º block coalesce (sem 2º wake)', async () => {
  // Estado do card evolui: 1ª chamada vê null; 2ª vê o notifiedAt gravado.
  let notifiedAt: Date | null = null;
  const svc = {
    activity: { create: async () => undefined },
    card: {
      findUnique: async () => ({ blockedOwnerNotifiedAt: notifiedAt }),
      update: async (args: { data: Record<string, unknown> }) => {
        if ('blockedOwnerNotifiedAt' in args.data) {
          const v = (args.data as { blockedOwnerNotifiedAt?: Date | null }).blockedOwnerNotifiedAt;
          if (v instanceof Date) notifiedAt = v;
        }
        return args.data;
      },
    },
    board: { findUnique: async () => ({ id: 'b1', seq: 1 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(svc),
  } as unknown as PrismaService;
  const prisma: FakePrisma = { svc, updates: [] };
  const wakeup = makeWakeup();
  const { orch } = makeOrchestrator(prisma, wakeup);
  const descriptor: BlockedDescriptor = { owner: 'agent-42', action: 'resolver X' };

  const enteredAt = new Date(Date.now() - 5_000);
  const first = await orch.routeBlockedCard('card-1', 'story-1', descriptor, enteredAt);
  const second = await orch.routeBlockedCard('card-1', 'story-1', descriptor, enteredAt);

  assert.equal(first.wakeEnqueued, true);
  assert.equal(second.wakeEnqueued, false);
  assert.equal(
    wakeup.calls.filter((c) => c.reason === 'issue_unblock').length,
    1,
    'exatamente 1 wake para dois blocks seguidos no mesmo bloqueio',
  );
});

test('(c) owner=board → needsHuman, sem wake', async () => {
  const prisma = makePrisma();
  const wakeup = makeWakeup();
  const { orch, realtime } = makeOrchestrator(prisma, wakeup);
  const descriptor: BlockedDescriptor = { owner: 'board', action: 'decisão de produto' };

  const res = await orch.routeBlockedCard('card-1', 'story-1', descriptor);

  assert.equal(res.routedTo, 'human');
  assert.equal(res.wakeEnqueued, false);
  assert.equal(wakeup.calls.length, 0, 'owner=board não enfileira wake');
  const u = prisma.updates.find((x) => (x.data as { needsHuman?: boolean }).needsHuman === true);
  assert.ok(u, 'owner=board deve marcar needsHuman');
  assert.ok(realtime.events.some((e) => e.type === 'card.needs_human'));
});

test('(d) sem descriptor (prose-only) → needsHuman, sem wake', async () => {
  const prisma = makePrisma();
  const wakeup = makeWakeup();
  const { orch } = makeOrchestrator(prisma, wakeup);

  const res = await orch.routeBlockedCard('card-1', 'story-1', null);

  assert.equal(res.routedTo, 'human');
  assert.equal(res.wakeEnqueued, false);
  assert.equal(wakeup.calls.length, 0, 'prose-only não enfileira wake');
  const u = prisma.updates.find((x) => (x.data as { needsHuman?: boolean }).needsHuman === true);
  assert.ok(u, 'prose-only deve marcar needsHuman');
});

test('(d2) descriptor malformado (owner vazio / action vazia) → needsHuman, sem wake', async () => {
  const wakeup = makeWakeup();

  const p1 = makePrisma();
  const r1 = await makeOrchestrator(p1, wakeup).orch.routeBlockedCard('c1', 's1', {
    owner: '',
    action: 'x',
  } as BlockedDescriptor);
  assert.equal(r1.routedTo, 'human');

  const p2 = makePrisma();
  const r2 = await makeOrchestrator(p2, wakeup).orch.routeBlockedCard('c2', 's1', {
    owner: 'agent-1',
    action: '',
  } as BlockedDescriptor);
  assert.equal(r2.routedTo, 'human');

  assert.equal(wakeup.calls.length, 0, 'descriptor malformado nunca enfileira wake');
});

test('(e) setExecState: sair de blocked-dep reseta blockedOwnerNotifiedAt (=null)', async () => {
  const prisma = makePrisma(async () => ({ execState: 'blocked_dep' }));
  const wakeup = makeWakeup();
  const { orch } = makeOrchestrator(prisma, wakeup);

  await priv(orch).setExecState('card-1', 'implementing');

  const u = prisma.updates.find((x) => 'blockedOwnerNotifiedAt' in (x.data as object));
  assert.ok(u, 'deve tocar blockedOwnerNotifiedAt ao sair de blocked-dep');
  assert.equal((u!.data as { blockedOwnerNotifiedAt?: Date | null }).blockedOwnerNotifiedAt, null);
});

test('(e2) setExecState: transição comum NÃO mexe em blockedOwnerNotifiedAt', async () => {
  const prisma = makePrisma(async () => ({ execState: 'analyzing' }));
  const wakeup = makeWakeup();
  const { orch } = makeOrchestrator(prisma, wakeup);

  await priv(orch).setExecState('card-1', 'implementing');

  const u = prisma.updates.find((x) => 'blockedOwnerNotifiedAt' in (x.data as object));
  assert.equal(u, undefined, 'não deve tocar blockedOwnerNotifiedAt numa transição comum');
});
