/**
 * US-F4.3 — specs dos helpers puros do painel "cards que tocaram este arquivo"
 * (nó → arquivo → card): a máquina de estados da view (incluindo o estado
 * VAZIO como entrega válida) e o roteamento card → modal do board.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GraphFileCard } from '@kanban-ai/shared';

import { fileCardTarget, fileCardsView } from './fileCards.ts';

function card(patch: Partial<GraphFileCard>): GraphFileCard {
  return {
    id: 'c1',
    boardId: 'b1',
    key: 'US-1',
    type: 'story',
    title: 'Uma story',
    parentId: null,
    via: ['affected-flow'],
    flowNames: [],
    ...patch,
  };
}

describe('US-F4.3 fileCardsView', () => {
  const idle = { isLoading: false, isError: false } as const;

  it('nó sem sourceFile → no-file (não há o que cruzar com o board)', () => {
    assert.deepEqual(fileCardsView(null, idle), { kind: 'no-file' });
  });

  it('carregando → loading com o arquivo', () => {
    assert.deepEqual(fileCardsView('index.js', { isLoading: true, isError: false }), {
      kind: 'loading',
      file: 'index.js',
    });
  });

  it('erro → error com mensagem legível (nunca esconde a falha)', () => {
    const view = fileCardsView('index.js', {
      isLoading: false,
      isError: true,
      error: new Error('api fora'),
    });
    assert.deepEqual(view, { kind: 'error', file: 'index.js', message: 'api fora' });
  });

  it('cards: [] → empty EXPLÍCITO (estado vazio é entrega válida, não some)', () => {
    const view = fileCardsView('index.js', {
      ...idle,
      data: { file: 'index.js', cards: [] },
    });
    assert.deepEqual(view, { kind: 'empty', file: 'index.js' });
  });

  it('com cards → cards na ordem do servidor', () => {
    const cards = [card({ key: 'US-2' }), card({ id: 'c2', key: 'TK-3', type: 'task' })];
    const view = fileCardsView('index.js', { ...idle, data: { file: 'index.js', cards } });
    assert.equal(view.kind, 'cards');
    if (view.kind === 'cards') {
      assert.deepEqual(view.cards.map((c) => c.key), ['US-2', 'TK-3']);
    }
  });
});

describe('US-F4.3 fileCardTarget', () => {
  it('story/epic abrem o próprio modal', () => {
    assert.deepEqual(fileCardTarget(card({ type: 'story' })), { modal: 'story', id: 'c1' });
    assert.deepEqual(fileCardTarget(card({ type: 'epic' })), { modal: 'epic', id: 'c1' });
  });

  it('task abre a story pai junto (o TaskModal empilha sobre a story)', () => {
    assert.deepEqual(fileCardTarget(card({ type: 'task', parentId: 's9' })), {
      modal: 'task',
      id: 'c1',
      storyId: 's9',
    });
    // task órfã (parent apagado): abre só o task, sem story
    assert.deepEqual(fileCardTarget(card({ type: 'task', parentId: null })), {
      modal: 'task',
      id: 'c1',
      storyId: null,
    });
  });
});
