import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions } from '@kanban-ai/shared';

/**
 * US-COLAB4 — spec unitária do parser puro `parseMentions` (contrato shared).
 * Casos do DOD §4.7 + cobertura de handles com `-`/`_`, menção sozinha e várias.
 */

test('parseMentions: uma menção → handle + título após a menção', () => {
  assert.deepEqual(parseMentions('@backend corrige o login'), [
    { handle: 'backend', taskTitle: 'corrige o login' },
  ]);
});

test('parseMentions: texto sem menção → []', () => {
  assert.deepEqual(parseMentions('sem mencao'), []);
});

test('parseMentions: string vazia → []', () => {
  assert.deepEqual(parseMentions(''), []);
});

test('parseMentions: várias menções são separadas corretamente', () => {
  assert.deepEqual(
    parseMentions('@backend arruma a API @frontend ajusta o botão'),
    [
      { handle: 'backend', taskTitle: 'arruma a API' },
      { handle: 'frontend', taskTitle: 'ajusta o botão' },
    ],
  );
});

test('parseMentions: menção sozinha → taskTitle vazio', () => {
  assert.deepEqual(parseMentions('@orchestrator'), [
    { handle: 'orchestrator', taskTitle: '' },
  ]);
});

test('parseMentions: handles com hífen e underscore', () => {
  assert.deepEqual(parseMentions('@board-manager gerencia @qa_bot valida tudo'), [
    { handle: 'board-manager', taskTitle: 'gerencia' },
    { handle: 'qa_bot', taskTitle: 'valida tudo' },
  ]);
});

test('parseMentions: normaliza espaços múltiplos no título', () => {
  assert.deepEqual(parseMentions('@backend   corrige    o   login  '), [
    { handle: 'backend', taskTitle: 'corrige o login' },
  ]);
});

test('parseMentions: menção no meio do texto captura só o trecho após ela', () => {
  assert.deepEqual(parseMentions('por favor @backend valida o fluxo'), [
    { handle: 'backend', taskTitle: 'valida o fluxo' },
  ]);
});
