import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator, deriveLearningOutcome } from './orchestrator';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';
import type { ProjectGraphService } from '../projects/project-graph.service';
import { ProjectHiveService } from '../projects/project-hive.service';
import { parseMemoryDoc } from '../../shared/neuron-format';

/**
 * US-F5.2 (EP-F5) — o `outcome` do memory doc nasce do sinal REAL do loop, e
 * a escrita de learnings dispara o `graphify reflect` (best-effort).
 *
 * Duas frentes:
 *  1. `deriveLearningOutcome` (função pura) — o mapeamento sinal→outcome, um
 *     teste por valor justificável:
 *       useful    ← validação passou / task pôde concluir (canFinish);
 *       corrected ← validação reprovou (nova rodada exigida) ou reivindicação
 *                   fantasma (fluxo declarado sem diff);
 *       dead_end  ← validação reprovou E o loop escalou a humano (sem saída);
 *       unmarked  ← iteração intermediária sem sinal conclusivo (o doc sai
 *                   SEM outcome — ausência é melhor que rótulo invertido).
 *  2. `persistIterationLearnings` — escreve os docs com o outcome derivado e
 *     dispara `projectGraph.reflect(projectId)` UMA vez (fire-and-forget);
 *     falha do reflect NUNCA derruba a iteração; sem escrita, sem reflect.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROJECT_ID = 'proj-1';
const TASK_TITLE = 'Ligar o reflect';

// ═════════ 1. deriveLearningOutcome — um teste por valor do mapeamento ══════

test('US-F5.2 outcome useful: validação passou (task fecha Done)', () => {
  assert.equal(
    deriveLearningOutcome({ kind: 'validation', passed: true, escalated: false }),
    'useful',
  );
});

test('US-F5.2 outcome useful: iteração com canFinish (done crível — DOD fechado ou diff real)', () => {
  assert.equal(
    deriveLearningOutcome({ kind: 'iteration', canFinish: true, phantomClaim: false }),
    'useful',
  );
});

test('US-F5.2 outcome corrected: validação reprovou e o loop derivou correção (nova rodada)', () => {
  assert.equal(
    deriveLearningOutcome({ kind: 'validation', passed: false, escalated: false }),
    'corrected',
  );
});

test('US-F5.2 outcome corrected: reivindicação fantasma (fluxo declarado sem diff)', () => {
  assert.equal(
    deriveLearningOutcome({ kind: 'iteration', canFinish: false, phantomClaim: true }),
    'corrected',
  );
});

test('US-F5.2 outcome dead_end: validação reprovou E escalou a humano (sem saída)', () => {
  assert.equal(
    deriveLearningOutcome({ kind: 'validation', passed: false, escalated: true }),
    'dead_end',
  );
});

test('US-F5.2 sem sinal conclusivo: iteração intermediária → undefined (doc sai unmarked)', () => {
  assert.equal(
    deriveLearningOutcome({ kind: 'iteration', canFinish: false, phantomClaim: false }),
    undefined,
  );
});

// ═════════ 2. persistIterationLearnings — escrita + reflect best-effort ═════

interface Harness {
  orch: Orchestrator;
  reflected: string[];
  listMemoryDocs: () => string[];
  readMemoryDoc: (name: string) => string;
  cleanup: () => void;
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
    continuationCap: 2,
    continuationDelayMs: 10,
    wakeupQueueEnabled: false,
  };
  return { agent, graphify: { memoryRecallEnabled: false } } as unknown as AppConfig;
}

/**
 * Harness no recorte white-box de `learning-write.spec.ts`: clone fake em
 * tmpdir + ProjectHiveService REAL. O prisma resolve a cadeia
 * story→board→project (`resolveStoryProjectId`) — `withProject: false` simula
 * Board legado (projectId null → nada escrito → reflect NÃO dispara).
 */
