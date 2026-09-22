import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator } from './orchestrator';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';
import { ProjectHiveService } from '../projects/project-hive.service';
import type {
  GraphQueryResult,
  ProjectGraphQueryService,
  QueryGraphOptions,
} from '../projects/project-graph-query.service';

/**
 * US-F2.5/US-F2.10 → US-F2.3 (EP-F2) — Recall por GRAFO no `buildContext`.
 *
 * Nasceu (US-F2.5) como spec de PARIDADE grafo-vs-LIKE, comparando caso a caso
 * contra o oráculo da US-F2.1. A US-F2.3 deletou o módulo `memory/` (e com ele
 * o LIKE, o oráculo e a metade "lado antigo" da comparação — decisão registrada
 * na emenda da US-F2.10 no ADR-0027: "a partir da F2.3 o rollback deixa de
 * existir"). O que estas specs PRESERVAM é a metade que vale sozinha:
 *  - a recuperação por seeds independentes (título/flows/ARQUIVOS — fim do
 *    casamento de frase inteira) e o canal reverso `describes`;
 *  - o isolamento por Project (`projectId` na consulta) e o `token_budget`
 *    default do serviço (o substituto do corte cego de 4000 chars);
 *  - a distinção "memória FALHOU" ≠ "memória VAZIA" (grafo não-`ready`,
 *    sidecar fora, exceção → aviso EXPLÍCITO no prompt; vazio → sem seção);
 *  - env OFF / Board legado / task sem story → recall NÃO se aplica: a
 *    iteração roda SEM memória (novo comportamento pós-F2.3, sem LIKE).
 *
 * Harness: Orchestrator real com fakes + fake do `ProjectGraphQueryService`
 * (contrato throwless da US-F1.4) + colmeia REAL num tmpdir
 * (`<clone>/.hive/**.md` via ProjectHiveService — a fonte da verdade da
 * US-F2.3, de onde `appendNeuronBodies` lê os corpos).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─────────────────── Colmeia real num tmpdir (US-F2.3) ──────────────────────

const PROJECT_ID = 'proj-1';

interface HiveHarness {
  hive: ProjectHiveService;
  seed: (rel: string, content: string) => void;
  cleanup: () => void;
}

function makeHive(): HiveHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-f2-3-recall-'));
  fs.mkdirSync(path.join(root, PROJECT_ID, '.git', 'info'), { recursive: true });
  const hive = new ProjectHiveService({ projects: { dir: root } } as unknown as AppConfig);
  return {
    hive,
    seed: (rel, content) => {
      const target = path.join(root, PROJECT_ID, '.hive', rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ─────────────────── Fake do ProjectGraphQueryService (US-F1.4) ─────────────

/** Grava as chamadas e devolve `result` — mesmo contrato throwless do real. */
class FakeGraphQuery {
  calls: { projectId: string; opts: QueryGraphOptions }[] = [];
  neighborCalls: { label: string; relationFilter?: string }[] = [];
  result: GraphQueryResult = { ok: true, text: '' };
  /** Vizinhos reversos `describes` (por label consultado). */
  neighbors: GraphQueryResult = { ok: false, error: 'no do arquivo fora do grafo (fake)' };
  /** get_node por label. */
  nodes = new Map<string, GraphQueryResult>();

  async queryGraph(projectId: string, opts: QueryGraphOptions): Promise<GraphQueryResult> {
    this.calls.push({ projectId, opts });
    return this.result;
  }

  async getNeighbors(
    _projectId: string,
    opts: { label: string; relationFilter?: string },
  ): Promise<GraphQueryResult> {
    this.neighborCalls.push({ label: opts.label, relationFilter: opts.relationFilter });
    return this.neighbors;
  }

  async getNode(_projectId: string, label: string): Promise<GraphQueryResult> {
    return this.nodes.get(label) ?? { ok: false, error: `no desconhecido (fake): ${label}` };
  }
}

// ────────── Fake do ProjectGraphService (projeção US-F4.1 → vocab US-F5.3) ──

/**
 * US-F5.3 — só a `projection` importa aqui: é de onde o orchestrator extrai o
 * VOCABULÁRIO dos labels do grafo (Step 0 do query.md). `labels: null` simula
 * projeção indisponível (degrade para a pergunta crua pré-F5.3).
 */
