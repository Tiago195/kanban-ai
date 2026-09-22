import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { TanStackRunner } from './tanstack.runner';
import {
  AgentAdapterRegistry,
  isAdapterAvailable,
} from './agent-adapter.registry';
import { CopilotCliRunner } from './copilot-cli.runner';
import { MockAgentRunner } from './mock-agent.runner';
import type { AgentRunInput, AgentRunResult } from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';
import type { AgentAdapterKind } from '@kanban-ai/shared';

/**
 * US-F3.9 — Vendors `claude`/`codex`/`gemini` wired sobre o `TanStackRunner`.
 *
 * Tudo sem rede externa e sem credencial real (mesma filosofia da F3.2/F3.4):
 *  1. registry: os três kinds resolvem para runner dedicado (id = kind),
 *     cacheado, SEM o warning de não-wired; kind desconhecido AINDA cai no
 *     default com warning.
 *  2. catálogo: `available` por presença de env do vendor; a serialização dos
 *     descritores NUNCA contém o valor de nenhuma credencial (invariante
 *     US-OBS4, agora coberta para os três vendors).
 *  3. credencial ausente → erro FATAL de config (BUG-A7), sem tocar a rede.
 *  4. `codex` exercitado PONTA A PONTA contra um fake da **Responses API** da
 *     OpenAI (o wire real do adapter `createOpenaiChat`; o fake chat-completions
 *     das F3.4/F3.5 fala outro protocolo) — produz `AgentRunResult` completo.
 *  5. `claude`/`gemini`: o wire é PROPRIETÁRIO (Messages API / GenAI) — sem
 *     fake dedicado, o que se fixa aqui é o caminho completo até o transporte:
 *     módulo ESM carrega, factory constrói com a credencial do env, e uma
 *     falha de conexão (porta fechada em 127.0.0.1, determinística) vira
 *     resultado graceful (`done:false` + fatalError), nunca crash. A cobertura
 *     que falta (stream feliz desses dois vendors) está anotada no reporte da
 *     história — não inventamos fake de wire que não conhecemos de ponta a
 *     ponta.
 */

// ─────────────── Fake da Responses API da OpenAI (para o codex) ───────────────

interface ResponsesScript {
  /** Deltas de output_text (um evento SSE por item). */
  deltas: string[];
  usage?: { input_tokens: number; output_tokens: number };
}

const scripts: ResponsesScript[] = [];
const requests: Array<Record<string, unknown>> = [];
let server: Server;
let responsesBaseUrl = '';
/** Porta de 127.0.0.1 garantidamente FECHADA (aberta e liberada no before). */
let closedPort = 0;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        requests.push({});
      }
      const script = scripts.shift() ?? { deltas: [] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      res.write(sse({ type: 'response.created', response: { model: 'fake-1' } }));
      for (const delta of script.deltas) {
        res.write(sse({ type: 'response.output_text.delta', delta }));
      }
      res.write(
        sse({
          type: 'response.completed',
          response: {
            model: 'fake-1',
            output: [],
            ...(script.usage
              ? {
                  usage: {
                    ...script.usage,
                    total_tokens:
                      script.usage.input_tokens + script.usage.output_tokens,
                  },
                }
              : {}),
          },
        }),
      );
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server sem porta');
  responsesBaseUrl = `http://127.0.0.1:${addr.port}/v1`;

  // Porta fechada determinística para os testes de falha de conexão.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const probeAddr = probe.address();
  if (!probeAddr || typeof probeAddr === 'string') throw new Error('probe sem porta');
  closedPort = probeAddr.port;
  await new Promise<void>((r) => probe.close(() => r()));
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

// ───────────────────────────── Helpers de env/config ─────────────────────────────

/** Todas as envs que a US-F3.9 lê — salvas/limpas por teste (nunca vazam). */
const VENDOR_ENVS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'CLAUDE_MODEL',
  'CLAUDE_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_MODEL',
  'CODEX_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_BASE_URL',
];

