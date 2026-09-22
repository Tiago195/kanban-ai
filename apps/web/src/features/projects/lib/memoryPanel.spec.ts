/**
 * US-UX.3 — specs dos helpers puros do painel da memória.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MemoryNeuronSummary, ProjectLearningNode } from '@kanban-ai/shared';

import {
  contestedScore,
  deriveMemoryView,
  filterDeadEnds,
  filterLearningNodes,
  filterNeurons,
  outcomeLabel,
  signalDay,
  splitLearning,
  verdictLabel,
} from './memoryPanel.ts';

function node(over: Partial<ProjectLearningNode>): ProjectLearningNode {
  return {
    id: 'n',
    status: 'tentative',
    verdict: null,
    score: 1,
    uses: 1,
    neg: 0,
    last: '2026-08-01',
    label: 'n',
    sourceFile: null,
    stale: false,
    provenance: [],
    ...over,
  };
}

function neuron(over: Partial<MemoryNeuronSummary>): MemoryNeuronSummary {
  return { path: 'a.md', title: 'a', tags: [], summary: '', updatedAt: '2026-08-01', ...over };
}

describe('US-UX.3 deriveMemoryView', () => {
  it('carregando enquanto QUALQUER uma das fontes carrega', () => {
    assert.deepEqual(
      deriveMemoryView({ memoryLoading: true, neurons: [], learningLoading: false, learning: undefined }),
      { kind: 'loading' },
    );
    assert.deepEqual(
      deriveMemoryView({ memoryLoading: false, neurons: [], learningLoading: true, learning: undefined }),
      { kind: 'loading' },
    );
  });

  it('sem neurônios e sem aprendizado → estado vazio único', () => {
    const view = deriveMemoryView({
      memoryLoading: false,
      neurons: [],
      learningLoading: false,
      learning: { ok: true, generated: false, generatedAt: null, docs: 0, nodes: [], deadEnds: [], corrections: [] },
    });
    assert.deepEqual(view, { kind: 'empty' });
  });

  it('learning indisponível NÃO esconde os neurônios: painel com erro visível', () => {
    const view = deriveMemoryView({
      memoryLoading: false,
      neurons: [neuron({})],
      learningLoading: false,
      learning: { ok: false, error: 'sidecar fora' },
    });
    assert.deepEqual(view, { kind: 'panel', learningError: 'sidecar fora' });
  });

  it('aprendizado gerado com zero neurônios crus ainda mostra o painel', () => {
    const view = deriveMemoryView({
      memoryLoading: false,
      neurons: [],
      learningLoading: false,
      learning: { ok: true, generated: true, generatedAt: '2026-08-30', docs: 3, nodes: [], deadEnds: [], corrections: [] },
    });
    assert.deepEqual(view, { kind: 'panel', learningError: null });
  });
});

describe('US-UX.3 splitLearning', () => {
  it('separa aprendizados (preferred+tentative) de contestados, recentes primeiro', () => {
    const nodes = [
      node({ id: 'old', status: 'preferred', last: '2026-07-01' }),
      node({ id: 'c1', status: 'contested', last: '2026-08-10' }),
      node({ id: 'new', status: 'tentative', last: '2026-08-20' }),
    ];
    const { learned, contested } = splitLearning(nodes);
    assert.deepEqual(learned.map((n) => n.id), ['new', 'old']);
    assert.deepEqual(contested.map((n) => n.id), ['c1']);
  });

  it('empate de data: preferred vem antes de tentative; depois id (determinístico)', () => {
    const nodes = [
      node({ id: 'b', status: 'tentative', last: '2026-08-01' }),
      node({ id: 'a', status: 'preferred', last: '2026-08-01' }),
      node({ id: 'c', status: 'preferred', last: '2026-08-01' }),
    ];
    assert.deepEqual(splitLearning(nodes).learned.map((n) => n.id), ['a', 'c', 'b']);
  });
});

describe('US-UX.3 busca transversal', () => {
  const nodes = [
    node({ id: 'index_move', label: 'arrayMove()', sourceFile: 'index.js' }),
    node({
      id: 'other',
      label: 'other',
      provenance: [{ q: 'como mover item da lista?', date: '2026-08-01', outcome: 'useful' }],
    }),
  ];

  it('filterLearningNodes casa label, arquivo, id e pergunta da proveniência', () => {
    assert.equal(filterLearningNodes(nodes, 'arraymove').length, 1);
    assert.equal(filterLearningNodes(nodes, 'index.js').length, 1);
    assert.equal(filterLearningNodes(nodes, 'mover item').length, 1);
    assert.equal(filterLearningNodes(nodes, '').length, 2);
    assert.equal(filterLearningNodes(nodes, 'zzz').length, 0);
  });

  it('filterDeadEnds casa pergunta e nós citados', () => {
    const deadEnds = [
      { question: 'dá pra mutar in place?', nodes: ['index_mutable'], date: '2026-08-01' },
    ];
    assert.equal(filterDeadEnds(deadEnds, 'mutar').length, 1);
    assert.equal(filterDeadEnds(deadEnds, 'index_mutable').length, 1);
    assert.equal(filterDeadEnds(deadEnds, 'nada').length, 0);
  });

  it('filterNeurons preserva a regra antiga (título, path, tags)', () => {
    const list = [
      neuron({ title: 'Cards', path: 'modules/cards.md', tags: ['board'] }),
      neuron({ title: 'Auth', path: 'modules/auth.md', tags: [] }),
    ];
    assert.equal(filterNeurons(list, 'board').length, 1);
    assert.equal(filterNeurons(list, 'cards').length, 1);
    assert.equal(filterNeurons(list, '').length, 2);
  });
});

describe('US-UX.3 rótulos', () => {
  it('placar do contestado', () => {
    assert.equal(contestedScore(node({ uses: 2, neg: 1 })), '2× útil · 1× beco/correção');
  });

  it('veredito e outcome em PT (cor nunca é o único canal)', () => {
    assert.equal(verdictLabel('useful'), 'a recência diz: útil');
    assert.equal(verdictLabel('dead end'), 'a recência diz: beco sem saída');
    assert.equal(verdictLabel('even'), 'empatado');
    assert.equal(outcomeLabel('dead_end'), 'beco sem saída');
    assert.equal(outcomeLabel('corrected'), 'corrigida');
  });

  it('signalDay corta o ISO na data', () => {
    assert.equal(signalDay('2026-08-30T12:00:00+00:00'), '2026-08-30');
    assert.equal(signalDay(''), '');
  });
});
