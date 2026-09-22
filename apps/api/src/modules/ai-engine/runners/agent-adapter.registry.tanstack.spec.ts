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
 * US-F3.8 — Catálogo do adapter `tanstack` após o fim do dark launch
 * incondicional da F3.4.
 *
 * Com o caminho Ollama (endpoint OpenAI-compatível local, sem credencial) o
 * adapter deixou de ser inacessível: `listDescriptors` passa a incluir
 * 'tanstack' quando ele é o ATIVO **ou** quando há endpoint configurado
 * (`config.agent.tanstack.baseUrl`, env TANSTACK_BASE_URL). Sem endpoint e sem
 * estar ativo, segue invisível — a spec pré-existente do registry (lista exata
 * por deepEqual, sem tanstack) continua fixando esse caso.
 *
 * A visibilidade deriva da CONFIG (não do process.env direto) de propósito:
 * determinístico nos specs e mesma fonte que o runner usa. Nada aqui depende de
 * daemon/rede — o Ollama de verdade é validação manual documentada no
 * .env.example.
 */

function makeConfig(adapter: AgentAdapterKind, tanstackBaseUrl?: string): AppConfig {
  return {
    agentAdapter: adapter,
    agent: {
      cliCommand: 'copilot',
      cliArgs: [],
      promptMode: 'stdin',
      hitlTimeoutMs: 1000,
      streamIdleTimeoutMs: 1000,
      tanstack: { baseUrl: tanstackBaseUrl ?? '', model: '' },
    },
  } as unknown as AppConfig;
}

function makeRegistry(
  adapter: AgentAdapterKind,
  tanstackBaseUrl?: string,
): AgentAdapterRegistry {
  const config = makeConfig(adapter, tanstackBaseUrl);
  return new AgentAdapterRegistry(
    config,
    new CopilotCliRunner(config),
    new MockAgentRunner(),
  );
}

test('tanstack fora do catálogo sem endpoint configurado e sem estar ativo', () => {
  const kinds = makeRegistry('copilot-cli').listDescriptors().map((d) => d.kind);
  assert.equal(kinds.includes('tanstack'), false);
});

test('tanstack entra no catálogo quando TANSTACK_BASE_URL está configurado (ex.: Ollama)', () => {
  const descriptors = makeRegistry('copilot-cli', 'http://127.0.0.1:11434/v1').listDescriptors();
  const tanstack = descriptors.find((d) => d.kind === 'tanstack');
  assert.ok(tanstack, 'tanstack deve aparecer com endpoint configurado');
  assert.equal(tanstack.isDefault, false, 'configurado ≠ ativo');
  assert.equal(tanstack.displayName, 'TanStack AI (OpenAI-compatível)');
  // O payload nunca inclui o valor do endpoint (só o descritor).
  assert.equal(JSON.stringify(descriptors).includes('11434'), false);
});

test('tanstack entra no catálogo (e isDefault) quando é o adapter ativo, mesmo sem endpoint', () => {
  const tanstack = makeRegistry('tanstack')
    .listDescriptors()
    .find((d) => d.kind === 'tanstack');
  assert.ok(tanstack, 'tanstack ativo deve aparecer mesmo sem baseUrl');
  assert.equal(tanstack.isDefault, true);
});

test('available do tanstack deriva da PRESENÇA de TANSTACK_BASE_URL no env (sem segredo)', () => {
  const saved = process.env.TANSTACK_BASE_URL;
  try {
    delete process.env.TANSTACK_BASE_URL;
    assert.equal(isAdapterAvailable('tanstack'), false);
    process.env.TANSTACK_BASE_URL = 'http://127.0.0.1:11434/v1';
    assert.equal(isAdapterAvailable('tanstack'), true);
  } finally {
    if (saved === undefined) delete process.env.TANSTACK_BASE_URL;
    else process.env.TANSTACK_BASE_URL = saved;
  }
});
