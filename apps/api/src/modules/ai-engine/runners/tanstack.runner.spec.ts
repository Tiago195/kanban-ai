import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { TanStackRunner } from './tanstack.runner';
import { finalizeTurn } from './tanstack-marker-protocol';
import { AgentAdapterRegistry, isAdapterAvailable } from './agent-adapter.registry';
import { CopilotCliRunner } from './copilot-cli.runner';
import { MockAgentRunner } from './mock-agent.runner';
import type {
  AgentChunk,
  AgentQuestion,
  AgentRunInput,
  AgentRunResult,
} from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';
import type { AgentAdapterKind } from '@kanban-ai/shared';

/**
 * US-F3.4 — Specs do `TanStackRunner` (primeiro runner sobre `@tanstack/ai`).
 *
 * Valida contra um servidor FAKE OpenAI-compatível (chat completions + SSE),
 * sem rede externa nem credencial — o mesmo padrão do copilot fake da US-F3.2
 * e do MCP fake da US-F1.4. Os casos de PARIDADE espelham o oráculo da US-F3.2
 * (`cli-bridge.characterization.spec.ts`): o runner reusa o protocolo de
 * marcadores do bridge, então o comportamento — inclusive os degenerados
 * fixados como BUG-BRIDGE1 — deve BATER com o do caminho Copilot. Divergências
 * conscientes estão anotadas em cada caso e no cabeçalho de
 * `tanstack-marker-protocol.ts`.
 */

// ───────────────────────── Servidor fake OpenAI-compatível ─────────────────────────

