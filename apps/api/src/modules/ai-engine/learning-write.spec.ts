import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator, cutLearningFiles } from './orchestrator';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';
import type { ProjectGraphService } from '../projects/project-graph.service';
import { ProjectHiveService } from '../projects/project-hive.service';
import { parseMemoryDoc } from '../../shared/neuron-format';

/**
 * US-F2.6 → US-F2.3 → US-F5.1 — a escrita de learnings no formato CANÔNICO
 * do graphify: cada learning vira UM memory doc em `<clone>/.hive/memory/`
 * (plano — o `graphify reflect` faz glob não-recursivo), com frontmatter
 * `type/date/question/outcome/contributor/source_nodes` que o
 * `parse_memory_doc` (reflect.py) lê nativamente.
 *
 * O que mudou da US-F2.3 para cá (e por que specs antigos morreram):
 *  - o append por-módulo (`appendLearning` no `learning.path` da IA) morreu —
 *    o canônico é um doc por learning; `learning.path` não determina mais o
 *    local do arquivo (nome nasce de `memoryDocFilename`, interno);
 *  - `files:` (paths) virou `source_nodes` (IDs DE NÓ, receita `fileNodeId`)
 *    — o canal da antiga aresta sintética `describes`, APAGADA na US-F5.1
 *    (não existia no vocabulário do graphify; o reflect agrega `source_nodes`
 *    nativamente), deixou de existir, então os specs que fixavam
 *    `files:`/`MAX_NEURON_FILES` foram removidos junto;
 *  - `outcome` é passado pelo caller a partir do sinal REAL do loop
 *    (US-F5.2, `deriveLearningOutcome`); `undefined` = doc sem outcome
 *    (bucket `unmarked` do reflect) — ver `learning-reflect.spec.ts`.
 *
 * O que a US-F2.6 conquistou e estas specs PRESERVAM:
 *  1. caminho feliz — doc gravado, zero Activity;
 *  2. perda definitiva → Activity VISÍVEL no card (com o resumo completo);
 *  3. blindagem total — nem a Activity falhando derruba o loop;
 *  4. sucesso agenda o rebuild incremental com o `.hive/…` escrito.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Harness {
  orch: Orchestrator;
  activities: { cardId: string; text: string }[];
  scheduled: { projectId: string; files: string[] }[];
  cloneRoot: string;
  listMemoryDocs: () => string[];
  readMemoryDoc: (name: string) => string;
  cleanup: () => void;
}

const PROJECT_ID = 'proj-1';
const TASK_TITLE = 'Corrigir gateway de billing';

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
 * Harness: clone FAKE num tmpdir (`<root>/<projectId>/.git`) + ProjectHiveService
 * REAL + Orchestrator real com fakes (mesmo recorte white-box das demais specs
 * do módulo). `card.findUnique` devolve o título da task — a fonte do
 * `question` do memory doc (US-F5.1).
 */
