import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TanStackRunner, vendorModelIssue } from './tanstack.runner';
import type { AgentRunInput } from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';

/**
 * US-F3.10 — resolução de modelo por vendor (débito da US-F3.9).
 *
 * Um `Card.model` que é alias do domínio ('opus') ou id de OUTRO vendor num
 * adapter de API é 404 GARANTIDO no provider. A decisão da história: falhar
 * CEDO com erro legível (fatalError BUG-A7, antes de rede/ESM), sem chutar
 * sobre id desconhecido — id neutro passa e o provider é quem valida.
 * Tudo aqui roda SEM rede e SEM carregar os módulos ESM dos vendors.
 */

// ── vendorModelIssue (pura) ─────────────────────────────────────────────────

test('US-F3.10: alias do domínio (opus/sonnet) é mismatch em QUALQUER vendor', () => {
  for (const vendor of ['claude', 'codex', 'gemini'] as const) {
    assert.match(vendorModelIssue(vendor, 'opus') ?? '', /alias do domínio/);
    assert.match(vendorModelIssue(vendor, 'sonnet') ?? '', /alias do domínio/);
  }
});

test('US-F3.10: id do PRÓPRIO vendor passa', () => {
  assert.equal(vendorModelIssue('claude', 'claude-sonnet-4-5'), null);
  assert.equal(vendorModelIssue('codex', 'gpt-5.1-codex'), null);
  assert.equal(vendorModelIssue('codex', 'o3-mini'), null);
  assert.equal(vendorModelIssue('gemini', 'gemini-2.5-pro'), null);
});

test('US-F3.10: id de OUTRO vendor é mismatch, nomeando o vendor certo', () => {
  assert.match(vendorModelIssue('gemini', 'claude-sonnet-4-5') ?? '', /vendor "claude"/);
  assert.match(vendorModelIssue('claude', 'gemini-2.5-pro') ?? '', /vendor "gemini"/);
  assert.match(vendorModelIssue('gemini', 'gpt-5.1') ?? '', /vendor "codex"/);
});

test('US-F3.10: id no formato do catálogo Copilot/org (com "/") é mismatch', () => {
  assert.match(
    vendorModelIssue('claude', 'uol-inc/AWS_Bedrock/anthropic.claude-opus-4-8') ?? '',
    /catálogo Copilot/,
  );
});

test('US-F3.10: modelo vazio é mismatch (vendor de API exige id)', () => {
  assert.match(vendorModelIssue('gemini', '  ') ?? '', /exige um id/);
});

test('US-F3.10: id NEUTRO/desconhecido NÃO é acusado (indeterminado — o provider valida)', () => {
  assert.equal(vendorModelIssue('claude', 'fake-1'), null);
  assert.equal(vendorModelIssue('gemini', 'llama3.1'), null);
});

// ── run(): falha cedo, legível, sem rede/ESM ────────────────────────────────

function makeConfig(): AppConfig {
  return {
    agentAdapter: 'gemini',
    agent: {
      hitlTimeoutMs: 1000,
      streamIdleTimeoutMs: 5000,
      tanstack: { baseUrl: '', model: '' },
    },
  } as unknown as AppConfig;
}

test('US-F3.10: modelo por-card incompatível vira fatalError legível ANTES de tocar rede', async () => {
  // Credencial presente (senão a F3.9 já falha antes, por outro motivo) e SEM
  // GEMINI_MODEL — é exatamente o caminho do débito: o modelo por-card vale.
  const saved = { key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  process.env.GEMINI_API_KEY = 'fake-key-so-para-o-teste';
  delete process.env.GEMINI_MODEL;
  try {
    const runner = new TanStackRunner(makeConfig(), 'gemini');
    const result = await runner.run({
      cwd: process.cwd(),
      model: 'opus', // Card.model herdado do domínio — 404 garantido no provider
      phase: 'implementation',
      prompt: 'faca algo',
    } as AgentRunInput);
    assert.equal(result.done, false);
    assert.equal(result.provider, 'gemini');
    assert.match(result.fatalError ?? '', /incompatível com o vendor gemini/);
    assert.match(result.detail, /alias do domínio/);
    assert.match(result.detail, /GEMINI_MODEL/, 'a mensagem instrui o override do operador');
    assert.match(result.nextStep ?? '', /gemini-2\.5-pro/, 'exemplo de id válido no nextStep');
  } finally {
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.key;
    if (saved.model !== undefined) process.env.GEMINI_MODEL = saved.model;
  }
});
