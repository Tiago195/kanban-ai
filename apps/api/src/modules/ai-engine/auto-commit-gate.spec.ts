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
import type { StructuredEvidence } from '@kanban-ai/shared';

/**
 * US-OBS3 (ADR-0037) — gate de auto-commit/PR OPCIONAL após validação verde.
 *
 * Cobre o DOD:
 *   - flags OFF (default)                       → skippedReason='disabled', sem commit.
 *   - opt-in + evidência não verificável        → skippedReason='not-verified'.
 *   - opt-in + verificável + SEM worktree isolado → 'no-isolated-worktree'.
 *   - opt-in + verificável + worktree isolado   → committed=true + sha.
 *
 * Invariantes: commit é feito pelo ENGINE (workspace.service), nunca pelo agent
 * (ADR-0008); só dentro do worktree ISOLADO (ADR-0035). Default OFF = no-op.
 */

function makeConfig(overrides: Partial<AppConfig['agent']> = {}): AppConfig {
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
    thrashWindow: 2,
    requireStructuredEvidence: false,
    autoCommit: false,
    autoPr: false,
    ...overrides,
  } as unknown as AppConfig['agent'];
  return { agent } as unknown as AppConfig;
}

function makeRealtime(): RealtimeService {
  return { broadcast() {} } as unknown as RealtimeService;
}

function makeValidation(): ValidationRunner {
  return { validate: async () => ({ passed: true, problems: [] }) } as unknown as ValidationRunner;
}

function makeRunner(): AgentRunner {
  return { run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner;
}

function makeMemoryIndex(): MemoryIndexService {
  return {
    query: async () => [],
    commitAndReindex: async () => ({ oid: 'x', branch: 'main', projection: {} }),
  } as unknown as MemoryIndexService;
}
function makeMemoryGit(): MemoryGitService {
  return { readNeuron: async () => null } as unknown as MemoryGitService;
}
function makeMemoryBootstrap(): MemoryBootstrapService {
  return { bootstrapFromRepo: async () => [] } as unknown as MemoryBootstrapService;
}
function makeSessions(config: AppConfig): AgentSessionManager {
  const prisma = {
    agentRuntimeState: { upsert: async () => undefined },
  } as unknown as PrismaService;
  return new AgentSessionManager(config, prisma);
}

interface WorkspacesFakeOpts {
  isolated?: { worktreePath: string; targetRepo: string; branch: string } | null;
  commitResult?: { sha: string | null; branch: string } | null;
  onCommit?: (key: string, message: string) => void;
}

function makeWorkspaces(opts: WorkspacesFakeOpts = {}): WorkspaceService {
  return {
    resolveWorkdir: async () => '/repo',
    resolveTargetRepo: (p?: string | null) => (p ? p : null),
    cleanupWorktree: async () => undefined,
    getIsolatedWorktree: () => opts.isolated ?? null,
    commitIsolatedWorktree: async (key: string, message: string) => {
      opts.onCommit?.(key, message);
      return opts.commitResult ?? null;
    },
  } as unknown as WorkspaceService;
}

function makeOrchestrator(opts: {
  config?: AppConfig;
  workspaces?: WorkspaceService;
} = {}): Orchestrator {
  const config = opts.config ?? makeConfig();
  const prisma = {
    agentRuntimeState: { upsert: async () => undefined },
    activity: { create: async () => undefined },
  } as unknown as PrismaService;
  const sessions = makeSessions(config);
  return new Orchestrator(
    prisma,
    sessions,
    makeValidation(),
    opts.workspaces ?? makeWorkspaces(),
    makeRealtime(),
    makeRunner(),
    config,
    makeMemoryIndex(),
    makeMemoryGit(),
    makeMemoryBootstrap(),
  );
}

const verifiedEvidence: StructuredEvidence = {
  checks: [{ name: 'testes', passed: true, output: '12/12' }],
};

const unverifiedEvidence: StructuredEvidence = {
  checks: [{ name: 'nota', passed: false, output: 'manual' }],
};

const failedEvidence: StructuredEvidence = {
  checks: [
    { name: 'testes', passed: true, output: 'a' },
    { name: 'lint', passed: false, output: 'b' },
  ],
};

test('flags OFF (default) -> disabled, sem commit', async () => {
  let committed = false;
  const orch = makeOrchestrator({
    config: makeConfig({ autoCommit: false }),
    workspaces: makeWorkspaces({
      isolated: { worktreePath: '/wt', targetRepo: '/repo', branch: 'kanban-ai/us-1' },
      commitResult: { sha: 'deadbeef', branch: 'kanban-ai/us-1' },
      onCommit: () => {
        committed = true;
      },
    }),
  });

  const outcome = await orch.maybeAutoCommit('US-1', 'TK-1', verifiedEvidence);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.skippedReason, 'disabled');
  assert.equal(committed, false, 'não pode chamar commit com flag OFF');
});

test('opt-in + evidência não verificável -> not-verified', async () => {
  const orch = makeOrchestrator({
    config: makeConfig({ autoCommit: true }),
    workspaces: makeWorkspaces({
      isolated: { worktreePath: '/wt', targetRepo: '/repo', branch: 'b' },
    }),
  });

  const outcome = await orch.maybeAutoCommit('US-1', 'TK-1', unverifiedEvidence);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.skippedReason, 'not-verified');
});

test('opt-in + algum check falhou -> not-verified', async () => {
  const orch = makeOrchestrator({
    config: makeConfig({ autoCommit: true }),
    workspaces: makeWorkspaces({
      isolated: { worktreePath: '/wt', targetRepo: '/repo', branch: 'b' },
    }),
  });

  const outcome = await orch.maybeAutoCommit('US-1', 'TK-1', failedEvidence);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.skippedReason, 'not-verified');
});

test('opt-in + verificável + SEM worktree isolado -> no-isolated-worktree', async () => {
  const orch = makeOrchestrator({
    config: makeConfig({ autoCommit: true }),
    workspaces: makeWorkspaces({ isolated: null }),
  });

  const outcome = await orch.maybeAutoCommit('US-1', 'TK-1', verifiedEvidence);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.skippedReason, 'no-isolated-worktree');
});

test('opt-in + verificável + worktree isolado -> committed=true + sha', async () => {
  let calledKey = '';
  const orch = makeOrchestrator({
    config: makeConfig({ autoCommit: true }),
    workspaces: makeWorkspaces({
      isolated: { worktreePath: '/wt', targetRepo: '/repo', branch: 'kanban-ai/us-1' },
      commitResult: { sha: 'abc123def456', branch: 'kanban-ai/us-1' },
      onCommit: (key) => {
        calledKey = key;
      },
    }),
  });

  const outcome = await orch.maybeAutoCommit('US-1', 'TK-1', verifiedEvidence);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.commitSha, 'abc123def456');
  assert.equal(outcome.branch, 'kanban-ai/us-1');
  assert.equal(calledKey, 'US-1');
});

test('opt-in + worktree isolado sem mudanças -> nothing-to-commit', async () => {
  const orch = makeOrchestrator({
    config: makeConfig({ autoCommit: true }),
    workspaces: makeWorkspaces({
      isolated: { worktreePath: '/wt', targetRepo: '/repo', branch: 'b' },
      commitResult: { sha: null, branch: 'b' },
    }),
  });

  const outcome = await orch.maybeAutoCommit('US-1', 'TK-1', verifiedEvidence);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.skippedReason, 'nothing-to-commit');
});