function makeHarness(
  opts: { withProject?: boolean; reflectThrows?: boolean } = {},
): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-f5-2-reflect-'));
  const cloneRoot = path.join(root, PROJECT_ID);
  fs.mkdirSync(path.join(cloneRoot, '.git', 'info'), { recursive: true });
  const config = makeConfig();
  const hive = new ProjectHiveService({ projects: { dir: root } } as unknown as AppConfig);

  const reflected: string[] = [];
  const prisma = {
    activity: { create: async () => undefined },
    card: {
      // Serve os dois selects do fluxo: o título (question do memory doc) e o
      // boardId (resolveStoryProjectId).
      findUnique: async () => ({ title: TASK_TITLE, boardId: 'board-1' }),
    },
    board: {
      findUnique: async () => ({
        projectId: opts.withProject === false ? null : PROJECT_ID,
      }),
    },
  } as unknown as PrismaService;
  const sessionPrisma = {
    agentRuntimeState: { upsert: async () => undefined },
  } as unknown as PrismaService;
  const projectGraph = {
    incrementalEnabled: false,
    reflect: (projectId: string) => {
      if (opts.reflectThrows) throw new Error('sidecar explodiu (síncrono)');
      reflected.push(projectId);
      return Promise.resolve();
    },
  } as unknown as ProjectGraphService;

  const orch = new Orchestrator(
    prisma,
    new AgentSessionManager(config, sessionPrisma),
    { validate: async () => ({ passed: true, problems: [] }) } as unknown as ValidationRunner,
    {
      resolveWorkdir: async () => '/repo',
      resolveTargetRepo: (p?: string | null) => (p ? p : null),
      cleanupWorktree: async () => undefined,
    } as unknown as WorkspaceService,
    { broadcast: () => undefined } as unknown as RealtimeService,
    { run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner,
    config,
    undefined,
    undefined,
    undefined,
    projectGraph,
    undefined,
    undefined,
    hive,
  );
  const memDir = path.join(cloneRoot, '.hive', 'memory');
  return {
    orch,
    reflected,
    listMemoryDocs: () => {
      try {
        return fs.readdirSync(memDir).sort();
      } catch {
        return [];
      }
    },
    readMemoryDoc: (name) => fs.readFileSync(path.join(memDir, name), 'utf8'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const priv = (orch: Orchestrator) => orch as unknown as any;
/** Drena o fire-and-forget (`void Promise.resolve().then(...)`) do reflect. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('US-F5.2 escrita + reflect: dois learnings → dois docs com o outcome derivado e UM reflect', async () => {
  const h = makeHarness();
  try {
    await priv(h.orch).persistIterationLearnings(
      'tk-1',
      'story-1',
      '', // sem cwd → collectChangedFiles devolve [] (sem git na spec)
      null,
      [
        { path: 'modules/a.md', summary: 'primeiro aprendizado' },
        { path: 'modules/b.md', summary: 'segundo aprendizado' },
      ],
      'corrected',
    );
    await settle();
    const docs = h.listMemoryDocs();
    assert.equal(docs.length, 2, 'um doc por learning');
    for (const d of docs) {
      const parsed = parseMemoryDoc(h.readMemoryDoc(d));
      assert.equal(parsed!.outcome, 'corrected', 'o sinal é da iteração, igual nos dois docs');
    }
    assert.deepEqual(h.reflected, [PROJECT_ID], 'reflect UMA vez por iteração, não por learning');
  } finally {
    h.cleanup();
  }
});

test('US-F5.2 unmarked: outcome undefined → doc SEM frontmatter outcome (peso 0 no reflect)', async () => {
  const h = makeHarness();
  try {
    await priv(h.orch).persistIterationLearnings(
      'tk-2',
      'story-1',
      '',
      null,
      [{ path: 'modules/a.md', summary: 'aprendizado sem sinal ainda' }],
      undefined,
    );
    await settle();
    const docs = h.listMemoryDocs();
    assert.equal(docs.length, 1);
    const raw = h.readMemoryDoc(docs[0]);
    assert.equal(parseMemoryDoc(raw)!.outcome, undefined);
    assert.ok(!raw.includes('outcome:'), 'nenhuma linha outcome no frontmatter');
    // Doc escrito → o reflect dispara mesmo assim (o unmarked entra no total).
    assert.deepEqual(h.reflected, [PROJECT_ID]);
  } finally {
    h.cleanup();
  }
});

test('US-F5.2 best-effort: reflect explodindo (até síncrono) NÃO derruba a iteração', async () => {
  const h = makeHarness({ reflectThrows: true });
  try {
    // Se persistIterationLearnings lançasse, o await rejeitaria e o teste falharia.
    await priv(h.orch).persistIterationLearnings(
      'tk-3',
      'story-1',
      '',
      null,
      [{ path: 'modules/a.md', summary: 'aprendizado com sidecar quebrado' }],
      'useful',
    );
    await settle();
    assert.equal(h.listMemoryDocs().length, 1, 'a escrita do doc não é afetada');
  } finally {
    h.cleanup();
  }
});

test('US-F5.2 sem escrita, sem reflect: Board legado (sem Project) não dispara nada', async () => {
  const h = makeHarness({ withProject: false });
  try {
    await priv(h.orch).persistIterationLearnings(
      'tk-4',
      'story-1',
      '',
      null,
      [{ path: 'modules/a.md', summary: 'aprendizado perdido (sem Project)' }],
      'useful',
    );
    await settle();
    assert.equal(h.listMemoryDocs().length, 0);
    assert.deepEqual(h.reflected, [], 'nada escrito → nenhum reflect');
  } finally {
    h.cleanup();
  }
});
