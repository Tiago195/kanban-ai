import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  TanStackRunner,
  createTokenAccounting,
  extractUsage,
} from './tanstack.runner';
import type { AgentRunInput, AgentRunResult } from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';

/**
 * US-F3.7 — Contabilidade de token por `onUsage`.
 *
 * A spec de CARACTERIZAÇÃO abaixo é o entregável central da história: ela FIXA,
 * contra o TanStack 0.52 real (sem mocks do engine), a diferença entre
 *
 *   (a) o `usage` do RUN_FINISHED terminal / `info.usage` do onFinish — o que a
 *       contagem antiga usava — que num run multi-chamada reflete SOMENTE a
 *       ÚLTIMA chamada ao provider; e
 *   (b) a SOMA dos eventos `onUsage` — uma por chamada ao provider, incluindo a
 *       finalização do structured output — que é o total correto.
 *
 * Se um bump da dependência mudar qualquer um dos dois lados (ex.: o terminal
 * passar a acumular), esta spec quebra ALTO em vez da contagem derivar em
 * silêncio.
 *
 * Modo NATIVO COMBINADO (`openaiCompatibleText`, confirmado na F3.5): o JSON
 * estruturado sai de uma iteração normal do agent loop — num run SEM tools há
 * uma única chamada e (a) == (b). A divergência aparece com mais de uma chamada
 * (tools) — é o cenário fixado aqui — ou com adapter de finalização separada
 * (F3.8+).
 */

// ───────────────────────── Servidor fake OpenAI-compatível ─────────────────────────

