import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliAdapter } from './cli-adapter';
import type { AppConfig } from '../../../shared/config/config';

/**
 * Specs do parser de telemetria de tokens do rodapé CRU da Copilot CLI
 * (`CliAdapter.parseTokenUsage`). Item de backlog: as `Iteration`s gravavam
 * tokens NULL porque o `result` JSONL nunca trazia tokens — agora extraímos do
 * output real da CLI.
 */

function makeAdapter(): CliAdapter {
  const config = {
    agent: {
      cliCommand: 'copilot',
      cliArgs: [],
      promptMode: 'stdin',
      hitlTimeoutMs: 1000,
      streamIdleTimeoutMs: 1000,
    },
  } as unknown as AppConfig;
  return new CliAdapter(config);
}

// US-A4 — contrato `learnings` no KANBAN_RESULT: auto-report de aprendizado do
// agent que o orchestrator persiste na memória em colmeia (ADR-0027). Deve ser
// defensivo e retrocompatível (ausência = undefined).
test('parseLine result: learnings válido preserva os itens', () => {
  const a = makeAdapter();
  const line = JSON.stringify({
    kind: 'result',
    summary: 's',
    learnings: [
      { path: 'modules/ai-engine.md', summary: 'loop consome memória', scope: 'ai-engine' },
      { path: 'modules/cards.md', summary: 'epic é derivado' },
    ],
  });
  const ev = a.parseLine(line);
  assert.equal(ev?.kind, 'result');
  assert.deepEqual((ev as { learnings?: unknown }).learnings, [
    { path: 'modules/ai-engine.md', summary: 'loop consome memória', scope: 'ai-engine' },
    { path: 'modules/cards.md', summary: 'epic é derivado' },
  ]);
});

test('parseLine result: learnings filtra item sem path/summary', () => {
  const a = makeAdapter();
  const line = JSON.stringify({
    kind: 'result',
    summary: 's',
    learnings: [
      { path: '', summary: 'sem path' },
      { path: 'modules/x.md', summary: '   ' },
      { path: 'modules/ok.md', summary: 'válido' },
    ],
  });
  const ev = a.parseLine(line);
  assert.deepEqual((ev as { learnings?: unknown }).learnings, [
    { path: 'modules/ok.md', summary: 'válido' },
  ]);
});

test('parseLine result: sem learnings → undefined (retrocompat)', () => {
  const a = makeAdapter();
  const line = JSON.stringify({ kind: 'result', summary: 's', done: true });
  const ev = a.parseLine(line);
  assert.equal(ev?.kind, 'result');
  assert.equal((ev as { learnings?: unknown }).learnings, undefined);
});

test('parseTokenUsage: rótulos explícitos input=/output=', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseTokenUsage('Token usage: input=1234 output=567'), {
    inputTokens: 1234,
    outputTokens: 567,
  });
});

test('parseTokenUsage: número ANTES do rótulo ("N input, M output")', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseTokenUsage('tokens: 1,234 input, 567 output'), {
    inputTokens: 1234,
    outputTokens: 567,
  });
});

test('parseTokenUsage: sufixo k normaliza para milhares (1.2k → 1200)', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseTokenUsage('Total usage est: 1.2k input · 567 output'), {
    inputTokens: 1200,
    outputTokens: 567,
  });
});

test('parseTokenUsage: setas ↑/↓', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseTokenUsage('↑ 1234 tokens  ↓ 567 tokens'), {
    inputTokens: 1234,
    outputTokens: 567,
  });
});

test('parseTokenUsage: prompt_tokens/completion_tokens', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseTokenUsage('prompt_tokens: 1234, completion_tokens: 567'), {
    inputTokens: 1234,
    outputTokens: 567,
  });
});

test('parseTokenUsage: linha sem menção a tokens/usage retorna undefined', () => {
  const a = makeAdapter();
  assert.equal(a.parseTokenUsage('apenas um pensamento qualquer'), undefined);
  assert.equal(a.parseTokenUsage(''), undefined);
});

test('parseTokenUsage: menção a token mas sem par completo retorna undefined', () => {
  const a = makeAdapter();
  assert.equal(a.parseTokenUsage('usei alguns tokens hoje'), undefined);
  // só input, sem output → não retorna par parcial.
  assert.equal(a.parseTokenUsage('Token usage: input=1234'), undefined);
});

test('parseTokenUsage: sufixo m (milhões)', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseTokenUsage('usage: 2m input, 1.5m output'), {
    inputTokens: 2_000_000,
    outputTokens: 1_500_000,
  });
});

// Formato REAL capturado da Copilot CLI 1.0.79 (rodape de stats):
//   Tokens     ↑ 48.4k (48.2k written) • ↓ 4
// O texto "(48.2k written)" entre o ↑ e o ↓ NAO pode contaminar o output.
test('parseTokenUsage: formato real da Copilot CLI (setas + written + bullet)', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseTokenUsage('Tokens     \u2191 48.4k (48.2k written) \u2022 \u2193 4'), {
    inputTokens: 48_400,
    outputTokens: 4,
  });
  assert.deepEqual(a.parseTokenUsage('Tokens     \u2191 12k \u2022 \u2193 3.5k'), {
    inputTokens: 12_000,
    outputTokens: 3_500,
  });
  // linhas vizinhas do rodape nao devem casar
  assert.equal(a.parseTokenUsage('Changes    +0 -0'), undefined);
  assert.equal(a.parseTokenUsage('AI Credits 0 (14s)'), undefined);
});
