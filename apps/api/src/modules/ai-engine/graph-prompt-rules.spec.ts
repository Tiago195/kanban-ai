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
import type {
  GraphQueryResult,
  ProjectGraphQueryService,
  QueryGraphOptions,
} from '../projects/project-graph-query.service';

/**
 * US-F5.5 (EP-F5) — seção "Grafo de conhecimento do projeto" no prompt.
 *
 * As regras canônicas do graphify (`always_on/claude-md.md`) TRADUZIDAS para a
 * superfície real dos agents (tools MCP + Wiki via API do kanban-ai), nunca
 * transcritas: o texto original manda rodar `graphify query/path/explain/
 * update` — comandos de CLI que o agent NÃO tem. O que estas specs fixam:
 *  - a seção APARECE quando o grafo está `ready` (reuso do estado que o
 *    recall da US-F2.5 resolve — `memoryGraph.ok`) e o Board tem Project;
 *  - a seção NÃO aparece sem Project, com grafo não-`ready` ou integração
 *    desligada — nada de prometer um grafo que não existe;
 *  - o texto NUNCA promete comando de CLI inexistente (`graphify …`) nem o
 *    GRAPH_REPORT.md (vive no volume do sidecar, fora do clone do agent).
 *
 * Harness: mesmo padrão posicional de `memory-recall-graph.spec.ts` (fakes de
 * Prisma + ProjectGraphQueryService), sem colmeia (irrelevante aqui).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROJECT_ID = 'proj-1';
const API_PORT = 3333;

// ─────────────────── Fake do ProjectGraphQueryService ───────────────────────

/** Contrato throwless da US-F1.4 — devolve `result` para queryGraph. */
class FakeGraphQuery {
  calls: { projectId: string; opts: QueryGraphOptions }[] = [];
  result: GraphQueryResult = { ok: true, text: '' };

  async queryGraph(projectId: string, opts: QueryGraphOptions): Promise<GraphQueryResult> {
    this.calls.push({ projectId, opts });
    return this.result;
  }

  async getNeighbors(): Promise<GraphQueryResult> {
    return { ok: false, error: 'no do arquivo fora do grafo (fake)' };
  }

  async getNode(): Promise<GraphQueryResult> {
    return { ok: false, error: 'no desconhecido (fake)' };
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
  // US-F5.5 — apiPort entra no harness: a seção do grafo monta a URL da Wiki.
  return { agent, apiPort: API_PORT, graphify: { memoryRecallEnabled } } as unknown as AppConfig;
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
  projectGraphState?: string | null;
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
      findUnique: async () =>
        input.projectGraphState ? { graphState: input.projectGraphState } : null,
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
  boardProjectId?: string | null;
  projectGraphState?: string | null;
  graphQuery?: FakeGraphQuery;
  memoryRecallEnabled?: boolean;
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
    undefined,
    undefined,
    input.graphQuery as unknown as ProjectGraphQueryService | undefined,
    undefined,
  );
}

const priv = (orch: Orchestrator) => orch as unknown as any;

type BuiltContext = Awaited<ReturnType<Orchestrator['buildContext']>>;

const PROFILE = { id: 'p', name: 'P', firstStep: 'go', phases: [{ id: 'implementing' }] } as any;

async function promptFor(orch: Orchestrator): Promise<string> {
  const ctx: BuiltContext = await priv(orch).buildContext('task-1', 'ajusta cobranca');
  return priv(orch).buildPrompt(PROFILE.phases[0], PROFILE, ctx);
}

