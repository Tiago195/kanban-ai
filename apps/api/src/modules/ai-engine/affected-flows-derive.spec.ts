import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator, rankAffectedFiles, AFFECTED_FLOW_DERIVED_NAME } from './orchestrator';
import {
  ProjectGraphService,
  type AffectedHitDto,
} from '../projects/project-graph.service';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';

/**
 * US-F2.7 (EP-F2) — `affectedFlows` DERIVADO do blast radius (`POST /affected`
 * do wrapper, US-F1.6). Cobre:
 *  - o CORTE (`rankAffectedFiles`): agregação por arquivo, exclusões,
 *    ordenação depth→hits→path;
 *  - o cliente `ProjectGraphService.affected` (contrato throwless contra um
 *    wrapper fake HTTP — mesma técnica do project-graph.service.spec.ts);
 *  - a derivação no Orchestrator: semântica COMPLEMENTA+CONFERE (fluxo
 *    derivado persiste ao lado do declarado; divergência vira Activity),
 *    corte com teto+existência, e os caminhos de falha NÃO-silenciosos e
 *    NÃO-fatais (grafo não-ready, sidecar fora, Board legado);
 *  - env off (default) = byte-idêntico: nenhuma chamada, nenhuma escrita.
 *
 * A travessia REAL do grafo foi validada empiricamente contra o sidecar (ver
 * reporte da US: curva de hits por depth no grafo de 3484 nós do kanban-ai).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─────────────────────────── 1. O corte (puro) ──────────────────────────────

test('US-F2.7 rankAffectedFiles: agrega por arquivo e ordena por depth, nº de hits e path', () => {
  const hits = [
    { file: 'src/b.ts', depth: 1 },
    { file: 'src/a.ts', depth: 1 },
    { file: 'src/b.ts', depth: 1 },
    { file: 'src/deep.ts', depth: 2 },
    { file: 'src/b.ts', depth: 2 }, // não rebaixa o minDepth já visto
  ];
  const ranked = rankAffectedFiles([], hits);
  assert.deepEqual(
    ranked.map((r) => r.file),
    ['src/b.ts', 'src/a.ts', 'src/deep.ts'], // d1x3, d1x1, d2x1
  );
  assert.equal(ranked[0].hits, 3);
  assert.equal(ranked[0].depth, 1);
});

test('US-F2.7 rankAffectedFiles: exclui os arquivos tocados, .hive/ e hits sem arquivo', () => {
  const ranked = rankAffectedFiles(
    ['src/changed.ts'],
    [
      { file: 'src/changed.ts', depth: 1 }, // a própria mudança não é raio
      { file: '.hive/modules/nota.md', depth: 1 }, // neurônio ≠ código afetado
      { file: null, depth: 1 }, // nó externo/sintético
      { file: 'src/dependente.ts', depth: 1 },
    ],
  );
  assert.deepEqual(
    ranked.map((r) => r.file),
    ['src/dependente.ts'],
  );
});

// ───────────────── 2. Cliente ProjectGraphService.affected ──────────────────

function makeGraphConfig(buildUrl: string, apiKey = 'test-key'): AppConfig {
  return {
    graphify: { buildUrl, apiKey, buildTimeoutMs: 5_000, queryTimeoutMs: 2_000 },
  } as unknown as AppConfig;
}

function makeGraphService(buildUrl: string, apiKey?: string): ProjectGraphService {
  return new ProjectGraphService(
    {} as unknown as PrismaService,
    makeGraphConfig(buildUrl, apiKey),
    { broadcast: () => undefined } as unknown as RealtimeService,
  );
}

/** Wrapper fake: responde POST /affected com o payload dado. */
async function fakeWrapper(reply: { status: number; body: unknown }): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: { path: string; auth: string | undefined; body: any }[];
}> {
  const requests: { path: string; auth: string | undefined; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: JSON.parse(raw || '{}'),
      });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    requests,
  };
}

