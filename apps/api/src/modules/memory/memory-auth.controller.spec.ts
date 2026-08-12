import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryController } from './memory.controller';
import { MemoryPolicyService } from './memory-policy.service';
import { MEMORY_AGENT_KEY } from './memory-auth.guard';
import type { RequestWithMemoryAgent } from './memory-auth.guard';
import type { MemoryWriteDto } from './memory.schema';

// --- MemoryController: identidade/escopo do TOKEN (EP-C / US-C2) ---
//
// Fecha o buraco: quando autenticado, agentId+escopo vem do TOKEN, nao do body.
// Escrita in-scope -> commit com o sessionId derivado do token; out-of-scope ->
// REVIEW; token GLOBAL (*) escreve direto. Sem auth -> comportamento anterior.

function makeController() {
  const calls: Record<string, unknown[]> = { commit: [], enterReview: [], acquire: [] };
  const write = {
    commit: (dto: unknown) => {
      calls.commit.push(dto);
      return Promise.resolve({ committed: true, dto });
    },
  };
  const review = {
    enterReview: (input: unknown) => {
      calls.enterReview.push(input);
      return Promise.resolve({ review: true, input });
    },
    resolve: (dto: unknown) => Promise.resolve({ resolved: true, dto }),
  };
  const lock = {
    acquire: (path: string, holder: string, ttlMs?: number) => {
      calls.acquire.push({ path, holder, ttlMs });
      return Promise.resolve({ baseCommit: 'base', leaseId: 'l1', expiresAt: 1 });
    },
    heartbeat: () => Promise.resolve(2),
    release: () => Promise.resolve(),
  };
  const policy = new MemoryPolicyService(true); // enforcement ligado
  const controller = new MemoryController(
    {} as never,
    {} as never,
    write as never,
    lock as never,
    review as never,
    policy,
    {} as never,
    {} as never,
  );
  return { controller, calls };
}

function authedReq(agentId: string, scope?: string): RequestWithMemoryAgent {
  return { headers: {}, [MEMORY_AGENT_KEY]: { agentId: agentId as never, scope } };
}

const baseDto: MemoryWriteDto = {
  path: 'modules/memory/lock.md',
  content: 'x',
  sessionId: 'ATACANTE-livre',
  baseCommit: 'c0',
  message: 'm',
  module: 'cards', // body tenta forjar escopo/sessao — deve ser ignorado sob auth
};

test('US-C2 — write autenticado in-scope: sessionId e module vem do TOKEN (ignora body)', async () => {
  const { controller, calls } = makeController();
  const req = authedReq('ai:claude-1', 'memory');
  await controller.write_({ ...baseDto }, req);
  assert.equal(calls.commit.length, 1, 'deve commitar (in-scope)');
  const committed = calls.commit[0] as MemoryWriteDto;
  assert.equal(committed.sessionId, 'claude-1', 'sessionId derivado do agentId do token');
  assert.equal(committed.module, 'memory', 'module vem do escopo do token, nao do body');
});

test('US-C2 — write autenticado out-of-scope vai a REVIEW com holder=agentId do token', async () => {
  const { controller, calls } = makeController();
  const req = authedReq('ai:claude-1', 'memory');
  // path fora de modules/memory/ -> out-of-scope pelo escopo do token
  await controller.write_({ ...baseDto, path: 'modules/cards/card.md' }, req);
  assert.equal(calls.commit.length, 0, 'nao commita direto');
  assert.equal(calls.enterReview.length, 1, 'entra em REVIEW');
  const input = calls.enterReview[0] as { holder: string; sessionId: string };
  assert.equal(input.holder, 'ai:claude-1');
  assert.equal(input.sessionId, 'claude-1');
});

test('US-C2 — token GLOBAL (scope *) escreve direto sem enforcement de escopo', async () => {
  const { controller, calls } = makeController();
  const req = authedReq('ai:root', undefined); // scope global
  await controller.write_({ ...baseDto, path: 'modules/cards/card.md' }, req);
  assert.equal(calls.commit.length, 1, 'token global commita qualquer path');
  assert.equal(calls.enterReview.length, 0);
});

test('US-C2 — sem auth (req sem identidade): comportamento anterior baseado no body', async () => {
  const { controller, calls } = makeController();
  const req: RequestWithMemoryAgent = { headers: {} };
  // body.module=cards, path fora -> out-of-scope pelo body
  await controller.write_({ ...baseDto, path: 'modules/other/x.md' }, req);
  assert.equal(calls.enterReview.length, 1, 'usa module do body quando nao autenticado');
  const input = calls.enterReview[0] as { sessionId: string };
  assert.equal(input.sessionId, 'ATACANTE-livre', 'dev local: sessionId vem do body');
});

test('US-C2 — acquire autenticado usa agentId do token como holder', async () => {
  const { controller, calls } = makeController();
  const req = authedReq('ai:claude-1', 'memory');
  await controller.acquire({ path: 'modules/memory/a.md', holder: 'forjado' }, req);
  const call = calls.acquire[0] as { holder: string };
  assert.equal(call.holder, 'ai:claude-1', 'holder do token tem precedencia sobre o body');
});
