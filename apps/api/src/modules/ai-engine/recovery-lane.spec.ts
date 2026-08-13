import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDispatchModel,
  recoveryGuardLines,
  RECOVERY_GUARD_MARKER,
} from './recovery-lane';
import { MockAgentRunner } from './runners/mock-agent.runner';

// ── US-OBS2-5 — resolução de modelo na lane de recuperação (pura) ───────────

test('resolveDispatchModel: trabalho normal SEMPRE usa o modelo normal', () => {
  assert.equal(resolveDispatchModel('opus', 'cheapo', false), 'opus');
  assert.equal(resolveDispatchModel('opus', '', false), 'opus');
  assert.equal(resolveDispatchModel('opus', undefined, false), 'opus');
});

test('resolveDispatchModel: recuperação usa o cheapModelId quando definido', () => {
  assert.equal(resolveDispatchModel('opus', 'cheapo', true), 'cheapo');
});

test('resolveDispatchModel: recuperação cai no modelo normal quando cheap vazio', () => {
  assert.equal(resolveDispatchModel('opus', '', true), 'opus');
  assert.equal(resolveDispatchModel('opus', '   ', true), 'opus');
  assert.equal(resolveDispatchModel('opus', null, true), 'opus');
  assert.equal(resolveDispatchModel('opus', undefined, true), 'opus');
});

// ── US-OBS2-5 — guard de recuperação no prompt (presença x scrub) ───────────

test('recoveryGuardLines: contém o marcador e o guard allowDeliverableWork:false', () => {
  const text = recoveryGuardLines().join('\n');
  assert.ok(text.includes(RECOVERY_GUARD_MARKER));
  assert.ok(text.includes('allowDeliverableWork:false'));
  assert.ok(/NÃO produza trabalho entregável/i.test(text));
});

// Espelha o comportamento de `buildPrompt(..., recovery)`: só injeta o guard no
// caminho de recuperação; trabalho normal fica SEM o guard (scrubbed).
function promptWithGuard(recovery: boolean): string {
  const lines = ['# header'];
  if (recovery) lines.push(...recoveryGuardLines());
  lines.push('## resto do prompt normal');
  return lines.join('\n');
}

test('prompt de recuperação CONTÉM o guard', () => {
  const p = promptWithGuard(true);
  assert.ok(p.includes(RECOVERY_GUARD_MARKER));
  assert.ok(p.includes('allowDeliverableWork:false'));
});

test('prompt de trabalho normal NÃO contém o guard (scrubbed)', () => {
  const p = promptWithGuard(false);
  assert.ok(!p.includes(RECOVERY_GUARD_MARKER));
  assert.ok(!p.includes('allowDeliverableWork:false'));
});

// ── US-OBS2-5 — proveniência de uso (provider) no resultado do runner ───────

test('MockAgentRunner: resultado carrega provider="mock"', async () => {
  const runner = new MockAgentRunner();
  const result = await runner.run({
    cwd: '/tmp/x',
    model: 'opus',
    phase: 'analysis',
    prompt: 'oi',
  });
  assert.equal(result.provider, 'mock');
  assert.equal(typeof result.inputTokens, 'number');
  assert.equal(typeof result.outputTokens, 'number');
});