async function withEnv(
  env: Record<string, string>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of VENDOR_ENVS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  try {
    await fn();
  } finally {
    for (const name of VENDOR_ENVS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function makeConfig(adapter: AgentAdapterKind = 'copilot-cli'): AppConfig {
  return {
    agentAdapter: adapter,
    agent: {
      cliCommand: 'copilot',
      cliArgs: [],
      promptMode: 'stdin',
      hitlTimeoutMs: 1000,
      streamIdleTimeoutMs: 5_000,
      tanstack: { baseUrl: '', model: '' },
    },
  } as unknown as AppConfig;
}

function makeRegistry(adapter: AgentAdapterKind = 'copilot-cli'): {
  registry: AgentAdapterRegistry;
  cli: CopilotCliRunner;
  warns: string[];
} {
  const config = makeConfig(adapter);
  const cli = new CopilotCliRunner(config);
  const registry = new AgentAdapterRegistry(config, cli, new MockAgentRunner());
  const warns: string[] = [];
  // O resolve só usa warn; capturamos para provar a AUSÊNCIA do warning.
  (registry as unknown as { logger: { warn(m: string): void } }).logger = {
    warn: (m: string) => warns.push(m),
  };
  return { registry, cli, warns };
}

function runVendor(
  kind: 'claude' | 'codex' | 'gemini',
  inputOverrides?: Partial<AgentRunInput>,
): Promise<AgentRunResult> {
  const runner = new TanStackRunner(makeConfig(), kind);
  return runner.run({
    cwd: process.cwd(),
    model: 'fake-1',
    phase: 'implementation',
    prompt: 'faca algo',
    ...inputOverrides,
  } as AgentRunInput);
}

const VENDORS = ['claude', 'codex', 'gemini'] as const;

// ───────────────────────── 1. wiring no registry ─────────────────────────

test('US-F3.9: cada vendor resolve para TanStackRunner dedicado, SEM warning de não-wired', () => {
  const { registry, cli, warns } = makeRegistry();
  for (const kind of VENDORS) {
    const runner = registry.resolve(kind);
    assert.ok(runner instanceof TanStackRunner, `${kind} deve ser TanStackRunner`);
    assert.equal(runner.id, kind);
    assert.notEqual(runner, cli);
    // Cacheado: o mesmo resolve devolve a MESMA instância (lazy, uma por kind).
    assert.equal(registry.resolve(kind), runner);
  }
  // Instâncias distintas por kind (cada uma com seu adapter de vendor).
  assert.equal(new Set(VENDORS.map((k) => registry.resolve(k))).size, 3);
  assert.deepEqual(warns, [], 'nenhum warning para kinds wired');
});

test('US-F3.9: kind desconhecido AINDA cai no default copilot-cli, com warning', () => {
  const { registry, cli, warns } = makeRegistry();
  assert.equal(registry.resolve('nope' as AgentAdapterKind), cli);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /desconhecido/);
});

// ───────────────────── 2. catálogo: available sem segredo ─────────────────────

test('US-F3.9: available por vendor deriva da presença da env de credencial', async () => {
  await withEnv({}, () => {
    for (const kind of VENDORS) assert.equal(isAdapterAvailable(kind), false);
    process.env.CLAUDE_API_KEY = 'x';
    process.env.CODEX_API_KEY = 'x';
    process.env.GOOGLE_API_KEY = 'x';
    for (const kind of VENDORS) assert.equal(isAdapterAvailable(kind), true);
  });
});

test('US-F3.9: serialização dos descritores NUNCA contém credencial de NENHUM vendor', async () => {
  const secrets = {
    ANTHROPIC_API_KEY: 'sk-ant-VENDOR-LEAK-1',
    CLAUDE_API_KEY: 'sk-ant-VENDOR-LEAK-2',
    OPENAI_API_KEY: 'sk-proj-VENDOR-LEAK-3',
    CODEX_API_KEY: 'sk-proj-VENDOR-LEAK-4',
    GEMINI_API_KEY: 'AIza-VENDOR-LEAK-5',
    GOOGLE_API_KEY: 'AIza-VENDOR-LEAK-6',
  };
  await withEnv(secrets, () => {
    const { registry } = makeRegistry();
    const descriptors = registry.listDescriptors();
    const serialized = JSON.stringify(descriptors);
    for (const value of Object.values(secrets)) {
      assert.equal(serialized.includes(value), false, `vazou ${value.slice(0, 8)}…`);
    }
    const byKind = new Map(descriptors.map((d) => [d.kind, d]));
    for (const kind of VENDORS) {
      assert.equal(byKind.get(kind)!.available, true);
    }
  });
});

// ──────────────── 3. credencial ausente = fatal de config, sem rede ────────────────

test('US-F3.9: sem credencial do vendor, run() retorna fatalError de config (sem rede)', async () => {
  await withEnv({}, async () => {
    for (const kind of VENDORS) {
      const r = await runVendor(kind);
      assert.equal(r.done, false, kind);
      assert.equal(r.provider, kind);
      assert.match(r.fatalError ?? '', /config: credencial ausente/, kind);
      // A mensagem aponta as envs a configurar (sem nunca ecoar valor).
      assert.match(r.nextStep, /_API_KEY/, kind);
    }
  });
});

// ───────────── 4. codex ponta a ponta contra o fake da Responses API ─────────────

test('US-F3.9: codex e2e — Responses API fake produz AgentRunResult completo (schema + usage)', async () => {
  await withEnv(
    {
      OPENAI_API_KEY: 'sk-proj-fake-nao-e-segredo',
      CODEX_BASE_URL: responsesBaseUrl,
      CODEX_MODEL: 'fake-1',
    },
    async () => {
      requests.length = 0;
      scripts.push({
        deltas: [
          JSON.stringify({
            response: {
              kind: 'result',
              summary: 'implementado via codex',
              dodTouched: ['d1'],
              nextStep: 'validar',
              done: false,
            },
          }),
        ],
        usage: { input_tokens: 70, output_tokens: 9 },
      });
      const r = await runVendor('codex');
      assert.equal(r.summary, 'implementado via codex');
      assert.deepEqual(r.dodTouched, ['d1']);
      assert.equal(r.nextStep, 'validar');
      assert.equal(r.done, false);
      assert.equal(r.fatalError, undefined);
      assert.equal(r.provider, 'codex');
      assert.equal(r.inputTokens, 70);
      assert.equal(r.outputTokens, 9);
      // O request do vendor também leva o schema da iteração (US-F3.5 vale
      // para o caminho de vendor — aqui como text.format da Responses API).
      assert.ok(
        JSON.stringify(requests[0]).includes('dodTouched'),
        'outputSchema deve chegar ao provider',
      );
    },
  );
});

// ──────── 5. claude/gemini: transporte tentado de verdade, falha graceful ────────

for (const kind of ['claude', 'gemini'] as const) {
  test(`US-F3.9: ${kind} — factory constrói e falha de conexão vira fatalError graceful`, async () => {
    // Porta fechada em 127.0.0.1: prova que o módulo ESM do vendor carrega, a
    // factory aceita credencial/modelo/override de endpoint e o wire REAL é
    // tentado — sem rede externa e sem crash. O stream feliz destes wires
    // proprietários fica sem fake (cobertura anotada no reporte da história).
    const env: Record<string, string> =
      kind === 'claude'
        ? {
            ANTHROPIC_API_KEY: 'sk-ant-fake-nao-e-segredo',
            CLAUDE_BASE_URL: `http://127.0.0.1:${closedPort}`,
          }
        : {
            GEMINI_API_KEY: 'AIza-fake-nao-e-segredo',
            GEMINI_BASE_URL: `http://127.0.0.1:${closedPort}`,
          };
    await withEnv(env, async () => {
      const r = await runVendor(kind);
      assert.equal(r.done, false);
      assert.equal(r.provider, kind);
      assert.ok(r.fatalError, `falha de infra deve ser fatal (veio: ${r.summary})`);
    });
  });
}
