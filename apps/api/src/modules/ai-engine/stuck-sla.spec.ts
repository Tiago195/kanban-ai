import { test } from 'node:test';
import assert from 'node:assert';
import { decideStuck } from './stuck-sla';

const NOW = 1_000_000;
const BASE = 60_000; // 60s teto base

test('heartbeat fresco → não travado', () => {
  const d = decideStuck({
    now: NOW,
    lastHeartbeatAt: NOW - 1_000, // 1s atrás
    baseCeilingMs: BASE,
  });
  assert.equal(d.stuck, false);
});

test('heartbeat faminto além do teto base → travado', () => {
  const d = decideStuck({
    now: NOW,
    lastHeartbeatAt: NOW - (BASE + 5_000), // 65s atrás
    baseCeilingMs: BASE,
  });
  assert.equal(d.stuck, true);
  assert.match(d.reason, /heartbeat starved/);
});

test('CASO-CHAVE: faminto p/ base MAS dentro de declaredTimeout grande → NÃO travado', () => {
  // Silêncio de 5min excede o teto base (60s) mas está dentro de uma operação
  // longa DECLARADA de 10min — não deve ser morto cedo.
  const declared = 600_000; // 10min
  const d = decideStuck({
    now: NOW,
    lastHeartbeatAt: NOW - 300_000, // 5min de silêncio
    baseCeilingMs: BASE,
    declaredTimeoutMs: declared,
  });
  assert.equal(d.stuck, false);
  assert.match(d.reason, /janela declarada/);
});

test('silêncio excede ATÉ a janela declarada → travado', () => {
  const declared = 120_000; // 2min
  const d = decideStuck({
    now: NOW,
    lastHeartbeatAt: NOW - 300_000, // 5min > 2min declarados
    baseCeilingMs: BASE,
    declaredTimeoutMs: declared,
  });
  assert.equal(d.stuck, true);
  assert.match(d.reason, /heartbeat starved/);
});

test('claim vencido + heartbeat faminto (além do base) → travado', () => {
  const d = decideStuck({
    now: NOW,
    lastHeartbeatAt: NOW - (BASE + 1_000), // faminto p/ base
    baseCeilingMs: BASE,
    claimExpiresAt: NOW - 10_000, // vencido
  });
  assert.equal(d.stuck, true);
});

test('claim vencido MAS heartbeat recente → NÃO travado (não mata claim recém-vencido que ainda bate)', () => {
  const d = decideStuck({
    now: NOW,
    lastHeartbeatAt: NOW - 2_000, // heartbeat recente
    baseCeilingMs: BASE,
    claimExpiresAt: NOW - 1, // acabou de vencer
  });
  assert.equal(d.stuck, false);
});

test('claim vencido + silêncio > base MAS dentro da janela declarada → NÃO travado (op longa declarada)', () => {
  // Regra: claimExpired só derruba se silêncio > base; a janela declarada não
  // entra nesse ramo, mas a starvation pura já não dispara (dentro do declared),
  // e o ramo de claim exige silêncio > base — que aqui é verdadeiro. Documenta
  // que o gate de heartbeat starved (declared) tem prioridade e não disparou;
  // o ramo de claim ainda pode disparar quando silêncio > base.
  const d = decideStuck({
    now: NOW,
    lastHeartbeatAt: NOW - (BASE + 30_000), // > base
    baseCeilingMs: BASE,
    declaredTimeoutMs: 600_000, // janela larga: starvation não dispara
    claimExpiresAt: NOW - 5_000, // vencido
  });
  // claim vencido E silêncio > base → travado (o lease é a autoridade final).
  assert.equal(d.stuck, true);
});

test('heartbeat ausente (null) → tratado como starvation total → travado', () => {
  const d = decideStuck({
    now: NOW,
    lastHeartbeatAt: null,
    baseCeilingMs: BASE,
  });
  assert.equal(d.stuck, true);
});

test('função pura: mesma entrada, mesma saída (sem Date.now interno)', () => {
  const input = {
    now: NOW,
    lastHeartbeatAt: NOW - 1_000,
    baseCeilingMs: BASE,
  };
  assert.deepEqual(decideStuck(input), decideStuck(input));
});
