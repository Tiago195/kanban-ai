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
 * US-ROB4 — testes do lease/claim por execução. Prisma fake in-memory guarda as
 * linhas de AgentRuntimeState; exercitamos claimStory/renewClaim/recoverStaleClaims
 * via acesso caixa-branca aos privados do Orchestrator.
 */

interface RuntimeRow {
  sessionId: string;
  storyId: string;
  claimLock?: string | null;
  claimExpiresAt?: Date | null;
  livenessState?: string;
}

function makeClaimPrisma(seed: RuntimeRow[] = []): {
  svc: PrismaService;
  rows: Map<string, RuntimeRow>;
} {
  const rows = new Map<string, RuntimeRow>(seed.map((r) => [r.sessionId, { ...r }]));
  const svc = {
    agentRuntimeState: {
      async update(args: { where: { sessionId: string }; data: Partial<RuntimeRow> }) {
        const existing = rows.get(args.where.sessionId);
        if (!existing) throw new Error('Record to update not found.');
        rows.set(args.where.sessionId, { ...existing, ...args.data });
        return rows.get(args.where.sessionId);
      },
      async findMany(args: {
        where: { claimExpiresAt?: { lte: Date }; NOT?: { claimLock: null } };
        select?: unknown;
      }) {
        const lte = args.where.claimExpiresAt?.lte;
        return [...rows.values()]
          .filter((r) => r.claimLock != null)
          .filter((r) => (lte ? r.claimExpiresAt != null && r.claimExpiresAt <= lte : true))
          .map((r) => ({ storyId: r.storyId }));
      },
      async upsert() {
        return undefined;
      },
    },
    // resumeDeferredForStory consulta epic/column; devolvemos vazio p/ no-op.
    card: { findUnique: async () => null, findMany: async () => [] },
    column: { findMany: async () => [] },
  } as unknown as PrismaService;
  return { svc, rows };
}

function makeConfig(overrides: Partial<AppConfig['agent']> = {}): AppConfig {
  return {
    agent: {
      maxConcurrentSessions: 3,
      watchdogIntervalMs: 120_000,
      claimEnabled: true,
      claimTtlMs: 300_000,
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

test('US-ROB4: claimStory grava claimExpiresAt ≈ now + ttl', async () => {
  const { svc, rows } = makeClaimPrisma([{ sessionId: 'US-1', storyId: 'US-1' }]);
  const config = makeConfig({ claimTtlMs: 300_000 });
  const orch = makeOrchestrator(config, svc);

  const before = Date.now();
  await priv(orch).claimStory('US-1');
  const row = rows.get('US-1');
  assert.equal(row?.claimLock, 'US-1');
  const exp = row?.claimExpiresAt as Date;
  assert.ok(exp.getTime() >= before + 300_000 - 50, 'expira ~now+ttl');
  assert.ok(exp.getTime() <= Date.now() + 300_000 + 50);
});

test('US-ROB4: renewClaim estende o prazo do lease', async () => {
  const past = new Date(Date.now() - 1_000);
  const { svc, rows } = makeClaimPrisma([
    { sessionId: 'US-2', storyId: 'US-2', claimLock: 'US-2', claimExpiresAt: past },
  ]);
  const orch = makeOrchestrator(makeConfig({ claimTtlMs: 60_000 }), svc);

  await priv(orch).renewClaim('US-2');
  const exp = rows.get('US-2')?.claimExpiresAt as Date;
  assert.ok(exp.getTime() > Date.now(), 'novo prazo é futuro (renovado)');
});

test('US-ROB4: recoverStaleClaims libera SÓ linhas vencidas e marca stalled', async () => {
  const now = Date.now();
  const { svc, rows } = makeClaimPrisma([
    { sessionId: 'S-expired', storyId: 'S-expired', claimLock: 'S-expired', claimExpiresAt: new Date(now - 1) },
    { sessionId: 'S-alive', storyId: 'S-alive', claimLock: 'S-alive', claimExpiresAt: new Date(now + 60_000) },
  ]);
  const orch = makeOrchestrator(makeConfig(), svc);

  const recovered = await priv(orch).recoverStaleClaims(now);
  assert.equal(recovered, 1, 'só a vencida é recuperada');

  const expired = rows.get('S-expired');
  assert.equal(expired?.claimLock, null, 'lease liberado');
  assert.equal(expired?.claimExpiresAt, null);
  assert.equal(expired?.livenessState, 'stalled');

  const alive = rows.get('S-alive');
  assert.equal(alive?.claimLock, 'S-alive', 'sessão viva intacta');
});

test('US-ROB4: recoverStaleClaims é idempotente (2ª passada não recupera nada)', async () => {
  const now = Date.now();
  const { svc } = makeClaimPrisma([
    { sessionId: 'S-x', storyId: 'S-x', claimLock: 'S-x', claimExpiresAt: new Date(now - 1) },
  ]);
  const orch = makeOrchestrator(makeConfig(), svc);

  assert.equal(await priv(orch).recoverStaleClaims(now), 1);
  assert.equal(await priv(orch).recoverStaleClaims(now), 0, '2ª passada é no-op');
});

test('US-ROB4: claimEnabled=false desliga claim/renew/recovery', async () => {
  const now = Date.now();
  const { svc, rows } = makeClaimPrisma([
    { sessionId: 'S-off', storyId: 'S-off', claimLock: 'S-off', claimExpiresAt: new Date(now - 1) },
  ]);
  const orch = makeOrchestrator(makeConfig({ claimEnabled: false }), svc);

  await priv(orch).claimStory('S-off');
  assert.equal(rows.get('S-off')?.claimLock, 'S-off', 'claimStory é no-op (não sobrescreve)');
  assert.equal(await priv(orch).recoverStaleClaims(now), 0, 'recovery é no-op');
});

test('US-ROB4: claimStory é defensivo — linha inexistente não lança', async () => {
  const { svc } = makeClaimPrisma([]); // sem linhas
  const orch = makeOrchestrator(makeConfig(), svc);
  await assert.doesNotReject(() => priv(orch).claimStory('S-ghost'));
});
