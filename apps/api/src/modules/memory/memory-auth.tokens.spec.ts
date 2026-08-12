import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryTokenRegistry,
  extractBearerToken,
} from './memory-auth.tokens';

// --- MemoryTokenRegistry / extractBearerToken (EP-C / US-C2) ---
//
// Registro puro token -> {agentId, scope}. Fecha o buraco de "escrever como
// qualquer sessao": a identidade e o escopo passam a vir do TOKEN.

test('US-C2 — registro vazio quando MEMORY_API_TOKENS ausente (auth desligada)', () => {
  const r = new MemoryTokenRegistry(undefined);
  assert.equal(r.enabled, false);
  assert.equal(r.resolve('qualquer'), undefined);
});

test('US-C2 — registro vazio quando MEMORY_API_TOKENS vazio/whitespace', () => {
  assert.equal(new MemoryTokenRegistry('').enabled, false);
  assert.equal(new MemoryTokenRegistry('   ,  , ').enabled, false);
});

test('US-C2 — parse token:agentId:scope com agentId contendo ":"', () => {
  const r = new MemoryTokenRegistry('tok-abc:ai:claude-1:memory');
  assert.equal(r.enabled, true);
  const id = r.resolve('tok-abc');
  assert.deepEqual(id, { agentId: 'ai:claude-1', scope: 'memory' });
});

test('US-C2 — scope "*" vira escopo GLOBAL (scope undefined)', () => {
  const r = new MemoryTokenRegistry('tok-xyz:ai:cursor-2:*');
  assert.deepEqual(r.resolve('tok-xyz'), { agentId: 'ai:cursor-2', scope: undefined });
});

test('US-C2 — multiplos tokens csv', () => {
  const r = new MemoryTokenRegistry('a:ai:one:memory, b:ai:two:cards');
  assert.deepEqual(r.resolve('a'), { agentId: 'ai:one', scope: 'memory' });
  assert.deepEqual(r.resolve('b'), { agentId: 'ai:two', scope: 'cards' });
});

test('US-C2 — entradas malformadas sao ignoradas com seguranca', () => {
  const r = new MemoryTokenRegistry('semdoispontos, so:umponto, :vazio:memory, ok:ai:x:mem');
  assert.equal(r.resolve('semdoispontos'), undefined);
  assert.equal(r.resolve('so'), undefined);
  assert.equal(r.resolve(''), undefined);
  assert.deepEqual(r.resolve('ok'), { agentId: 'ai:x', scope: 'mem' });
});

test('US-C2 — resolve(undefined/null) e undefined', () => {
  const r = new MemoryTokenRegistry('a:ai:one:memory');
  assert.equal(r.resolve(undefined), undefined);
  assert.equal(r.resolve(null), undefined);
  assert.equal(r.resolve('desconhecido'), undefined);
});

test('US-C2 — extractBearerToken aceita esquema case-insensitive e trim', () => {
  assert.equal(extractBearerToken('Bearer tok-1'), 'tok-1');
  assert.equal(extractBearerToken('bearer  tok-2  '), 'tok-2');
  assert.equal(extractBearerToken('  Bearer   tok-3'), 'tok-3');
});

test('US-C2 — extractBearerToken rejeita headers ausentes/malformados', () => {
  assert.equal(extractBearerToken(undefined), undefined);
  assert.equal(extractBearerToken(''), undefined);
  assert.equal(extractBearerToken('Basic abc'), undefined);
  assert.equal(extractBearerToken('tok-sem-esquema'), undefined);
});
