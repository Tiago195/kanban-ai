import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_MEMORY_GIT_DIR,
  loadConfig,
  resolveMemoryGitDir,
} from './config';

// --- config-boot: guard-rail anti-alucinação do arquivo-fantasma ---
// Regressão: `apps/api/.env.example` NUNCA deve existir (ver config.ts:10-14 e
// ADR-0019). Existe um único template versionado: `.env.example` na raiz. Se
// alguém (humano ou agent) recriar o path-fantasma, este teste falha cedo.
test('config-boot: apps/api/.env.example não existe (path-fantasma)', () => {
  const phantom = resolve(__dirname, '../../../.env.example');
  assert.equal(
    existsSync(phantom),
    false,
    'apps/api/.env.example é um path-fantasma e não deve existir; o único ' +
      'template versionado é .env.example na raiz do monorepo (ver ADR-0019).',
  );
});

// --- MEMORY_GIT_DIR: bare repo da memória (ADR-0027, Camada 1) ---

test('resolveMemoryGitDir: ausente usa o default documentado', () => {
  assert.equal(resolveMemoryGitDir(undefined), DEFAULT_MEMORY_GIT_DIR);
});

test('resolveMemoryGitDir: valor explícito é respeitado (com trim)', () => {
  assert.equal(resolveMemoryGitDir('/srv/memory/git'), '/srv/memory/git');
  assert.equal(resolveMemoryGitDir('  /srv/memory/git  '), '/srv/memory/git');
});

test('resolveMemoryGitDir: definido vazio/whitespace falha cedo com mensagem clara', () => {
  assert.throws(() => resolveMemoryGitDir(''), /MEMORY_GIT_DIR/);
  assert.throws(() => resolveMemoryGitDir('   '), /MEMORY_GIT_DIR/);
});

test('loadConfig: memory.gitDir usa default quando MEMORY_GIT_DIR ausente', () => {
  const prev = process.env.MEMORY_GIT_DIR;
  delete process.env.MEMORY_GIT_DIR;
  try {
    assert.equal(loadConfig().memory.gitDir, DEFAULT_MEMORY_GIT_DIR);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_GIT_DIR;
    else process.env.MEMORY_GIT_DIR = prev;
  }
});

test('loadConfig: memory.gitDir respeita override via env', () => {
  const prev = process.env.MEMORY_GIT_DIR;
  process.env.MEMORY_GIT_DIR = '/var/lib/kanban-ai/memory';
  try {
    assert.equal(loadConfig().memory.gitDir, '/var/lib/kanban-ai/memory');
  } finally {
    if (prev === undefined) delete process.env.MEMORY_GIT_DIR;
    else process.env.MEMORY_GIT_DIR = prev;
  }
});

test('loadConfig: falha cedo quando MEMORY_GIT_DIR está vazio', () => {
  const prev = process.env.MEMORY_GIT_DIR;
  process.env.MEMORY_GIT_DIR = '   ';
  try {
    assert.throws(() => loadConfig(), /MEMORY_GIT_DIR/);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_GIT_DIR;
    else process.env.MEMORY_GIT_DIR = prev;
  }
});