function makeHarness(opts: { withHive?: boolean; incremental?: boolean } = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-f5-1-write-'));
  const cloneRoot = path.join(root, PROJECT_ID);
  fs.mkdirSync(path.join(cloneRoot, '.git', 'info'), { recursive: true });
  const config = makeConfig();
  const hiveConfig = { projects: { dir: root } } as unknown as AppConfig;
  const hive = new ProjectHiveService(hiveConfig);

  const activities: { cardId: string; text: string }[] = [];
  const scheduled: { projectId: string; files: string[] }[] = [];
  const prisma = {
    activity: {
      create: async (args: { data: { cardId: string; text: string } }) => {
        activities.push(args.data);
        return args.data;
      },
    },
    card: {
      findUnique: async () => ({ title: TASK_TITLE }),
    },
  } as unknown as PrismaService;
  const sessionPrisma = {
    agentRuntimeState: { upsert: async () => undefined },
  } as unknown as PrismaService;
  const projectGraph = {
    get incrementalEnabled() {
      return opts.incremental === true;
    },
    scheduleRebuild: async (projectId: string, files: string[]) => {
      scheduled.push({ projectId, files });
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
    opts.withHive === false ? undefined : hive,
  );
  const memDir = path.join(cloneRoot, '.hive', 'memory');
  return {
    orch,
    activities,
    scheduled,
    cloneRoot,
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

// ═════════ 1. Caminho feliz: memory doc canônico em .hive/memory/ ═══════════

test('US-F5.1 caminho feliz: learning vira memory doc canônico em .hive/memory/ (question = título da task, source_nodes = IDs de nó), NENHUMA Activity', async () => {
  const h = makeHarness();
  try {
    const ok = await priv(h.orch).persistLearning(
      'tk-1',
      { path: 'modules/billing.md', summary: 'gateway exige idempotency-key', scope: 'billing' },
      PROJECT_ID,
      ['apps/api/src/billing/gateway.ts'],
      // US-F5.2 — o outcome agora é DERIVADO do sinal do loop pelo caller
      // (deriveLearningOutcome); aqui passamos 'useful' explícito.
      'useful',
    );
    assert.equal(ok, true);
    const docs = h.listMemoryDocs();
    assert.equal(docs.length, 1, 'um doc por learning, no diretório PLANO');
    assert.match(docs[0], /^learning_\d{8}_\d{6}_gateway_exige_idempotency_key\.md$/);
    const parsed = parseMemoryDoc(h.readMemoryDoc(docs[0]));
    assert.ok(parsed, 'frontmatter canônico parseável (o mesmo que o reflect lê)');
    assert.equal(parsed!.type, 'learning');
    assert.equal(parsed!.question, TASK_TITLE);
    assert.equal(parsed!.contributor, 'kanban-ai');
    // US-F5.2 — o outcome passado pelo caller round-tripa no frontmatter.
    assert.equal(parsed!.outcome, 'useful');
    // A mudança central: ID DE NÓ (receita _file_node_id), não path.
    assert.deepEqual(parsed!.sourceNodes, ['apps_api_src_billing_gateway']);
    // Sem perda → sem alarme no card.
    assert.equal(h.activities.length, 0);
    // Higiene do working tree: a fiação de ignore acompanha a escrita.
    const exclude = fs.readFileSync(path.join(h.cloneRoot, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.includes('/.hive/'));
    assert.ok(fs.readFileSync(path.join(h.cloneRoot, '.graphifyignore'), 'utf8').includes('!/.hive/'));
  } finally {
    h.cleanup();
  }
});

// ═════════ 2. Um doc POR learning: nada se sobrescreve ══════════════════════

test('US-F5.1 acúmulo: dois learnings → dois docs distintos, nada se perde', async () => {
  const h = makeHarness();
  try {
    const ok1 = await priv(h.orch).persistLearning(
      'tk-a',
      { path: 'modules/billing.md', summary: 'primeiro aprendizado' },
      PROJECT_ID,
      [],
    );
    const ok2 = await priv(h.orch).persistLearning(
      'tk-b',
      { path: 'modules/billing.md', summary: 'segundo aprendizado' },
      PROJECT_ID,
      [],
    );
    assert.equal(ok1 && ok2, true);
    const docs = h.listMemoryDocs();
    assert.equal(docs.length, 2);
    const all = docs.map((d) => h.readMemoryDoc(d)).join('\n');
    assert.ok(all.includes('primeiro aprendizado'));
    assert.ok(all.includes('segundo aprendizado'));
    assert.equal(h.activities.length, 0);
  } finally {
    h.cleanup();
  }
});

// ═════════ 3. learning.path da IA NÃO determina mais o local do arquivo ═════

test('US-F5.1 trust boundary: learning.path malicioso é IGNORADO — o doc vai para .hive/memory/ com nome interno', async () => {
  const h = makeHarness();
  try {
    const ok = await priv(h.orch).persistLearning(
      'tk-2',
      { path: '../../fora-da-colmeia.md', summary: 'tentativa de escape' },
      PROJECT_ID,
      [],
    );
    // Antes (US-F2.3) o path da IA era o destino e traversal virava perda
    // visível; agora o nome nasce de memoryDocFilename e o path é ignorado.
    assert.equal(ok, true);
    assert.ok(!fs.existsSync(path.join(h.cloneRoot, '..', 'fora-da-colmeia.md')));
    assert.ok(!fs.existsSync(path.join(h.cloneRoot, 'fora-da-colmeia.md')));
    assert.equal(h.listMemoryDocs().length, 1);
    assert.equal(h.activities.length, 0);
  } finally {
    h.cleanup();
  }
});

// ═════════ 4. Perda definitiva → VISÍVEL no card; loop nunca quebra ═════════

test('US-F5.1 perda visível: Board sem Project → Activity com o resumo', async () => {
  const h = makeHarness();
  try {
    const ok = await priv(h.orch).persistLearning(
      'tk-3',
      { path: 'modules/billing.md', summary: 'aprendizado que vai se perder' },
      null,
      [],
    );
    assert.equal(ok, false);
    assert.equal(h.activities.length, 1);
    assert.equal(h.activities[0].cardId, 'tk-3');
    assert.ok(h.activities[0].text.includes('aprendizado PERDIDO'));
    assert.ok(h.activities[0].text.includes('aprendizado que vai se perder'));
    assert.ok(h.activities[0].text.includes('Board sem Project'));
  } finally {
    h.cleanup();
  }
});

test('US-F5.1 perda visível: clone do Project ausente → Activity, sem exceção', async () => {
  const h = makeHarness();
  try {
    const ok = await priv(h.orch).persistLearning(
      'tk-4',
      { path: 'modules/billing.md', summary: 'perdido: clone sumiu' },
      'proj-inexistente',
      [],
    );
    assert.equal(ok, false);
    assert.equal(h.activities.length, 1);
    assert.ok(h.activities[0].text.includes('indisponível'));
  } finally {
    h.cleanup();
  }
});

test('US-F5.1 perda visível: falha de I/O real (.hive é um ARQUIVO) → Activity com o erro, sem exceção', async () => {
  const h = makeHarness();
  try {
    fs.writeFileSync(path.join(h.cloneRoot, '.hive'), 'não sou um diretório');
    const ok = await priv(h.orch).persistLearning(
      'tk-5',
      { path: 'modules/billing.md', summary: 'perdido por I/O' },
      PROJECT_ID,
      [],
    );
    assert.equal(ok, false);
    assert.equal(h.activities.length, 1);
    assert.ok(h.activities[0].text.includes('aprendizado PERDIDO'));
  } finally {
    h.cleanup();
  }
});

test('US-F5.1 blindagem total: até a Activity falhando, persistLearning NÃO lança', async () => {
  const h = makeHarness();
  try {
    (priv(h.orch).prisma as any).activity.create = async () => {
      throw new Error('banco fora tambem');
    };
    const ok = await priv(h.orch).persistLearning(
      'tk-6',
      { path: 'modules/billing.md', summary: 'x' },
      null,
      [],
    );
    assert.equal(ok, false);
  } finally {
    h.cleanup();
  }
});

// ═════════ 5. Grafo avisado: o doc escrito entra no rebuild incremental ═════

test('US-F5.1 rebuild: sucesso agenda scheduleRebuild com o path .hive/memory/… escrito (só com incremental ON)', async () => {
  const on = makeHarness({ incremental: true });
  try {
    await priv(on.orch).persistLearning(
      'tk-7',
      { path: 'modules/billing.md', summary: 'ok' },
      PROJECT_ID,
      [],
    );
    assert.equal(on.scheduled.length, 1);
    assert.equal(on.scheduled[0].projectId, PROJECT_ID);
    assert.equal(on.scheduled[0].files.length, 1);
    assert.match(on.scheduled[0].files[0], /^\.hive\/memory\/learning_\d{8}_\d{6}_ok\.md$/);
  } finally {
    on.cleanup();
  }
  const off = makeHarness({ incremental: false });
  try {
    await priv(off.orch).persistLearning(
      'tk-8',
      { path: 'modules/billing.md', summary: 'ok' },
      PROJECT_ID,
      [],
    );
    assert.deepEqual(off.scheduled, [], 'incremental OFF: nada agendado');
  } finally {
    off.cleanup();
  }
});

// ═════════ 6. O corte de arquivos (insumo de source_nodes) ══════════════════

test('US-F2.6 cutLearningFiles: filtra lockfiles e .hive/, corta em 10 na ordem do diff', () => {
  // O corte em 10 casa com o teto de source_nodes do formato canônico
  // (`[:10]` do save_query_result — US-F5.1).
  const many = Array.from({ length: 15 }, (_, i) => `apps/api/src/f${String(i).padStart(2, '0')}.ts`);
  const cut = cutLearningFiles([
    '.hive/memory/learning_x.md',
    'package-lock.json',
    'apps/web/pnpm-lock.yaml',
    'yarn.lock',
    ...many,
  ]);
  assert.equal(cut.length, 10);
  assert.deepEqual(cut, many.slice(0, 10));
});