/** Roteiro de UMA resposta do servidor fake. */
interface FakeScript {
  /** Deltas de content (um chunk SSE por item). */
  deltas?: string[];
  /** usage anexado ao chunk final (prompt/completion tokens). */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** 'mid' derruba a conexão após os deltas; 'immediate' derruba sem corpo. */
  drop?: 'mid' | 'immediate';
  /** true = envia os deltas e NUNCA fecha (para testar abort/idle). */
  hang?: boolean;
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
      if (script.drop === 'immediate') {
        // flushHeaders: sem headers enviados o client trata como connection
        // error e RETENTA (maxRetries do SDK), consumindo outro roteiro.
        res.flushHeaders();
        setTimeout(() => res.destroy(), 10);
        return;
      }
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-1' };
      const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      for (const delta of script.deltas ?? []) {
        res.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: delta } }] }));
      }
      if (script.hang) return; // deixa pendurado de propósito
      if (script.drop === 'mid') {
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.write(
        sse({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          ...(script.usage ? { usage: { ...script.usage, total_tokens: 0 } } : {}),
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

function makeConfig(overrides?: { baseUrl?: string; idleMs?: number }): AppConfig {
  return {
    agent: {
      streamIdleTimeoutMs: overrides?.idleMs ?? 5_000,
      tanstack: {
        baseUrl: overrides?.baseUrl ?? baseUrl,
        model: 'fake-1',
      },
    },
  } as unknown as AppConfig;
}

function runWith(
  script: FakeScript,
  inputOverrides?: Partial<AgentRunInput>,
  configOverrides?: { baseUrl?: string; idleMs?: number },
): Promise<AgentRunResult> {
  scripts.push(script);
  const runner = new TanStackRunner(makeConfig(configOverrides));
  return runner.run({
    cwd: process.cwd(),
    model: '',
    phase: 'implementation',
    prompt: 'faca algo',
    ...inputOverrides,
  } as AgentRunInput);
}

const RESULT_BLOCK = (json: string) =>
  `<<<KANBAN_RESULT>>>\n${json}\n<<<END_KANBAN_RESULT>>>`;

// ───────────────────── Paridade com o oráculo da US-F3.2 ─────────────────────

test('paridade: bloco KANBAN_RESULT completo — campos mapeados; evidence/learnings descartados (como no bridge)', async () => {
  const out = [
    'Fiz o trabalho da iteração.',
    RESULT_BLOCK(
      JSON.stringify({
        summary: 'implementei o parser',
        dodTouched: ['d1', 'd2'],
        affectedFlows: [{ name: 'loop', files: ['a.ts'], note: 'parser novo' }],
        nextStep: 'validar com specs',
        done: true,
        evidence: { checks: [{ name: 'test', passed: true }] },
        learnings: [{ path: 'modules/x.md', summary: 'aprendizado' }],
      }),
    ),
  ].join('\n');
  const r = await runWith({ deltas: [out] });
  assert.equal(r.summary, 'implementei o parser');
  assert.deepEqual(r.dodTouched, ['d1', 'd2']);
  assert.deepEqual(r.affectedFlows, [{ name: 'loop', files: ['a.ts'], note: 'parser novo' }]);
  assert.equal(r.nextStep, 'validar com specs');
  assert.equal(r.done, true);
  // detail é o texto INTEIRO, incluindo os marcadores (paridade com o bridge).
  assert.ok(r.detail.includes('<<<KANBAN_RESULT>>>'));
  assert.ok(r.detail.startsWith('Fiz o trabalho da iteração.'));
  // PARIDADE (BUG-BRIDGE1, preservado até a US-F3.5): evidence/learnings morrem.
  assert.ok(!('evidence' in r));
  assert.ok(!('learnings' in r));
  assert.equal(r.provider, 'tanstack');
});

test('paridade: bloco mínimo — summary ausente cai na ÚLTIMA linha (o marcador de fechamento)', async () => {
  const r = await runWith({ deltas: [`Prosa.\n${RESULT_BLOCK('{ "done": false }')}`] });
  assert.deepEqual(r.dodTouched, []);
  assert.equal(r.nextStep, '');
  assert.equal(r.done, false);
  assert.ok(!('proposedDod' in r));
  // PARIDADE (característica fixada no oráculo): fallback lastLine = marcador.
  assert.equal(r.summary, '<<<END_KANBAN_RESULT>>>');
});

test('paridade: prosa SEM bloco + stream ok → done:true (done fantasma preservado até a US-F3.5)', async () => {
  const out = 'Refatorei o módulo.\nTudo certo por aqui.';
  const r = await runWith({ deltas: [out] });
  assert.equal(r.done, true);
  assert.equal(r.summary, 'Tudo certo por aqui.');
  assert.equal(r.detail, out);
  assert.ok(!('fatalError' in r));
});

test('paridade: JSON inválido dentro do bloco → fallback silencioso (done:true)', async () => {
  const r = await runWith({
    deltas: [RESULT_BLOCK('{ summary: sem aspas, isto não é JSON }')],
  });
  assert.equal(r.done, true);
  assert.deepEqual(r.dodTouched, []);
  assert.equal(r.summary, '<<<END_KANBAN_RESULT>>>');
});

test('paridade: DOIS blocos KANBAN_RESULT → o PRIMEIRO vence (regex não-guloso)', async () => {
  const out = [
    RESULT_BLOCK(JSON.stringify({ summary: 'primeiro', done: false })),
    'texto entre blocos',
    RESULT_BLOCK(JSON.stringify({ summary: 'segundo', done: true })),
  ].join('\n');
  const r = await runWith({ deltas: [out] });
  assert.equal(r.summary, 'primeiro');
  assert.equal(r.done, false);
});

test('paridade: marcador de abertura SEM fechamento → bloco ignorado, fallback done:true', async () => {
  const r = await runWith({
    deltas: ['<<<KANBAN_RESULT>>>\n{ "summary": "x", "done": false }'],
  });
  assert.equal(r.done, true);
  assert.deepEqual(r.dodTouched, []);
});

test('paridade: RESULT e QUESTION juntos → a QUESTION vence; result do bloco é descartado', async () => {
  const questions: AgentQuestion[] = [];
  const out = [
    RESULT_BLOCK(JSON.stringify({ summary: 'resultado', done: true, dodTouched: ['d1'] })),
    '<<<KANBAN_QUESTION>>>',
    JSON.stringify({ prompt: 'Continuo?', options: ['sim', 'não'] }),
    '<<<END_KANBAN_QUESTION>>>',
  ].join('\n');
  const r = await runWith(
    { deltas: [out] },
    {
      onQuestion: (q) => {
        questions.push(q);
        return Promise.resolve('sim');
      },
    },
  );
  assert.equal(questions.length, 1);
  assert.equal(questions[0].prompt, 'Continuo?');
  assert.deepEqual(questions[0].options, ['sim', 'não']);
  assert.equal(r.done, false);
  assert.deepEqual(r.dodTouched, []);
  assert.equal(r.summary, 'AI aguardando decisão humana: Continuo?');
  assert.ok(r.nextStep.startsWith('Pergunta ao humano: Continuo?'));
  assert.ok(r.nextStep.includes('(opções: sim | não)'));
});

test('paridade: QUESTION com JSON inválido → sem pergunta; fallback done:true (HITL engolido, fixado no oráculo)', async () => {
  let asked = false;
  const r = await runWith(
    { deltas: ['<<<KANBAN_QUESTION>>>\n{ prompt sem aspas }\n<<<END_KANBAN_QUESTION>>>'] },
    { onQuestion: () => ((asked = true), Promise.resolve('x')) },
  );
  assert.equal(asked, false);
  assert.equal(r.done, true);
});

test('paridade: stream falhou (RUN_ERROR) COM texto de trabalho → done:false, sem fatalError', async () => {
  const r = await runWith({ deltas: ['trabalhei mas falhou algo'], drop: 'mid' });
  assert.equal(r.done, false);
  assert.ok(!('fatalError' in r));
});

test('paridade: stream falhou SEM texto → fatalError (infra, não iteração)', async () => {
  const r = await runWith({ drop: 'immediate' });
  assert.equal(r.done, false);
  assert.match(String(r.fatalError), /^fatal: stream TanStack falhou/);
});

test('paridade: padrão fatal conhecido no texto (não autenticado) → fatalError mesmo com stream ok', async () => {
  const r = await runWith({ deltas: ['Error: not authenticated. Please login.'] });
  assert.equal(r.done, false);
  assert.match(String(r.fatalError), /^fatal:/);
});

test('paridade: padrão fatal no texto MAS com bloco KANBAN_RESULT → o bloco vence, sem fatalError', async () => {
  const out = [
    'A rota antiga is not available; migrei para a nova.',
    RESULT_BLOCK(JSON.stringify({ summary: 'migração ok', done: true })),
  ].join('\n');
  const r = await runWith({ deltas: [out] });
  assert.ok(!('fatalError' in r));
  assert.equal(r.done, true);
});

test('paridade (finalizeTurn): resposta vazia com stream ok → done:true com detail sintético', () => {
  // Direto na função pura: o caso "copilot saiu limpo sem imprimir nada".
  const { result } = finalizeTurn('', '', false);
  assert.equal(result.done, true);
  // DIVERGÊNCIA COSMÉTICA consciente: o texto sintético diz "tanstack" em vez
  // de "Copilot CLI encerrou com código 0." (mesma semântica, outra origem).
  assert.equal(result.detail, '(tanstack) stream encerrou sem texto.');
});

// ───────────────────────── Streaming, tokens e provider ─────────────────────────

test('streaming: prosa vira chunks output linha a linha; linhas do bloco de controle NÃO vazam', async () => {
  const chunks: AgentChunk[] = [];
  const out = [
    'preâmbulo humano',
    RESULT_BLOCK(JSON.stringify({ summary: 'ok', done: false })),
  ].join('\n');
  // Deltas partidos no meio do marcador, para exercitar o buffer de linha.
  const r = await runWith(
    { deltas: [out.slice(0, 25), out.slice(25)], usage: { prompt_tokens: 1500, completion_tokens: 42 } },
    { onChunk: (c) => chunks.push(c) },
  );
  const outputs = chunks.filter((c) => c.kind === 'output').map((c) => c.delta);
  assert.ok(outputs.includes('preâmbulo humano'));
  assert.ok(outputs.every((t) => !t.includes('KANBAN_RESULT')));
  assert.ok(outputs.every((t) => !t.includes('"summary"')));
  // Telemetria do RUN_FINISHED (substitui o rodapé "Tokens ↑/↓" do Copilot).
  assert.equal(r.inputTokens, 1500);
  assert.equal(r.outputTokens, 42);
  assert.equal(r.provider, 'tanstack');
});

test('streaming: sem usage no stream → campos de tokens ausentes do result', async () => {
  const r = await runWith({ deltas: [RESULT_BLOCK('{"summary":"ok","done":false}')] });
  assert.ok(!('inputTokens' in r));
  assert.ok(!('outputTokens' in r));
});

// ───────────────────────────── Abort e idle timeout ─────────────────────────────

test('abort: input.signal aborta o stream de verdade e rejeita Error("aborted")', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(
    runWith({ deltas: ['parte1 '], hang: true }, { signal: ac.signal }),
    (err: Error) => {
      assert.equal(err.message, 'aborted');
      return true;
    },
  );
});

test('abort: signal JÁ abortado → rejeita sem sequer abrir conexão', async () => {
  const ac = new AbortController();
  ac.abort();
  const before = scripts.length;
  const runner = new TanStackRunner(makeConfig());
  await assert.rejects(
    runner.run({
      cwd: process.cwd(),
      model: '',
      phase: 'implementation',
      prompt: 'x',
      signal: ac.signal,
    } as AgentRunInput),
    /aborted/,
  );
  assert.equal(scripts.length, before); // nenhum roteiro consumido
});

test('idle timeout: provider mudo além de streamIdleTimeoutMs → rejeita com a MESMA mensagem do runner Copilot', async () => {
  await assert.rejects(
    runWith({ deltas: ['oi '], hang: true }, {}, { idleMs: 200 }),
    (err: Error) => {
      assert.equal(err.message, 'stream idle timeout (200ms)');
      return true;
    },
  );
});

// ───────────────────────────── Configuração e fatal ─────────────────────────────

test('config: TANSTACK_BASE_URL ausente → fatalError de config (fail-fast, sem rede)', async () => {
  const runner = new TanStackRunner(makeConfig({ baseUrl: '' }));
  const r = await runner.run({
    cwd: process.cwd(),
    model: '',
    phase: 'implementation',
    prompt: 'x',
  } as AgentRunInput);
  assert.equal(r.done, false);
  assert.equal(r.fatalError, 'config: TANSTACK_BASE_URL ausente');
  assert.equal(r.provider, 'tanstack');
});

test('config: endpoint inalcançável → fatalError de transporte (não queima iteração normal)', async () => {
  const r = await runWith({}, {}, { baseUrl: 'http://127.0.0.1:1/v1' });
  assert.equal(r.done, false);
  assert.match(String(r.fatalError), /^fatal: /);
});

// ───────────────────────────── Registry (US-F3.4) ─────────────────────────────

function makeRegistry(adapter: AgentAdapterKind) {
  const config = {
    agentAdapter: adapter,
    agent: {
      cliCommand: 'copilot',
      cliArgs: [],
      promptMode: 'stdin',
      hitlTimeoutMs: 1000,
      streamIdleTimeoutMs: 1000,
      tanstack: { baseUrl: '', model: '' },
    },
  } as unknown as AppConfig;
  const cli = new CopilotCliRunner(config);
  const mock = new MockAgentRunner();
  return { registry: new AgentAdapterRegistry(config, cli, mock), cli, mock };
}

test('registry: com mock ativo, o TanStackRunner NÃO é instanciado (lazy)', () => {
  const { registry, mock } = makeRegistry('mock');
  assert.equal(registry.resolveActive(), mock);
  assert.equal(
    (registry as unknown as { tanstack?: TanStackRunner }).tanstack,
    undefined,
  );
});

test('registry: resolve("tanstack") instancia lazy UMA vez e devolve o runner novo', () => {
  const { registry, cli } = makeRegistry('copilot-cli');
  const first = registry.resolve('tanstack');
  assert.equal(first.id, 'tanstack');
  assert.notEqual(first, cli); // copilot-cli NÃO passa pelo runner novo
  assert.equal(registry.resolve('tanstack'), first); // singleton lazy
  // E o caminho copilot-cli segue intocado:
  assert.equal(registry.resolve('copilot-cli'), cli);
});

test('registry: AGENT_ADAPTER=tanstack → resolveActive devolve o TanStackRunner', () => {
  const { registry } = makeRegistry('tanstack');
  assert.equal(registry.resolveActive().id, 'tanstack');
});

test('registry: dark launch — tanstack só aparece em listDescriptors quando é o ativo', () => {
  const inactive = makeRegistry('copilot-cli').registry.listDescriptors();
  // Catálogo IGUAL ao pré-US-F3.4 para quem não pediu o adapter novo.
  assert.deepEqual(
    inactive.map((d) => d.kind),
    ['copilot-cli', 'claude', 'codex', 'gemini', 'mock'],
  );
  const active = makeRegistry('tanstack').registry.listDescriptors();
  const ts = active.find((d) => d.kind === 'tanstack');
  assert.ok(ts, 'tanstack deve aparecer quando ativo');
  assert.equal(ts?.isDefault, true);
  assert.equal(active.filter((d) => d.isDefault).length, 1);
});

test('registry: available do tanstack deriva da PRESENÇA de TANSTACK_BASE_URL, sem vazar valor', () => {
  const savedUrl = process.env.TANSTACK_BASE_URL;
  const savedKey = process.env.TANSTACK_API_KEY;
  try {
    delete process.env.TANSTACK_BASE_URL;
    assert.equal(isAdapterAvailable('tanstack'), false);
    process.env.TANSTACK_BASE_URL = 'http://interno:9999/v1';
    process.env.TANSTACK_API_KEY = 'sk-tanstack-DO-NOT-LEAK';
    assert.equal(isAdapterAvailable('tanstack'), true);
    const serialized = JSON.stringify(makeRegistry('tanstack').registry.listDescriptors());
    assert.equal(serialized.includes('sk-tanstack-DO-NOT-LEAK'), false);
  } finally {
    if (savedUrl === undefined) delete process.env.TANSTACK_BASE_URL;
    else process.env.TANSTACK_BASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.TANSTACK_API_KEY;
    else process.env.TANSTACK_API_KEY = savedKey;
  }
});
