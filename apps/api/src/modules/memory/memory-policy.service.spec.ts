import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPolicyService } from './memory-policy.service';

// --- MemoryPolicyService: identidade + escopo da colmeia (EP-83) ---
//
// Servico puro: agentId estavel (US-210), escopo por modulo (US-211) e
// enforcement read-global/write-scope (US-212). Sem I/O.

test('US-210 — agentId estavel deriva de ai:<sessao> e ignora storyKey', () => {
  const p = new MemoryPolicyService(true);
  assert.equal(p.agentIdFor({ sessionId: 's-123' }), 'ai:s-123');
  assert.equal(
    p.agentIdFor({ sessionId: 's-123', storyKey: 'US-1' }),
    p.agentIdFor({ sessionId: 's-123', storyKey: 'US-2' }),
    'identidade estavel dentro da execucao da story (sessao fixa)',
  );
});

test('US-210 — agentId sanitiza caracteres invalidos da sessao', () => {
  const p = new MemoryPolicyService(true);
  assert.equal(p.agentIdFor({ sessionId: 'a b/c:d' }), 'ai:a-b-c-d');
});

test('US-211 — scopeFor materializa o prefixo modules/<modulo>/', () => {
  const p = new MemoryPolicyService(true);
  assert.equal(p.scopeFor('memory'), 'modules/memory/');
  assert.equal(p.scopeFor('ai engine'), 'modules/ai-engine/');
});

test('US-212 — leitura e sempre global', () => {
  assert.equal(new MemoryPolicyService(true).canRead(), true);
  assert.equal(new MemoryPolicyService(false).canRead(), true);
});

test('US-212 — escrita dentro do escopo e in-scope', () => {
  const p = new MemoryPolicyService(true);
  const scopePrefix = p.scopeFor('memory');
  assert.equal(
    p.classifyWrite({ scopePrefix, path: 'modules/memory/lock.md' }),
    'in-scope',
  );
});

test('US-212 — escrita fora do escopo e out-of-scope (vira REVIEW)', () => {
  const p = new MemoryPolicyService(true);
  const scopePrefix = p.scopeFor('memory');
  assert.equal(
    p.classifyWrite({ scopePrefix, path: 'modules/cards/card.md' }),
    'out-of-scope',
  );
});

test('US-212 — override por projeto: enforcement desligado torna tudo in-scope', () => {
  const p = new MemoryPolicyService(false);
  assert.equal(p.isScopeEnforced, false);
  assert.equal(
    p.classifyWrite({ scopePrefix: 'modules/memory/', path: 'modules/cards/x.md' }),
    'in-scope',
  );
});

test('classifyWrite normaliza barras e prefixo com barra inicial', () => {
  const p = new MemoryPolicyService(true);
  assert.equal(
    p.classifyWrite({ scopePrefix: '/modules/memory/', path: '\\modules\\memory\\a.md' }),
    'in-scope',
  );
});
