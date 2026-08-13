import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACTION_NOTE,
  compactPrompt,
  isContextOverflowError,
} from './context-compaction';
import { CopilotCliRunner } from './copilot-cli.runner';
import type { AgentRunInput, AgentRunResult } from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';

/**
 * US-BUX5 — specs da recuperação de estouro de contexto.
 *
 * Cobre as funções PURAS (`isContextOverflowError`, `compactPrompt`) e a
 * integração LEVE do retry único no `CopilotCliRunner` (stubando o método
 * privado `spawnAndConsume` para não spawnar a CLI real).
 */

// --- isContextOverflowError: cada regex reconhece ---

const OVERFLOW_SAMPLES: Array<[string, string]> = [
  ['context length', 'Error: this model has a maximum context length of 128000 tokens'],
  ['context window', 'The context window was exceeded for this request'],
  ['context limit', 'context limit reached, please shorten the input'],
  ['context size', 'invalid context_size: too big'],
  ['maximum context', 'Maximum context reached'],
  ['too many tokens', 'Request failed: too many tokens in prompt'],
  ['token limit', 'You hit the token limit for this model'],
  ['tokens limit', 'tokens limit exceeded'],
  ['exceed context', 'This request exceeds the allowed context'],
  ['exceeded token', 'The prompt exceeded the token budget'],
  ['prompt is too long', 'Bad request: prompt is too long'],
];

for (const [label, sample] of OVERFLOW_SAMPLES) {
  test(`isContextOverflowError reconhece: ${label}`, () => {
    assert.equal(isContextOverflowError(sample), true);
  });
}

test('isContextOverflowError: texto não-overflow retorna false', () => {
  const nonOverflow = [
    'Error: connection refused',
    'ENOENT: no such file or directory',
    'not authenticated: please run copilot auth login',
    'spawn copilot ENOENT',
    'model unavailable',
    'rate limit exceeded', // menciona "exceeded" mas não contexto/token
    '',
    '   ',
  ];
  for (const s of nonOverflow) {
    assert.equal(isContextOverflowError(s), false, `deveria ser false: "${s}"`);
  }
});

test('isContextOverflowError: entrada não-string é segura', () => {
  assert.equal(
    isContextOverflowError(undefined as unknown as string),
    false,
  );
  assert.equal(isContextOverflowError(null as unknown as string), false);
});

// --- compactPrompt ---

test('compactPrompt: reduz tamanho e prepende a nota (multi-linha)', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `linha de conteudo numero ${i}`);
  const prompt = lines.join('\n');
  const out = compactPrompt(prompt);

  assert.ok(out.startsWith(COMPACTION_NOTE), 'deve prefixar a nota');
  assert.ok(out.length < prompt.length, 'deve reduzir o tamanho');
  // Mantém a metade mais ANTIGA, descarta a mais recente.
  assert.ok(out.includes('linha de conteudo numero 0'), 'preserva o início');
  assert.ok(!out.includes('linha de conteudo numero 19'), 'descarta o fim');
});

test('compactPrompt: determinístico (mesma entrada → mesma saída)', () => {
  const prompt = Array.from({ length: 30 }, (_, i) => `conteudo ${i} xyz`).join('\n');
  assert.equal(compactPrompt(prompt), compactPrompt(prompt));
});

test('compactPrompt: linha única longa corta pela metade dos caracteres', () => {
  const prompt = 'x'.repeat(1000);
  const out = compactPrompt(prompt);
  assert.ok(out.startsWith(COMPACTION_NOTE));
  assert.ok(out.length < prompt.length);
});

test('compactPrompt: prompt pequeno é no-op', () => {
  const small = 'faca X';
  assert.equal(compactPrompt(small), small);
});

test('compactPrompt: entrada não-string é segura', () => {
  assert.equal(
    compactPrompt(undefined as unknown as string),
    undefined as unknown as string,
  );
});

// --- integração leve do retry no runner ---

function makeConfig(): AppConfig {
  return {
    agent: {
      cliCommand: 'copilot',
      cliArgs: [],
      promptMode: 'stdin',
      hitlTimeoutMs: 1000,
      streamIdleTimeoutMs: 5000,
    },
  } as unknown as AppConfig;
}

function makeInput(prompt: string): AgentRunInput {
  return { prompt, cwd: process.cwd(), phase: 'implementation' } as unknown as AgentRunInput;
}

function okResult(): AgentRunResult {
  return {
    detail: 'ok',
    summary: 'ok',
    dodTouched: [],
    nextStep: '-',
    done: false,
  };
}

/** Substitui o `spawnAndConsume` privado por um stub que registra as chamadas. */
function stubSpawn(
  runner: CopilotCliRunner,
  impl: (input: AgentRunInput, call: number) => Promise<AgentRunResult>,
): { calls: AgentRunInput[] } {
  const calls: AgentRunInput[] = [];
  (runner as unknown as {
    spawnAndConsume: (input: AgentRunInput) => Promise<AgentRunResult>;
  }).spawnAndConsume = (input: AgentRunInput) => {
    calls.push(input);
    return impl(input, calls.length);
  };
  return { calls };
}

const LONG_PROMPT = Array.from({ length: 40 }, (_, i) => `passo ${i} do handoff`).join('\n');

test('run: retry ÚNICO com prompt compactado quando há estouro de contexto', async () => {
  const runner = new CopilotCliRunner(makeConfig());
  const { calls } = stubSpawn(runner, (_input, call) => {
    if (call === 1) {
      return Promise.reject(new Error('cli exited with code 1: maximum context length exceeded'));
    }
    return Promise.resolve(okResult());
  });

  const result = await runner.run(makeInput(LONG_PROMPT));
  assert.equal(result.summary, 'ok');
  assert.equal(calls.length, 2, 'exatamente 1 retry');
  assert.equal(calls[0].prompt, LONG_PROMPT, 'primeira tentativa: prompt original');
  assert.ok(
    calls[1].prompt.startsWith(COMPACTION_NOTE),
    'retry usa prompt compactado',
  );
});

test('run: NÃO faz retry infinito — segunda falha de contexto propaga', async () => {
  const runner = new CopilotCliRunner(makeConfig());
  const { calls } = stubSpawn(runner, () =>
    Promise.reject(new Error('context window exceeded')),
  );

  await assert.rejects(runner.run(makeInput(LONG_PROMPT)), /context window/);
  assert.equal(calls.length, 2, 'no máximo 2 tentativas (1 retry)');
});

test('run: erro NÃO-overflow propaga sem retry', async () => {
  const runner = new CopilotCliRunner(makeConfig());
  const { calls } = stubSpawn(runner, () =>
    Promise.reject(new Error('spawn copilot ENOENT')),
  );

  await assert.rejects(runner.run(makeInput(LONG_PROMPT)), /ENOENT/);
  assert.equal(calls.length, 1, 'sem retry para erro não relacionado');
});

test('run: abort (stop hard) nunca é recuperado', async () => {
  const runner = new CopilotCliRunner(makeConfig());
  const { calls } = stubSpawn(runner, () => Promise.reject(new Error('aborted')));

  await assert.rejects(runner.run(makeInput(LONG_PROMPT)), /aborted/);
  assert.equal(calls.length, 1, 'abort não dispara retry');
});