class FakeProjectGraph {
  projectionCalls = 0;
  constructor(public labels: string[] | null) {}

  async projection(_projectId: string, _query: unknown) {
    this.projectionCalls += 1;
    if (this.labels === null) {
      return { ok: false as const, graphState: 'ready', error: 'projecao indisponivel (fake)' };
    }
    return {
      ok: true as const,
      mode: 'overview',
      focus: null,
      nodes: this.labels.map((label, i) => ({
        id: String(i),
        label,
        type: 'code',
        sourceFile: null,
        community: null,
        communityName: null,
        degree: 0,
      })),
      edges: [],
      communities: [],
      totalNodes: this.labels.length,
      totalEdges: 0,
      truncated: false,
    };
  }
}

// ─────────────────── Harness do Orchestrator ────────────────────────────────

function makeConfig(memoryRecallEnabled: boolean): AppConfig {
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
  return { agent, graphify: { memoryRecallEnabled } } as unknown as AppConfig;
}

interface CardRow {
  parentId?: string | null;
  title?: string;
  description?: string;
  aiProject?: string;
  aiNotes?: string;
  affectedFlows?: Array<{ name: string; files: string[]; note?: string }>;
  startInPlanMode?: boolean;
  boardId?: string | null;
}

function makeOrchPrisma(input: {
  cards: Record<string, CardRow>;
  boardProjectId?: string | null;
  /** `graphState` do Project; `null` = Project inexistente no banco. */
  projectGraphState?: string | null;
  /** Quando true, `project.findUnique` LANÇA (simula banco fora no meio). */
  failProjectLookup?: boolean;
}) {
  return {
    card: {
      findUnique: async (args: { where: { id: string } }) => input.cards[args.where.id] ?? null,
      findMany: async () => [],
    },
    board: {
      findUnique: async () => ({ projectId: input.boardProjectId ?? null }),
    },
    project: {
      findUnique: async () => {
        if (input.failProjectLookup) throw new Error('banco indisponivel (simulado)');
        return input.projectGraphState ? { graphState: input.projectGraphState } : null;
      },
    },
    dodItem: { findMany: async () => [], count: async () => 0 },
    iteration: { findMany: async () => [], findFirst: async () => null },
    comment: { findMany: async () => [] },
    agentRuntimeState: { findUnique: async () => null },
    agentMessage: { findFirst: async () => null },
  } as unknown as PrismaService;
}

function makeOrchestrator(input: {
  cards: Record<string, CardRow>;
  hive?: ProjectHiveService;
  boardProjectId?: string | null;
  projectGraphState?: string | null;
  failProjectLookup?: boolean;
  graphQuery?: FakeGraphQuery;
  memoryRecallEnabled?: boolean;
  /** US-F5.3 — fake do ProjectGraphService (fonte do vocabulário). */
  projectGraph?: FakeProjectGraph;
}): Orchestrator {
  const config = makeConfig(input.memoryRecallEnabled ?? true);
  const sessionPrisma = {
    agentRuntimeState: { upsert: async () => undefined },
  } as unknown as PrismaService;
  const sessions = new AgentSessionManager(config, sessionPrisma);
  return new Orchestrator(
    makeOrchPrisma(input),
    sessions,
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
    // US-F5.3 — posição do ProjectGraphService (projeção → vocabulário).
    input.projectGraph as never,
    undefined,
    input.graphQuery as unknown as ProjectGraphQueryService | undefined,
    input.hive,
  );
}

const priv = (orch: Orchestrator) => orch as unknown as any;

type BuiltContext = Awaited<ReturnType<Orchestrator['buildContext']>>;

const PROFILE = { id: 'p', name: 'P', firstStep: 'go', phases: [{ id: 'implementing' }] } as any;

function promptFor(orch: Orchestrator, ctx: BuiltContext): string {
  return priv(orch).buildPrompt(PROFILE.phases[0], PROFILE, ctx);
}