test('US-F2.7 affected(): envia seed+depth autenticados e devolve os hits do wrapper', async () => {
  const hit: AffectedHitDto = {
    nodeId: 'n1',
    label: 'caller.ts',
    depth: 1,
    relation: 'imports_from',
    file: 'src/caller.ts',
    location: 'L3',
  };
  const wrapper = await fakeWrapper({
    status: 200,
    body: { ok: true, seed: 'src_x', hits: [hit] },
  });
  try {
    const svc = makeGraphService(wrapper.url);
    const res = await svc.affected('p1', 'src/x.ts', 1);
    assert.deepEqual(res, { ok: true, hits: [hit] });
    assert.equal(wrapper.requests.length, 1);
    assert.equal(wrapper.requests[0].path, '/affected');
    assert.equal(wrapper.requests[0].auth, 'Bearer test-key');
    assert.deepEqual(wrapper.requests[0].body, { projectId: 'p1', seed: 'src/x.ts', depth: 1 });
  } finally {
    await wrapper.close();
  }
});

test('US-F2.7 affected(): erro do wrapper e sidecar fora viram {ok:false} legível — nunca lançam', async () => {
  const wrapper = await fakeWrapper({
    status: 404,
    body: { ok: false, error: 'grafo nao construido' },
  });
  const url = wrapper.url;
  try {
    const res = await makeGraphService(url).affected('p1', 'src/x.ts', 1);
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /grafo nao construido/);
  } finally {
    await wrapper.close();
  }
  // Porta fechada (sidecar fora do ar): mesma forma de erro, sem exceção.
  const down = await makeGraphService(url).affected('p1', 'src/x.ts', 1);
  assert.equal(down.ok, false);
  assert.match((down as { error: string }).error, /inacess/);
});

test('US-F2.7 affected(): sem GRAPHIFY_API_KEY reporta integração desligada sem tocar a rede', async () => {
  const res = await makeGraphService('http://127.0.0.1:1', '').affected('p1', 'src/x.ts', 1);
  assert.deepEqual(res, { ok: false, error: 'graphify desligado (GRAPHIFY_API_KEY ausente)' });
});

// ──────────────── 3. Harness do Orchestrator (derivação) ────────────────────

interface FlowRow {
  id: string;
  cardId: string;
  name: string;
  files: string[];
  note: string;
}