/** Roteiro de UMA resposta: ou um tool_call, ou content; usage no chunk final. */
interface FakeScript {
  toolCall?: { name: string; args: string };
  content?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const scripts: FakeScript[] = [];
let server: Server;
let baseUrl = '';

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const script = scripts.shift() ?? {};
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-1' };
      const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      if (script.toolCall) {
        res.write(
          sse({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 't1',
                      type: 'function',
                      function: { name: script.toolCall.name, arguments: script.toolCall.args },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } else if (script.content !== undefined) {
        res.write(
          sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: script.content } }] }),
        );
      }
      res.write(
        sse({
          ...base,
          choices: [
            { index: 0, delta: {}, finish_reason: script.toolCall ? 'tool_calls' : 'stop' },
          ],
          ...(script.usage
            ? { usage: { ...script.usage, total_tokens: script.usage.prompt_tokens + script.usage.completion_tokens } }
            : {}),
        }),
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server sem porta');
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

/** Resposta estruturada do "modelo" (raiz {response: ...}, como na F3.5). */
const STRUCTURED = JSON.stringify({
  response: { kind: 'result', summary: 'ok', dodTouched: [], nextStep: '', done: false },
});

// ───────── 1. Caracterização: onUsage soma TUDO; o terminal só vê a última ─────────

/** Mesmo `import()` dinâmico protegido do downlevel usado pelo runner. */
const dynamicImport = new Function('s', 'return import(s)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

test('caracterização 0.52: num run com tools + outputSchema, o usage terminal reflete só a última chamada; a soma do onUsage cobre todas', async () => {
  const core = await dynamicImport('@tanstack/ai');
  const compat = await dynamicImport('@tanstack/ai-openai/compatible');
  const chat = core.chat as (opts: Record<string, unknown>) => AsyncIterable<{
    type: string;
    usage?: unknown;
  }>;
  const openaiCompatibleText = compat.openaiCompatibleText as (
    model: string,
    cfg: { baseURL: string; apiKey: string },
  ) => unknown;
  const toolDefinition = core.toolDefinition as (def: Record<string, unknown>) => {
    server: (impl: Record<string, unknown>) => unknown;
  };

  // Duas chamadas ao provider dentro de UM run:
  //   1ª (agent loop): tool call, usage 700/20;
  //   2ª (nativo combinado): JSON estruturado, usage 300/10.
  scripts.length = 0;
  scripts.push(
    { toolCall: { name: 'soma', args: '{"a":1,"b":2}' }, usage: { prompt_tokens: 700, completion_tokens: 20 } },
    { content: STRUCTURED, usage: { prompt_tokens: 300, completion_tokens: 10 } },
  );

  const soma = toolDefinition({
    name: 'soma',
    description: 'soma dois numeros',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  }).server({
    execute: ({ a, b }: { a: number; b: number }) => Promise.resolve({ result: a + b }),
  });

  const accounting = createTokenAccounting();
  let finishUsage: unknown = 'nunca-disparou';
  const stream = chat({
    adapter: openaiCompatibleText('fake-1', { baseURL: baseUrl, apiKey: 'x' }),
    messages: [{ role: 'user', content: 'oi' }],
    tools: [soma],
    outputSchema: {
      type: 'object',
      properties: { response: { type: 'object' } },
      required: ['response'],
      additionalProperties: false,
    },
    stream: true,
    middleware: [
      accounting.middleware,
      { name: 'probe-finish', onFinish: (_ctx: unknown, info: { usage?: unknown }) => (finishUsage = info.usage) },
    ],
    debug: false,
  });

  let runFinishedUsage: unknown;
  for await (const chunk of stream) {
    if (chunk.type === 'RUN_FINISHED') runFinishedUsage = chunk.usage;
  }

  // (a) O que a contagem ANTIGA usaria: usage do RUN_FINISHED terminal — só a
  // última chamada (300/10). O onFinish `info.usage` reporta o mesmo.
  assert.deepEqual(extractUsage(runFinishedUsage), { inputTokens: 300, outputTokens: 10 });
  assert.deepEqual(extractUsage(finishUsage), { inputTokens: 300, outputTokens: 10 });

  // (b) O que o onUsage soma: TODAS as chamadas (700+300 / 20+10).
  assert.equal(accounting.events, 2);
  assert.deepEqual(accounting.totals(), { inputTokens: 1000, outputTokens: 30 });

  // A DIFERENÇA é o ponto da história: se este assert falhar num bump (terminal
  // passou a acumular), a caracterização mudou — reavaliar a contagem.
  assert.notDeepEqual(accounting.totals(), extractUsage(runFinishedUsage));
});

// ───────── 2. Runner e2e: a soma do onUsage alimenta o AgentRunResult ─────────

function makeConfig(): AppConfig {
  return {
    agent: {
      streamIdleTimeoutMs: 5_000,
      tanstack: { baseUrl, model: 'fake-1' },
    },
  } as unknown as AppConfig;
}

function runWith(...run: FakeScript[]): Promise<AgentRunResult> {
  scripts.length = 0;
  scripts.push(...run);
  const runner = new TanStackRunner(makeConfig());
  return runner.run({
    cwd: process.cwd(),
    model: '',
    phase: 'implementation',
    prompt: 'faca algo',
  } as AgentRunInput);
}

test('runner: run com structured output → tokens do onUsage e provider tanstack no result', async () => {
  // Sem tools + nativo combinado = UMA chamada; soma onUsage == terminal (o
  // caso onde os dois lados COINCIDEM — a divergência está fixada acima).
  const r = await runWith({ content: STRUCTURED, usage: { prompt_tokens: 1500, completion_tokens: 42 } });
  assert.equal(r.inputTokens, 1500);
  assert.equal(r.outputTokens, 42);
  assert.equal(r.provider, 'tanstack');
  // Os mesmos campos que o orchestrator persiste na Iteration e que
  // computeStoryMetrics/FleetCostSummary somam (inputTokens/outputTokens).
});

test('runner: provider sem usage → campos de tokens AUSENTES (não zero)', async () => {
  const r = await runWith({ content: STRUCTURED });
  assert.ok(!('inputTokens' in r));
  assert.ok(!('outputTokens' in r));
  assert.equal(r.provider, 'tanstack');
});

// ───────── 3. Forma array SpecTokenUsage (débito da F3.4) e unidades ─────────

test('extractUsage: forma array SpecTokenUsage é SOMADA (débito F3.4 quitado)', () => {
  assert.deepEqual(
    extractUsage([
      { provider: 'openai', model: 'm1', inputTokens: 100, outputTokens: 7 },
      { provider: 'ollama', model: 'm2', inputTokens: 50, outputTokens: 3 },
    ]),
    { inputTokens: 150, outputTokens: 10 },
  );
});

test('extractUsage: array com entradas malformadas ignora o lixo e preserva ausência', () => {
  // Entrada sem tokens, valores não-numéricos e não-objetos não contaminam.
  assert.deepEqual(
    extractUsage([null, 'x', { inputTokens: 'muitos' }, { outputTokens: 5 }]),
    { outputTokens: 5 },
  );
  assert.deepEqual(extractUsage([]), {});
  assert.deepEqual(extractUsage([{ provider: 'p' }]), {});
});

test('extractUsage: forma objeto TokenUsage segue valendo; ausência = {}', () => {
  assert.deepEqual(
    extractUsage({ promptTokens: 9, completionTokens: 4, totalTokens: 13 }),
    { inputTokens: 9, outputTokens: 4 },
  );
  assert.deepEqual(extractUsage(undefined), {});
  assert.deepEqual(extractUsage(null), {});
  assert.deepEqual(extractUsage({ promptTokens: Number.NaN }), {});
});

test('createTokenAccounting: soma multi-evento, ignora evento vazio, ausência por lado', () => {
  const acc = createTokenAccounting();
  const onUsage = (acc.middleware as { onUsage: (c: unknown, u: unknown) => void }).onUsage;
  assert.equal(acc.events, 0);
  assert.deepEqual(acc.totals(), {});
  onUsage(null, { promptTokens: 700, completionTokens: 20, totalTokens: 720 });
  onUsage(null, {}); // evento sem tokens não conta
  onUsage(null, { promptTokens: 300, completionTokens: 10, totalTokens: 310 });
  assert.equal(acc.events, 2);
  assert.deepEqual(acc.totals(), { inputTokens: 1000, outputTokens: 30 });
  // Lado nunca reportado permanece AUSENTE (não vira zero).
  const so = createTokenAccounting();
  const soOnUsage = (so.middleware as { onUsage: (c: unknown, u: unknown) => void }).onUsage;
  soOnUsage(null, { completionTokens: 8 });
  assert.deepEqual(so.totals(), { outputTokens: 8 });
});