/** Cards padrão: task→story em Board com Project e um flow com arquivo. */
function cardsWithFlows(): Record<string, CardRow> {
  return {
    'task-1': { parentId: 'story-1', title: 'ajusta cobranca', description: '' },
    'story-1': {
      parentId: null,
      title: 'S',
      description: '',
      aiProject: '',
      aiNotes: '',
      affectedFlows: [{ name: 'pagamentos', files: ['apps/api/src/billing/gateway.ts'] }],
      startInPlanMode: false,
      boardId: 'board-1',
    },
  };
}

// ═══════════ 1. Env OFF — recall não se aplica: iteração SEM memória ════════

test('US-F2.3 env off: grafo nunca consultado, memoryGraph null, prompt sem seção de memória (o LIKE morreu)', async () => {
  const h = makeHive();
  try {
    h.seed('modules/pagamentos.md', '# Pagamentos\n\nnota sobre ajusta cobranca.');
    const graphQuery = new FakeGraphQuery();
    const orch = makeOrchestrator({
      cards: cardsWithFlows(),
      hive: h.hive,
      boardProjectId: PROJECT_ID,
      projectGraphState: 'ready',
      graphQuery,
      memoryRecallEnabled: false,
    });
    const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta cobranca');
    assert.equal(ctx.memoryGraph, null);
    assert.equal(graphQuery.calls.length, 0);
    const prompt = promptFor(orch, ctx);
    assert.ok(!prompt.includes('Memória do projeto'));
    assert.ok(!prompt.includes('INDISPONÍVEL'));
  } finally {
    h.cleanup();
  }
});

// ═══════ 2. A recuperação central: termos viram seeds independentes ═════════

test('US-F2.5 flagship: a travessia recupera por seeds (título + flow + ARQUIVO) e anexa o corpo lido do .hive do clone', async () => {
  const h = makeHive();
  try {
    h.seed(
      'modules/pagamentos.md',
      '# Pagamentos\n\najusta cobranca esta descrito aqui.\n\npagamentos em outro paragrafo.',
    );
    const graphQuery = new FakeGraphQuery();
    const traversal =
      "Traversal: BFS depth=3 | Start: ['Pagamentos', 'gateway.ts'] | 3 nodes found\n" +
      'NODE Pagamentos [src=.hive/modules/pagamentos.md loc=L11 community=cards.md]\n' +
      'NODE gateway.ts [src=apps/api/src/billing/gateway.ts loc=L1 community=gateway.ts]\n' +
      'EDGE gateway.ts --describes--> Pagamentos';
    graphQuery.result = { ok: true, text: traversal };
    const orch = makeOrchestrator({
      cards: cardsWithFlows(),
      hive: h.hive,
      boardProjectId: PROJECT_ID,
      projectGraphState: 'ready',
      graphQuery,
    });
    const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta cobranca');
    // O mapa da travessia é ENRIQUECIDO com o corpo dos neurônios tocados
    // (src=.hive/…), lido da fonte da verdade (US-F2.3: o .hive do clone).
    assert.ok(ctx.memoryGraph?.ok);
    assert.ok(ctx.memoryGraph.text.startsWith(traversal));
    assert.ok(ctx.memoryGraph.text.includes('### neurônio: .hive/modules/pagamentos.md'));
    assert.ok(ctx.memoryGraph.text.includes('ajusta cobranca esta descrito aqui.'));
    // A consulta: título + flow + ARQUIVO como termos independentes (o
    // servidor tokeniza — fim do casamento de frase inteira), isolada por
    // projectId (project_path injetado no serviço, US-F1.4).
    assert.equal(graphQuery.calls.length, 1);
    assert.equal(graphQuery.calls[0].projectId, PROJECT_ID);
    assert.equal(
      graphQuery.calls[0].opts.question,
      'ajusta cobranca pagamentos apps/api/src/billing/gateway.ts',
    );
    assert.equal(graphQuery.calls[0].opts.mode, 'bfs');
    // token_budget NÃO é sobrescrito aqui: vale o DEFAULT_GRAPH_TOKEN_BUDGET
    // (2000 tokens) do ProjectGraphQueryService — o substituto do corte cego
    // de 4000 chars do recall antigo.
    assert.equal(graphQuery.calls[0].opts.tokenBudget, undefined);
    const prompt = promptFor(orch, ctx);
    assert.ok(prompt.includes('## Memória do projeto (grafo de conhecimento'));
    assert.ok(prompt.includes('ajusta cobranca esta descrito aqui.'));
  } finally {
    h.cleanup();
  }
});

