import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CopilotCliRunner } from './copilot-cli.runner';
import type { AgentRunInput, AgentRunResult } from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';

/**
 * Spec de integração do backfill de tokens no runner REAL (`CopilotCliRunner`).
 *
 * Prova o caminho ponta-a-ponta que alimenta a persistência da `Iteration`:
 * stdout da CLI (JSONL `result` SEM tokens) + rodapé de stats CRU → o runner
 * parseia o rodapé e faz backfill no `AgentRunResult` resolvido. As strings do
 * rodapé são o formato REAL capturado da Copilot CLI 1.0.79.
 *
 * Testa a lógica de `consume` (privado) com um child process fake — sem spawnar
 * a CLI real nem rodar o loop, mantendo o teste determinístico e barato.
 */

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

/** Child process fake: stdout/stderr como streams, stdin drenável, emitter. */
function makeFakeChild() {
  const child = new EventEmitter() as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: (sig?: string) => boolean;
    emit: (event: string, ...args: unknown[]) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  return child;
}

function makeInput(): AgentRunInput {
  return {
    prompt: 'faca algo',
    cwd: process.cwd(),
    phase: 'implementation',
  } as unknown as AgentRunInput;
}

/** Invoca o `consume` privado com o child fake e um roteiro de linhas de stdout. */
function runConsume(lines: string[]): Promise<AgentRunResult> {
  const runner = new CopilotCliRunner(makeConfig());
  const child = makeFakeChild();
  const priv = runner as unknown as {
    consume: (
      c: unknown,
      input: AgentRunInput,
      stdinPrompt: string | null,
    ) => Promise<AgentRunResult>;
  };
  const promise = priv.consume(child, makeInput(), null);
  // Emite as linhas no próximo tick e fecha o processo com code 0.
  setImmediate(() => {
    for (const l of lines) child.stdout.write(`${l}\n`);
    child.stdout.end();
    setImmediate(() => child.emit('close', 0));
  });
  return promise;
}

test('runner backfill: rodapé real da CLI popula tokens quando o result JSONL não traz', async () => {
  const resultLine = JSON.stringify({
    kind: 'result',
    summary: 'ok',
    detail: 'feito',
    dodTouched: [],
    nextStep: '-',
    done: false,
    // NOTA: sem inputTokens/outputTokens — o caso comum real.
  });
  const result = await runConsume([
    resultLine,
    '',
    'Changes    +0 -0',
    'AI Credits 0 (14s)',
    'Tokens     \u2191 48.4k (48.2k written) \u2022 \u2193 4',
    'Resume     copilot --resume=abc',
  ]);
  assert.equal(result.inputTokens, 48_400);
  assert.equal(result.outputTokens, 4);
});

test('runner backfill: NÃO sobrescreve tokens que o result JSONL já trouxe', async () => {
  const resultLine = JSON.stringify({
    kind: 'result',
    summary: 'ok',
    detail: 'feito',
    dodTouched: [],
    nextStep: '-',
    done: false,
    inputTokens: 100,
    outputTokens: 20,
  });
  const result = await runConsume([
    resultLine,
    'Tokens     \u2191 48.4k \u2022 \u2193 4',
  ]);
  // O valor estruturado do result tem precedência sobre o rodapé.
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 20);
});

test('runner backfill: sem rodapé de tokens, permanece undefined (não inventa)', async () => {
  const resultLine = JSON.stringify({
    kind: 'result',
    summary: 'ok',
    detail: 'feito',
    dodTouched: [],
    nextStep: '-',
    done: false,
  });
  const result = await runConsume([resultLine, 'Changes    +0 -0']);
  assert.equal(result.inputTokens, undefined);
  assert.equal(result.outputTokens, undefined);
});