/** Cards padrão: task→story em Board com flow + arquivo. */
function cards(): Record<string, CardRow> {
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

// ═══════ 1. Grafo `ready` → seção presente, na superfície REAL do agent ═════

test('US-F5.5 grafo ready: seção presente com tools MCP, project_path, Wiki e "não atualize o grafo"', async () => {
  const graphQuery = new FakeGraphQuery();
  graphQuery.result = { ok: true, text: 'Traversal: BFS | 1 node' };
  const orch = makeOrchestrator({
    cards: cards(),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
  });
  const prompt = await promptFor(orch);
  assert.ok(prompt.includes('## Grafo de conhecimento do projeto'));
  // Superfície real: tools MCP nomeadas + project_path do grafo DESTE Project.
  assert.ok(prompt.includes('`query_graph`'));
  assert.ok(prompt.includes(`/home/graphify/.graphify/projects/${PROJECT_ID}`));
  // Step 0 traduzido: identificadores reais, não prosa em português.
  assert.ok(prompt.includes('IDENTIFICADORES REAIS'));
  // Wiki da US-F5.4, com a URL concreta (porta da API + projectId).
  assert.ok(prompt.includes(`http://127.0.0.1:${API_PORT}/projects/${PROJECT_ID}/wiki`));
  // Regra 4 INVERTIDA: o loop reconstrói (US-F1.5); o agent não atualiza nada.
  assert.ok(prompt.includes('NÃO tente atualizar o grafo'));
});

// ═══════ 2. Sem CLI fantasma: nada de `graphify <cmd>` nem GRAPH_REPORT ═════

test('US-F5.5 tradução, não transcrição: o texto nunca promete a CLI do graphify nem o GRAPH_REPORT', async () => {
  const graphQuery = new FakeGraphQuery();
  graphQuery.result = { ok: true, text: 'Traversal: BFS | 1 node' };
  const orch = makeOrchestrator({
    cards: cards(),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
  });
  const prompt = await promptFor(orch);
  assert.ok(prompt.includes('## Grafo de conhecimento do projeto'));
  // Os comandos do claude-md.md canônico que o agent NÃO tem — instrução que
  // falha é pior que nenhuma (o agent tentaria e queimaria a iteração).
  for (const cmd of ['graphify query', 'graphify path', 'graphify explain', 'graphify update']) {
    assert.ok(!prompt.includes(cmd), `prompt promete CLI inexistente: ${cmd}`);
  }
  assert.ok(!prompt.includes('GRAPH_REPORT'));
  assert.ok(!prompt.includes('graphify-out'));
});

// ═══════ 3. Board sem Project → sem seção (não há grafo para prometer) ══════

test('US-F5.5 Board sem Project: seção omitida', async () => {
  const orch = makeOrchestrator({
    cards: cards(),
    boardProjectId: null,
    graphQuery: new FakeGraphQuery(),
  });
  const prompt = await promptFor(orch);
  assert.ok(!prompt.includes('## Grafo de conhecimento do projeto'));
  assert.ok(!prompt.includes('query_graph'));
});

// ═══════ 4. Grafo não-`ready` → sem seção (aviso de memória continua) ═══════

test('US-F5.5 grafo building: seção omitida — o aviso de memória indisponível (US-F2.5) permanece', async () => {
  const orch = makeOrchestrator({
    cards: cards(),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'building',
    graphQuery: new FakeGraphQuery(),
  });
  const prompt = await promptFor(orch);
  assert.ok(!prompt.includes('## Grafo de conhecimento do projeto'));
  assert.ok(prompt.includes('Memória do projeto INDISPONÍVEL'));
});

// ═══════ 5. Integração desligada → sem seção ════════════════════════════════

test('US-F5.5 recall desligado (env off): seção omitida', async () => {
  const orch = makeOrchestrator({
    cards: cards(),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery: new FakeGraphQuery(),
    memoryRecallEnabled: false,
  });
  const prompt = await promptFor(orch);
  assert.ok(!prompt.includes('## Grafo de conhecimento do projeto'));
});

// ═══════ 6. Memória VAZIA mas grafo ready → seção presente mesmo assim ══════

test('US-F5.5 memória vazia com grafo ready: a seção entra — o grafo existe e é consultável', async () => {
  const graphQuery = new FakeGraphQuery();
  graphQuery.result = { ok: true, text: '' }; // travessia sem resultado
  const orch = makeOrchestrator({
    cards: cards(),
    boardProjectId: PROJECT_ID,
    projectGraphState: 'ready',
    graphQuery,
  });
  const prompt = await promptFor(orch);
  // Sem seção de memória (vazia de verdade)…
  assert.ok(!prompt.includes('## Memória do projeto (grafo de conhecimento'));
  // …mas o grafo está `ready`: o agent precisa saber que pode consultá-lo.
  assert.ok(prompt.includes('## Grafo de conhecimento do projeto'));
});
