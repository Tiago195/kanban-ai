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
