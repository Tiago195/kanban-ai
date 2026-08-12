import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { MemoryAuthGuard, MEMORY_AGENT_KEY } from './memory-auth.guard';
import type { RequestWithMemoryAgent } from './memory-auth.guard';
import { MemoryTokenRegistry } from './memory-auth.tokens';

// --- MemoryAuthGuard (EP-C / US-C2) ---
//
// Bearer obrigatorio quando auth ligada; retrocompat (passa direto) quando
// desligada; anexa a identidade do TOKEN ao request.

function ctxFor(req: RequestWithMemoryAgent): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function reqWith(authorization?: string): RequestWithMemoryAgent {
  return { headers: authorization === undefined ? {} : { authorization } };
}

test('US-C2 — auth DESLIGADA (sem tokens): guard deixa passar sem exigir token', () => {
  const guard = new MemoryAuthGuard(new MemoryTokenRegistry(undefined));
  assert.equal(guard.enabled, false);
  const req = reqWith();
  assert.equal(guard.canActivate(ctxFor(req)), true);
  assert.equal(req[MEMORY_AGENT_KEY], undefined, 'nada anexado no modo dev local');
});

test('US-C2 — auth LIGADA: token valido passa e anexa identidade ao request', () => {
  const guard = new MemoryAuthGuard(new MemoryTokenRegistry('tok-abc:ai:claude-1:memory'));
  assert.equal(guard.enabled, true);
  const req = reqWith('Bearer tok-abc');
  assert.equal(guard.canActivate(ctxFor(req)), true);
  assert.deepEqual(req[MEMORY_AGENT_KEY], { agentId: 'ai:claude-1', scope: 'memory' });
});

test('US-C2 — auth LIGADA: sem header Authorization -> 401', () => {
  const guard = new MemoryAuthGuard(new MemoryTokenRegistry('tok-abc:ai:claude-1:memory'));
  assert.throws(() => guard.canActivate(ctxFor(reqWith())), UnauthorizedException);
});

test('US-C2 — auth LIGADA: token desconhecido -> 401', () => {
  const guard = new MemoryAuthGuard(new MemoryTokenRegistry('tok-abc:ai:claude-1:memory'));
  assert.throws(
    () => guard.canActivate(ctxFor(reqWith('Bearer tok-errado'))),
    UnauthorizedException,
  );
});

test('US-C2 — auth LIGADA: header malformado (Basic) -> 401', () => {
  const guard = new MemoryAuthGuard(new MemoryTokenRegistry('tok-abc:ai:claude-1:memory'));
  assert.throws(
    () => guard.canActivate(ctxFor(reqWith('Basic dХХ'))),
    UnauthorizedException,
  );
});