// ═══════ 3. Termo vazio — memória VAZIA explícita, sem consultar o grafo ════

test('US-F2.5 termo vazio: memória VAZIA explícita — sem consultar o grafo, sem seção, sem aviso de falha', async () => {
  const h = makeHive();
  try {
    const graphQuery = new FakeGraphQuery();
    const cards: Record<string, CardRow> = {
      'task-1': { parentId: 'story-1', title: '', description: '' },
      'story-1': {
        parentId: null,
        title: 'S',
        description: '',
        aiProject: '',
        aiNotes: '',
        affectedFlows: [],
        startInPlanMode: false,
        boardId: 'board-1',
      },
    };
    const orch = makeOrchestrator({
      cards,
      hive: h.hive,
      boardProjectId: PROJECT_ID,
      projectGraphState: 'ready',
      graphQuery,
    });
    const ctx: BuiltContext = await priv(orch).buildContext('task-1', '');
    assert.deepEqual(ctx.memoryGraph, { ok: true, text: '' });
    assert.equal(graphQuery.calls.length, 0);
    // Sem seção de memória E sem aviso de falha (vazio ≠ falha).
    const prompt = promptFor(orch, ctx);
    assert.ok(!prompt.includes('Memória do projeto'));
    assert.ok(!prompt.includes('INDISPONÍVEL'));
  } finally {
    h.cleanup();
  }
});

// ═══════ 4. Falha ≠ vazio — o aviso explícito (as 3 camadas de visibilidade) ═

test('US-F2.5 graphState != ready: memória FALHOU (não vazia) — prompt avisa e o loop não quebra', async () => {
  const h = makeHive();
  try {
    for (const graphState of ['building', 'failed', 'pending']) {
      const graphQuery = new FakeGraphQuery();
      const orch = makeOrchestrator({
        cards: cardsWithFlows(),
        hive: h.hive,
        boardProjectId: PROJECT_ID,
        projectGraphState: graphState,
        graphQuery,
      });
      const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta cobranca');
      assert.deepEqual(ctx.memoryGraph, {
        ok: false,
        error: `grafo do projeto indisponível (graphState=${graphState})`,
      });
      // Grafo não-pronto: NEM tenta a consulta (falha barata, sem rede).
      assert.equal(graphQuery.calls.length, 0);
      const prompt = promptFor(orch, ctx);
      assert.ok(prompt.includes('Memória do projeto INDISPONÍVEL'));
      assert.ok(prompt.includes(`graphState=${graphState}`));
    }
  } finally {
    h.cleanup();
  }
});

