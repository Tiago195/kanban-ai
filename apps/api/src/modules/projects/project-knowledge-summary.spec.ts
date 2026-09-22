import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  GraphProjectionResponse,
  ProjectLearningResponse,
  ProjectWikiIndexResponse,
} from '@kanban-ai/shared';
import { summarizeKnowledge } from './project-graph.service';

/**
 * US-UX.4 — specs da agregação PURA do resumo do conhecimento
 * (`GET /projects/summary`): cada faceta (grafo/wiki/memória) mapeia sua
 * resposta throwless para contagens OU falha tipada `{ok:false}` — offline,
 * sem sidecar (mesmo padrão das US-F5.4/UX.3).
 */

const graphOk: GraphProjectionResponse = {
  ok: true,
  mode: 'overview',
  focus: null,
  nodes: [],
  edges: [],
  communities: [],
  totalNodes: 3510,
  totalEdges: 6300,
  truncated: true,
};

const wikiOk: ProjectWikiIndexResponse = {
  ok: true,
  generated: true,
  generatedAt: '2026-08-30T12:00:00Z',
  articles: [
    { slug: 'index', title: 'Índice' },
    { slug: 'core', title: 'Núcleo' },
  ],
};

const learningNode = (status: 'preferred' | 'tentative' | 'contested') => ({
  id: `n-${status}`,
  status,
  verdict: null,
  score: 1,
  uses: 1,
  neg: 0,
  last: '2026-08-29',
  label: status,
  sourceFile: null,
  stale: false,
  provenance: [],
});

const learningOk: ProjectLearningResponse = {
  ok: true,
  generated: true,
  generatedAt: '2026-08-30T12:00:00Z',
  docs: 4,
  nodes: [learningNode('preferred'), learningNode('contested'), learningNode('tentative')],
  deadEnds: [],
  corrections: [],
};

test('summary: facetas ok viram contagens (nós/arestas, artigos, aprendizados/contestados)', () => {
  const s = summarizeKnowledge('p1', graphOk, wikiOk, learningOk);
  assert.deepEqual(s, {
    projectId: 'p1',
    graph: { ok: true, nodes: 3510, edges: 6300 },
    wiki: { ok: true, generated: true, articles: 2 },
    memory: { ok: true, generated: true, docs: 4, learnings: 3, contested: 1 },
  });
});

test('summary: grafo falhou → {ok:false} com graphState e erro legível (nunca some)', () => {
  const s = summarizeKnowledge(
    'p1',
    { ok: false, graphState: 'failed', error: 'build do grafo falhou: sem espaço' },
    wikiOk,
    learningOk,
  );
  assert.deepEqual(s.graph, {
    ok: false,
    graphState: 'failed',
    error: 'build do grafo falhou: sem espaço',
  });
  // As demais facetas seguem intactas — falha de uma não contamina as outras.
  assert.equal(s.wiki.ok, true);
  assert.equal(s.memory.ok, true);
});

test('summary: wiki/memória ainda não geradas → generated:false com contagens zeradas (estado vazio honesto, não erro)', () => {
  const s = summarizeKnowledge(
    'p1',
    { ok: false, graphState: 'pending', error: 'grafo ainda não construído' },
    { ok: true, generated: false, generatedAt: null, articles: [] },
    { ok: true, generated: false, generatedAt: null, docs: 0, nodes: [], deadEnds: [], corrections: [] },
  );
  assert.deepEqual(s.wiki, { ok: true, generated: false, articles: 0 });
  assert.deepEqual(s.memory, { ok: true, generated: false, docs: 0, learnings: 0, contested: 0 });
});

test('summary: sidecar fora → todas as facetas {ok:false} legíveis (nunca lança)', () => {
  const s = summarizeKnowledge(
    'p1',
    { ok: false, graphState: 'ready', error: 'graphify inacessível' },
    { ok: false, error: 'graphify inacessível' },
    { ok: false, error: 'graphify inacessível' },
  );
  assert.equal(s.graph.ok, false);
  assert.deepEqual(s.wiki, { ok: false, error: 'graphify inacessível' });
  assert.deepEqual(s.memory, { ok: false, error: 'graphify inacessível' });
});