function makeOrchPrisma(input: {
  boardProjectId: string | null;
  projectGraphState: string | null;
}) {
  const flows: FlowRow[] = [];
  const activities: string[] = [];
  let nextId = 1;
  const prisma = {
    card: {
      findUnique: async () => ({ boardId: 'board-1' }),
    },
    board: {
      findUnique: async () => ({ projectId: input.boardProjectId }),
    },
    project: {
      findUnique: async () =>
        input.projectGraphState ? { graphState: input.projectGraphState } : null,
    },
    activity: {
      create: async ({ data }: { data: { text: string } }) => {
        activities.push(data.text);
        return data;
      },
    },
    affectedFlow: {
      findMany: async ({ where }: { where: { cardId: string } }) =>
        flows.filter((f) => f.cardId === where.cardId).map((f) => ({ ...f })),
      create: async ({ data }: { data: Omit<FlowRow, 'id'> }) => {
        const row = { id: `f${nextId++}`, ...data };
        flows.push(row);
        return { ...row };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FlowRow>;
      }) => {
        const row = flows.find((f) => f.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
    },
  } as unknown as PrismaService;
  return { prisma, flows, activities };
}

/** Fake do ProjectGraphService restrito ao contrato usado pela derivação. */
class FakeProjectGraph {
  calls: { projectId: string; seed: string; depth: number }[] = [];
  /** Resposta por seed; seeds sem entrada devolvem hits vazios (seed sem match). */
  bySeed = new Map<string, { ok: true; hits: AffectedHitDto[] } | { ok: false; error: string }>();

  async affected(projectId: string, seed: string, depth: number) {
    this.calls.push({ projectId, seed, depth });
    return this.bySeed.get(seed) ?? { ok: true as const, hits: [] };
  }
}

function makeOrchestrator(input: {
  affectedFlowsEnabled: boolean;
  boardProjectId?: string | null;
  projectGraphState?: string | null;
  graph?: FakeProjectGraph;
  /** Arquivos que NÃO existem no worktree (default: todos existem). */
  missingFiles?: string[];
}) {
  const config = {
    agent: { maxConcurrentSessions: 1 },
    graphify: { affectedFlowsEnabled: input.affectedFlowsEnabled },
  } as unknown as AppConfig;
  const db = makeOrchPrisma({
    // `undefined` = default do harness; `null` EXPLÍCITO = Board legado sem Project.
    boardProjectId: input.boardProjectId === undefined ? 'proj-1' : input.boardProjectId,
    projectGraphState: input.projectGraphState ?? 'ready',
  });
  const missing = new Set(input.missingFiles ?? []);
  const sessions = new AgentSessionManager(config, {
    agentRuntimeState: { upsert: async () => undefined },
  } as unknown as PrismaService);
  const orch = new Orchestrator(
    db.prisma,
    sessions,
    { validate: async () => ({ passed: true, problems: [] }) } as unknown as ValidationRunner,
    {
      fileExistsInWorktree: async (_cwd: string, f: string) => !missing.has(f),
    } as unknown as WorkspaceService,
    { broadcast: () => undefined } as unknown as RealtimeService,
    { run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner,
    config,
    undefined,
    undefined,
    undefined,
    input.graph as unknown as ProjectGraphService | undefined,
  );
  return { orch: orch as unknown as any, ...db };
}

const hit = (file: string | null, depth = 1, relation = 'imports_from'): AffectedHitDto => ({
  nodeId: `n:${file}:${Math.random()}`,
  label: file ?? 'externo',
  depth,
  relation,
  file,
  location: 'L1',
});

// ───────────────────── 4. Derivação, corte e conferência ────────────────────

test('US-F2.7 deriveAffectedFlow: complementa (fluxo derivado) e confere (divergência vira Activity)', async () => {
  const graph = new FakeProjectGraph();
  graph.bySeed.set('src/changed.ts', {
    ok: true,
    hits: [
      hit('src/caller.ts'),
      hit('src/caller.ts'),
      hit('src/caller.spec.ts'),
      hit('src/changed.ts'), // hit interno no próprio arquivo tocado — fora
      hit('src/sumiu.ts'), // não existe no worktree — fora (grafo defasado)
    ],
  });
  const h = makeOrchestrator({
    affectedFlowsEnabled: true,
    graph,
    missingFiles: ['src/sumiu.ts'],
  });
  const flow = await h.orch.deriveAffectedFlow({
    taskId: 'task-1',
    storyId: 'story-1',
    cwd: '/repo',
    changed: ['src/changed.ts'],
    declared: [{ name: 'pagamentos', files: ['src/caller.ts'] }],
  });
  assert.equal(flow.name, AFFECTED_FLOW_DERIVED_NAME);
  // Ranking: caller.ts (x2) antes de caller.spec.ts (x1); sumiu.ts filtrado.
  assert.deepEqual(flow.files, ['src/caller.ts', 'src/caller.spec.ts']);
  assert.match(flow.note, /US-F2\.7/);
  // A conferência: só o spec NÃO estava declarado pela IA.
  const divergencia = h.activities.filter((a: string) => /não declarou/.test(a));
  assert.equal(divergencia.length, 1);
  assert.match(divergencia[0], /src\/caller\.spec\.ts/);
  assert.doesNotMatch(divergencia[0], /src\/caller\.ts,/);
  assert.deepEqual(graph.calls, [{ projectId: 'proj-1', seed: 'src/changed.ts', depth: 1 }]);
});

test('US-F2.7 corte: teto de 10 arquivos, ranqueados por nº de hits (hub não vira ruído)', async () => {
  const graph = new FakeProjectGraph();
  // 15 dependentes; dep00..dep14, dep03 com 3 hits e dep07 com 2 (devem liderar).
  const hits: AffectedHitDto[] = [];
  for (let i = 0; i < 15; i++) hits.push(hit(`src/dep${String(i).padStart(2, '0')}.ts`));
  hits.push(hit('src/dep03.ts'), hit('src/dep03.ts'), hit('src/dep07.ts'));
  graph.bySeed.set('src/hub.ts', { ok: true, hits });
  const h = makeOrchestrator({ affectedFlowsEnabled: true, graph });
  const flow = await h.orch.deriveAffectedFlow({
    taskId: 'task-1',
    storyId: 'story-1',
    cwd: '/repo',
    changed: ['src/hub.ts'],
    declared: [],
  });
  assert.equal(flow.files.length, 10);
  assert.deepEqual(flow.files.slice(0, 2), ['src/dep03.ts', 'src/dep07.ts']);
  // O resto entra em ordem determinística de path; dep13/dep14 ficam de fora.
  assert.ok(!flow.files.includes('src/dep13.ts'));
  assert.ok(!flow.files.includes('src/dep14.ts'));
});

// ─────────────── 5. Falhas: não-silenciosas e não-fatais ────────────────────

test('US-F2.7 falha total do /affected (sidecar fora): null + Activity — loop segue com o declarado', async () => {
  const graph = new FakeProjectGraph();
  graph.bySeed.set('src/a.ts', { ok: false, error: 'graphify inacessível em http://…: timeout' });
  graph.bySeed.set('src/b.ts', { ok: false, error: 'graphify inacessível em http://…: timeout' });
  const h = makeOrchestrator({ affectedFlowsEnabled: true, graph });
  const flow = await h.orch.deriveAffectedFlow({
    taskId: 'task-1',
    storyId: 'story-1',
    cwd: '/repo',
    changed: ['src/a.ts', 'src/b.ts'],
    declared: [],
  });
  assert.equal(flow, null);
  assert.equal(h.flows.length, 0);
  const avisos = h.activities.filter((a: string) => /blast radius falhou/.test(a));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /inacessível/);
  assert.match(avisos[0], /declarados pela IA/);
});

test('US-F2.7 grafo não-ready: null + Activity, sem NENHUMA chamada ao /affected', async () => {
  const graph = new FakeProjectGraph();
  const h = makeOrchestrator({
    affectedFlowsEnabled: true,
    graph,
    projectGraphState: 'building',
  });
  const flow = await h.orch.deriveAffectedFlow({
    taskId: 'task-1',
    storyId: 'story-1',
    cwd: '/repo',
    changed: ['src/a.ts'],
    declared: [],
  });
  assert.equal(flow, null);
  assert.equal(graph.calls.length, 0);
  assert.equal(h.activities.filter((a: string) => /indisponível/.test(a)).length, 1);
});

test('US-F2.7 Board legado sem Project: null SILENCIOSO (não é falha — não há grafo por design)', async () => {
  const graph = new FakeProjectGraph();
  const h = makeOrchestrator({ affectedFlowsEnabled: true, graph, boardProjectId: null });
  const flow = await h.orch.deriveAffectedFlow({
    taskId: 'task-1',
    storyId: 'story-1',
    cwd: '/repo',
    changed: ['src/a.ts'],
    declared: [],
  });
  assert.equal(flow, null);
  assert.equal(graph.calls.length, 0);
  assert.equal(h.activities.length, 0);
});

test('US-F2.7 falha parcial: seeds que falham são pulados; o raio dos demais ainda sai', async () => {
  const graph = new FakeProjectGraph();
  graph.bySeed.set('src/a.ts', { ok: false, error: 'boom' });
  graph.bySeed.set('src/b.ts', { ok: true, hits: [hit('src/caller.ts')] });
  const h = makeOrchestrator({ affectedFlowsEnabled: true, graph });
  const flow = await h.orch.deriveAffectedFlow({
    taskId: 'task-1',
    storyId: 'story-1',
    cwd: '/repo',
    changed: ['src/a.ts', 'src/b.ts'],
    declared: [],
  });
  assert.deepEqual(flow.files, ['src/caller.ts']);
  assert.equal(h.activities.filter((a: string) => /falhou/.test(a)).length, 0);
});

// ──────── 6. maybeDeriveAffectedFlows: env off byte-idêntica + persistência ──

/** Repo git real em tmpdir com um arquivo commitado e um diff pendente. */
function makeGitRepo(): { cwd: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'us-f2-7-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  git('config', 'user.email', 'spec@kanban.ai');
  git('config', 'user.name', 'spec');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'changed.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(cwd, 'src', 'changed.ts'), 'export const a = 2;\n');
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

test('US-F2.7 env OFF (default): byte-idêntico — nenhuma chamada, nenhuma escrita, nenhuma Activity', async () => {
  const repo = makeGitRepo();
  try {
    const graph = new FakeProjectGraph();
    graph.bySeed.set('src/changed.ts', { ok: true, hits: [hit('src/caller.ts')] });
    const h = makeOrchestrator({ affectedFlowsEnabled: false, graph });
    await h.orch.maybeDeriveAffectedFlows({
      taskId: 'task-1',
      storyId: 'story-1',
      cwd: repo.cwd,
      diffBaseline: null,
      declared: [],
    });
    assert.equal(graph.calls.length, 0);
    assert.equal(h.flows.length, 0);
    assert.equal(h.activities.length, 0);
  } finally {
    repo.cleanup();
  }
});

test('US-F2.7 env ON: diff real vira seed, fluxo derivado persiste na story e acumula por nome', async () => {
  const repo = makeGitRepo();
  try {
    const graph = new FakeProjectGraph();
    graph.bySeed.set('src/changed.ts', { ok: true, hits: [hit('src/caller.ts')] });
    const h = makeOrchestrator({ affectedFlowsEnabled: true, graph });
    const input = {
      taskId: 'task-1',
      storyId: 'story-1',
      cwd: repo.cwd,
      diffBaseline: null,
      declared: [],
    };
    await h.orch.maybeDeriveAffectedFlows(input);
    assert.deepEqual(graph.calls, [{ projectId: 'proj-1', seed: 'src/changed.ts', depth: 1 }]);
    assert.equal(h.flows.length, 1);
    assert.equal(h.flows[0].cardId, 'story-1');
    assert.equal(h.flows[0].name, AFFECTED_FLOW_DERIVED_NAME);
    assert.deepEqual(h.flows[0].files, ['src/caller.ts']);
    // Segunda iteração: merge por nome (união de files), não um fluxo novo.
    graph.bySeed.set('src/changed.ts', { ok: true, hits: [hit('src/outro.ts')] });
    await h.orch.maybeDeriveAffectedFlows(input);
    assert.equal(h.flows.length, 1);
    assert.deepEqual(h.flows[0].files.sort(), ['src/caller.ts', 'src/outro.ts']);
  } finally {
    repo.cleanup();
  }
});

test('US-F2.7 env ON sem diff: no-op absoluto (o derivado é ancorado na realidade do git)', async () => {
  const repo = makeGitRepo();
  try {
    // Zera o diff pendente: worktree limpo.
    execFileSync('git', ['checkout', '--', '.'], { cwd: repo.cwd });
    const graph = new FakeProjectGraph();
    const h = makeOrchestrator({ affectedFlowsEnabled: true, graph });
    await h.orch.maybeDeriveAffectedFlows({
      taskId: 'task-1',
      storyId: 'story-1',
      cwd: repo.cwd,
      diffBaseline: null,
      declared: [],
    });
    assert.equal(graph.calls.length, 0);
    assert.equal(h.flows.length, 0);
    assert.equal(h.activities.length, 0);
  } finally {
    repo.cleanup();
  }
});
