import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentAdapterRegistry,
  isAdapterAvailable,
} from './agent-adapter.registry';
import { CopilotCliRunner } from './copilot-cli.runner';
import { MockAgentRunner } from './mock-agent.runner';
import type { AppConfig } from '../../../shared/config/config';
import type { AgentAdapterKind } from '@kanban-ai/shared';

/**
 * Specs do registry de adapters multi-agente (US-OBS4 / ADR-0036).
 *
 * Prova: resolve `copilot-cli` por default; resolve `mock`; kind não-wired/
 * desconhecido cai no default `copilot-cli`; `listDescriptors` marca `available`
 * a partir da presença de env e NUNCA inclui o valor do segredo; o descritor
 * default é sinalizado corretamente.
 */

function makeConfig(adapter: AgentAdapterKind): AppConfig {
  return {
    agentAdapter: adapter,
    agent: {
      cliCommand: 'copilot',
      cliArgs: [],
      promptMode: 'stdin',
      hitlTimeoutMs: 1000,
      streamIdleTimeoutMs: 1000,
    },
  } as unknown as AppConfig;
}

function makeRegistry(adapter: AgentAdapterKind = 'copilot-cli'): {
  registry: AgentAdapterRegistry;
  cli: CopilotCliRunner;
  mock: MockAgentRunner;
} {
  const config = makeConfig(adapter);
  const cli = new CopilotCliRunner(config);
  const mock = new MockAgentRunner();
  const registry = new AgentAdapterRegistry(config, cli, mock);
  return { registry, cli, mock };
}

/** Salva/restaura envs de credencial para não vazar entre testes. */
const CRED_ENVS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];

function withCleanEnv(fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const name of CRED_ENVS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    fn();
  } finally {
    for (const name of CRED_ENVS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test('resolveActive → copilot-cli por default (não-regressão)', () => {
  const { registry, cli } = makeRegistry('copilot-cli');
  const active = registry.resolveActive();
  assert.equal(active, cli);
  assert.equal(active.id, 'copilot-cli');
});

test('resolve("mock") → MockAgentRunner', () => {
  const { registry, mock } = makeRegistry('copilot-cli');
  const resolved = registry.resolve('mock');
  assert.equal(resolved, mock);
  assert.equal(resolved.id, 'mock');
});

test('US-F3.9: claude/codex/gemini têm runner dedicado (não caem mais no default)', () => {
  // Substitui o caso pré-F3.9 "kind não-wired cai no default": os três vendors
  // agora resolvem para o TanStackRunner com o adapter oficial de cada um.
  const { registry, cli } = makeRegistry('copilot-cli');
  for (const kind of ['claude', 'codex', 'gemini'] as AgentAdapterKind[]) {
    const runner = registry.resolve(kind);
    assert.notEqual(runner, cli, `kind ${kind} não deve cair no default`);
    assert.equal(runner.id, kind);
  }
});

test('resolve de kind desconhecido cai no default copilot-cli', () => {
  const { registry, cli } = makeRegistry('copilot-cli');
  assert.equal(registry.resolve('nope' as AgentAdapterKind), cli);
});

test('resolveActive respeita config.agentAdapter (mock)', () => {
  const { registry, mock } = makeRegistry('mock');
  assert.equal(registry.resolveActive(), mock);
});

test('listDescriptors marca o adapter ativo como isDefault', () => {
  const { registry } = makeRegistry('copilot-cli');
  const descriptors = registry.listDescriptors();
  const kinds = descriptors.map((d) => d.kind);
  assert.deepEqual(kinds, ['copilot-cli', 'claude', 'codex', 'gemini', 'mock']);
  const defaults = descriptors.filter((d) => d.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].kind, 'copilot-cli');
});

test('listDescriptors: available deriva da presença de env, mock sempre true', () => {
  withCleanEnv(() => {
    const { registry } = makeRegistry('copilot-cli');
    const byKind = new Map(registry.listDescriptors().map((d) => [d.kind, d]));
    // Sem credenciais no ambiente limpo:
    assert.equal(byKind.get('mock')!.available, true);
    assert.equal(byKind.get('copilot-cli')!.available, false);
    assert.equal(byKind.get('claude')!.available, false);

    // Presença de token liga o available (sem expor valor):
    process.env.GITHUB_TOKEN = 'ghp_super_secret_value';
    assert.equal(isAdapterAvailable('copilot-cli'), true);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    assert.equal(isAdapterAvailable('claude'), true);
  });
});

test('listDescriptors NUNCA inclui o valor do segredo no payload', () => {
  withCleanEnv(() => {
    const secret = 'ghp_TOP_SECRET_TOKEN_1234567890';
    process.env.GITHUB_TOKEN = secret;
    const secret2 = 'sk-ant-DO-NOT-LEAK';
    process.env.ANTHROPIC_API_KEY = secret2;
    const { registry } = makeRegistry('copilot-cli');
    const serialized = JSON.stringify(registry.listDescriptors());
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(secret2), false);
    // available reflete a presença, mesmo sem vazar o segredo:
    const byKind = new Map(registry.listDescriptors().map((d) => [d.kind, d]));
    assert.equal(byKind.get('copilot-cli')!.available, true);
    assert.equal(byKind.get('claude')!.available, true);
  });
});

test('env vazia/espaços não conta como disponível', () => {
  withCleanEnv(() => {
    process.env.GITHUB_TOKEN = '   ';
    assert.equal(isAdapterAvailable('copilot-cli'), false);
  });
});