test('US-F2.5 Project ausente no banco: falha legível (graphState=inexistente), sem exceção', async () => {
  const orch = makeOrchestrator({
    cards: cardsWithFlows(),
    boardProjectId: PROJECT_ID,
    projectGraphState: null,
    graphQuery: new FakeGraphQuery(),
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta cobranca');
  assert.deepEqual(ctx.memoryGraph, {
    ok: false,
    error: 'grafo do projeto indisponível (graphState=inexistente)',
  });
});

test('US-F2.5 sidecar fora: {ok:false} do serviço é REPASSADO ao prompt — a IA sabe que a memória falhou', async () => {
  const graphQuery = new FakeGraphQuery();
  graphQuery.result = { ok: false, error: 'graphify MCP inacessível em http://127.0.0.1:8129/mcp: timeout' };
  const orch = makeOrchestrator({
    cards: cardsWithFlows(),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta cobranca');
  assert.deepEqual(ctx.memoryGraph, graphQuery.result);
  const prompt = promptFor(orch, ctx);
  assert.ok(prompt.includes('Memória do projeto INDISPONÍVEL'));
  assert.ok(prompt.includes('graphify MCP inacessível'));
  assert.ok(prompt.includes('NÃO conclua que não existem aprendizados'));
});

test('US-F2.5 exceção inesperada (lookup do Project lança): vira {ok:false} — memória NUNCA derruba o loop', async () => {
  const orch = makeOrchestrator({
    cards: cardsWithFlows(),
    boardProjectId: PROJECT_ID,
    failProjectLookup: true,
    graphQuery: new FakeGraphQuery(),
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta cobranca');
  assert.deepEqual(ctx.memoryGraph, { ok: false, error: 'banco indisponivel (simulado)' });
  assert.ok(promptFor(orch, ctx).includes('Memória do projeto INDISPONÍVEL'));
});

// ═══════ 5. Recall não se aplica (Board legado / task órfã) — SEM memória ═══

test('US-F2.3 Board sem Project (env ON): recall não se aplica — iteração roda sem memória (o LIKE morreu)', async () => {
  const graphQuery = new FakeGraphQuery();
  const orch = makeOrchestrator({
    cards: cardsWithFlows(),
    boardProjectId: null, // ← Board legado, sem Project
    graphQuery,
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta cobranca');
  assert.equal(ctx.memoryGraph, null);
  assert.equal(graphQuery.calls.length, 0);
  assert.ok(!promptFor(orch, ctx).includes('Memória do projeto'));
});

test('US-F2.3 task sem story (env ON): sem projectId possível — sem memória, sem exceção', async () => {
  const orch = makeOrchestrator({
    cards: { 'task-1': { parentId: null, title: 'gigante', description: '' } },
    graphQuery: new FakeGraphQuery(),
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'gigante');
  assert.equal(ctx.memoryGraph, null);
});

// ═══════ 6. O canal `describes` — memória SEM nenhuma palavra em comum ══════

test('US-F2.5 describes: arquivo afetado recupera o neurônio que o descreve mesmo SEM palavra em comum', async () => {
  const h = makeHive();
  try {
    // Neurônio sem NENHUM termo do título/flow ('adiciona retry' / 'billing').
    h.seed('modules/pagamentos.md', '# Pagamentos\n\nrefund NUNCA antes do settle do provedor.');
    const graphQuery = new FakeGraphQuery();
    // Travessia lexical não tocou nenhum neurônio (sem src=.hive/…)…
    graphQuery.result = {
      ok: true,
      text: 'NODE gateway.ts [src=apps/api/src/billing/gateway.ts loc=L1 community=g]',
    };
    // …mas o arquivo afetado tem aresta REVERSA describes (formato real do
    // get_neighbors) e o get_node resolve o src do neurônio.
    graphQuery.neighbors = { ok: true, text: 'Neighbors of gateway.ts:\n  <-- pagamentos.md [describes] [EXTRACTED]' };
    graphQuery.nodes.set('pagamentos.md', {
      ok: true,
      text: 'Node: pagamentos.md\n  ID: hive_modules_pagamentos\n  Source: .hive/modules/pagamentos.md L1\n  Type: document',
    });
    const cards: Record<string, CardRow> = {
      'task-1': { parentId: 'story-1', title: 'adiciona retry', description: '' },
      'story-1': {
        parentId: null,
        title: 'S',
        description: '',
        aiProject: '',
        aiNotes: '',
        affectedFlows: [{ name: 'billing', files: ['apps/api/src/billing/gateway.ts'] }],
        startInPlanMode: false,
        boardId: 'board-1',
      },
    };
    const orch = makeOrchestrator({
      cards,
      hive: h.hive,
      boardProjectId: PROJECT_ID,
      projectGraphState: 'ready',
      graphQuery,
    });
    const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'adiciona retry');
    assert.deepEqual(graphQuery.neighborCalls, [
      { label: 'apps/api/src/billing/gateway.ts', relationFilter: 'describes' },
    ]);
    assert.ok(ctx.memoryGraph?.ok);
    assert.ok(ctx.memoryGraph.text.includes('### neurônio: .hive/modules/pagamentos.md'));
    assert.ok(ctx.memoryGraph.text.includes('refund NUNCA antes do settle'));
  } finally {
    h.cleanup();
  }
});

// ═══════ 7. US-F5.3 — Step 0: expansão de consulta RESTRITA ao vocabulário ══

/** Cards com título em PORTUGUÊS e (opcionalmente) arquivos afetados. */
function cardsPt(title: string, files: string[]): Record<string, CardRow> {
  return {
    'task-1': { parentId: 'story-1', title, description: '' },
    'story-1': {
      parentId: null,
      title: 'S',
      description: '',
      aiProject: '',
      aiNotes: '',
      affectedFlows: files.length ? [{ name: 'fluxo', files }] : [],
      startInPlanMode: false,
      boardId: 'board-1',
    },
  };
}

test('US-F5.3 pt-vs-en sem arquivos: interseção VAZIA → NÃO consulta, memória vazia EXPLÍCITA (noVocabMatch) e prompt distinto', async () => {
  const graphQuery = new FakeGraphQuery();
  // Vocabulário 100% inglês (labels reais do Project array-move).
  const projectGraph = new FakeProjectGraph(['arrayMoveImmutable()', 'arrayMoveMutable()', 'CardsService']);
  const orch = makeOrchestrator({
    cards: cardsPt('Tratar acentuação do separador vazio', []),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
    projectGraph,
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'Tratar acentuação do separador vazio');
  // A pergunta CRUA não vai mais pro grafo (era o defeito: matcher literal → noise).
  assert.equal(graphQuery.calls.length, 0);
  assert.deepEqual(ctx.memoryGraph, { ok: true, text: '', noVocabMatch: true });
  const prompt = promptFor(orch, ctx);
  // Estado DISTINTO de "não há memória" e de "memória falhou".
  assert.ok(prompt.includes('vocabulário da task não casa com o do grafo'));
  assert.ok(prompt.includes('a busca não é fabricada'));
  assert.ok(!prompt.includes('INDISPONÍVEL'));
});

test('US-F5.3 pt-vs-en com arquivo: palavras cruas NÃO entram — só o path (seed forte) segue na consulta', async () => {
  const graphQuery = new FakeGraphQuery();
  const projectGraph = new FakeProjectGraph(['arrayMoveImmutable()', 'CardsService']);
  const orch = makeOrchestrator({
    cards: cardsPt('Tratar separador vazio', ['apps/api/src/Billing/gateway.ts']),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
    projectGraph,
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'Tratar separador vazio');
  assert.equal(graphQuery.calls.length, 1);
  // Nem 'tratar', nem 'separador', nem 'vazio', nem 'fluxo' — só o path,
  // normalizado em minúsculo (o matcher do binário é case-folded).
  assert.equal(graphQuery.calls[0].opts.question, 'apps/api/src/billing/gateway.ts');
  assert.ok(ctx.memoryGraph?.ok);
});

test('US-F5.3 termo presente no vocab: é selecionado (com split de camelCase do label) e emitido junto dos paths', async () => {
  const graphQuery = new FakeGraphQuery();
  // 'arrayMoveImmutable()' → tokens {array, move, immutable}; 'slugify' → {slugify}.
  const projectGraph = new FakeProjectGraph(['arrayMoveImmutable()', 'slugify']);
  const orch = makeOrchestrator({
    cards: cardsPt('Validar separador vazio no slugify do array', ['src/slugify.js']),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
    projectGraph,
  });
  await priv(orch).buildContext('task-1', 'Validar separador vazio no slugify do array');
  assert.equal(graphQuery.calls.length, 1);
  // Interseção determinística: só o que EXISTE no vocab, na ordem da pergunta;
  // 'imutavel'≠'immutable' jamais seria inventado (hard constraint do Step 0).
  assert.equal(graphQuery.calls[0].opts.question, 'slugify array src/slugify.js');
});

test('US-F5.3 teto de 12 tokens do vocabulário (limite do Step 0 do query.md)', async () => {
  const graphQuery = new FakeGraphQuery();
  const words = Array.from({ length: 15 }, (_, i) => `token${String.fromCharCode(97 + i)}`);
  const projectGraph = new FakeProjectGraph(words); // todos existem no vocab
  const orch = makeOrchestrator({
    cards: cardsPt(words.join(' '), []),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
    projectGraph,
  });
  await priv(orch).buildContext('task-1', words.join(' '));
  assert.equal(graphQuery.calls.length, 1);
  assert.equal(graphQuery.calls[0].opts.question.split(' ').length, 12);
  assert.equal(graphQuery.calls[0].opts.question, words.slice(0, 12).join(' '));
});

test('US-F5.3 vocabulário indisponível (projeção falha): degrada para a pergunta crua pré-F5.3 — recall não piora', async () => {
  const graphQuery = new FakeGraphQuery();
  const projectGraph = new FakeProjectGraph(null); // projeção {ok:false}
  const orch = makeOrchestrator({
    cards: cardsPt('ajusta cobranca', ['apps/api/src/billing/gateway.ts']),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
    projectGraph,
  });
  await priv(orch).buildContext('task-1', 'ajusta cobranca');
  assert.equal(graphQuery.calls.length, 1);
  assert.equal(
    graphQuery.calls[0].opts.question,
    'ajusta cobranca fluxo apps/api/src/billing/gateway.ts',
  );
});

test('US-F5.3 cache do vocabulário: dois recalls do mesmo Project fazem UMA projeção', async () => {
  const graphQuery = new FakeGraphQuery();
  const projectGraph = new FakeProjectGraph(['slugify']);
  const orch = makeOrchestrator({
    cards: cardsPt('ajusta slugify', []),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
    projectGraph,
  });
  await priv(orch).buildContext('task-1', 'ajusta slugify');
  await priv(orch).buildContext('task-1', 'ajusta slugify');
  assert.equal(projectGraph.projectionCalls, 1);
  assert.equal(graphQuery.calls.length, 2);
});

// ═══════ 8. US-F5.3 — ranking pelo overlay do reflect (US-F5.2) ═════════════

test('US-F5.3 overlay presente: NODE learning=preferred sobe, contested desce, legenda anexada (EDGEs intactos)', async () => {
  const graphQuery = new FakeGraphQuery();
  const projectGraph = new FakeProjectGraph(['slugify', 'replace()']);
  // Formato real do serve.py: header, linha em branco, NODEs, EDGEs — com o
  // sufixo `learning=` que o sidecar anexa quando .graphify_learning.json existe.
  graphQuery.result = {
    ok: true,
    text:
      'Graph: g.json (84 nodes) | Traversal: BFS depth=3\n' +
      '\n' +
      'NODE slugify [src=slugify.d.ts loc=L1 community=s]\n' +
      'NODE replace() [src=slugify.js loc=L18 community=s learning=contested]\n' +
      'NODE slugify.js [src=slugify.js loc=L1 community=s learning=preferred]\n' +
      'EDGE slugify.js --contains [EXTRACTED]--> replace() at=slugify.js:L18',
  };
  const orch = makeOrchestrator({
    cards: cardsPt('ajusta slugify', []),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
    projectGraph,
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta slugify');
  assert.ok(ctx.memoryGraph?.ok);
  const linhas = ctx.memoryGraph.text.split('\n');
  const nodes = linhas.filter((l) => l.startsWith('NODE '));
  // preferred primeiro, sem anotação no meio, contested por último.
  assert.ok(nodes[0].includes('learning=preferred'));
  assert.ok(nodes[1].startsWith('NODE slugify '));
  assert.ok(nodes[2].includes('learning=contested'));
  // EDGE continua DEPOIS do bloco de NODEs (blocos não se misturam).
  assert.ok(linhas.indexOf('EDGE slugify.js --contains [EXTRACTED]--> replace() at=slugify.js:L18') >
    linhas.findIndex((l) => l.startsWith('NODE ')));
  // Legenda para a IA interpretar as anotações.
  assert.ok(ctx.memoryGraph.text.includes('learning=preferred'));
  assert.ok(ctx.memoryGraph.text.includes('já foi tentado e não levou a nada'));
});

test('US-F5.3 overlay ausente (caso normal até a frota rodar): texto byte-idêntico — degradação silenciosa', async () => {
  const graphQuery = new FakeGraphQuery();
  const projectGraph = new FakeProjectGraph(['slugify']);
  const traversal =
    'NODE slugify [src=slugify.d.ts loc=L1 community=s]\n' +
    'EDGE slugify --contains [EXTRACTED]--> replace()';
  graphQuery.result = { ok: true, text: traversal };
  const orch = makeOrchestrator({
    cards: cardsPt('ajusta slugify', []),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
    projectGraph,
  });
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta slugify');
  assert.ok(ctx.memoryGraph?.ok);
  assert.equal(ctx.memoryGraph.text, traversal);
  assert.ok(!ctx.memoryGraph.text.includes('Aprendizado do projeto'));
});
