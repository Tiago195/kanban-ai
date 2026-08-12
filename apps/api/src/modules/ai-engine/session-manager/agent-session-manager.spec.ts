import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LivenessState } from '@kanban-ai/shared';
import type { AppConfig } from '../../../shared/config/config';
import type { PrismaService } from '../../../shared/db/prisma.service';
import { AgentSessionManager } from './agent-session-manager';

/**
 * Testes do estado de runtime durável (US-ROB2). Usam um Prisma fake in-memory
 * que implementa apenas `agentRuntimeState.upsert`, guardando a última linha por
 * sessionId — o suficiente para inspecionar sessionId estável, liveness e a
 * acumulação de tokens.
 */

interface RuntimeRow {
  sessionId: string;
  storyId: string;
  livenessState?: string;
  lastError?: string | null;
  tokenTotals?: string;
}

function makeFakePrisma(): {
  svc: PrismaService;
  rows: Map<string, RuntimeRow>;
} {
  const rows = new Map<string, RuntimeRow>();
  const svc = {
    agentRuntimeState: {
      async upsert(args: {
        where: { sessionId: string };
        create: RuntimeRow;
        update: Partial<RuntimeRow>;
      }) {
        const key = args.where.sessionId;
        const existing = rows.get(key);
        if (existing) {
          rows.set(key, { ...existing, ...args.update });
        } else {
          rows.set(key, { ...args.create });
        }
        return rows.get(key);
      },
    },
  } as unknown as PrismaService;
  return { svc, rows };
}

function makeConfig(runtimePersistEnabled = true): AppConfig {
  return {
    agent: {
      maxConcurrentSessions: 3,
      runtimePersistEnabled,
    },
  } as unknown as AppConfig;
}

test('US-ROB2: start persiste linha com sessionId estável (== storyId) e liveness=starting', async () => {
  const { svc, rows } = makeFakePrisma();
  const mgr = new AgentSessionManager(makeConfig(), svc);

  const session = mgr.start('US-42');
  assert.equal(session.sessionId, 'US-42', 'sessionId deve ser igual ao storyId');

  // persistState é fire-and-forget; dá um tick para o microtask resolver.
  await Promise.resolve();
  const row = rows.get('US-42');
  assert.ok(row, 'linha durável deve existir após start');
  assert.equal(row?.sessionId, 'US-42');
  assert.equal(row?.storyId, 'US-42');
  assert.equal(row?.livenessState, LivenessState.Starting);
});

test('US-ROB2: setState(running) reflete liveness=alive na linha durável', async () => {
  const { svc, rows } = makeFakePrisma();
  const mgr = new AgentSessionManager(makeConfig(), svc);
  mgr.start('US-7');
  await Promise.resolve();

  mgr.setState('US-7', 'running');
  await Promise.resolve();

  assert.equal(rows.get('US-7')?.livenessState, LivenessState.Alive);
});

test('US-ROB2: addTokens acumula os totais no cache e na linha durável', async () => {
  const { svc, rows } = makeFakePrisma();
  const mgr = new AgentSessionManager(makeConfig(), svc);
  mgr.start('US-9');

  await mgr.addTokens('US-9', { input: 100, output: 20 });
  await mgr.addTokens('US-9', { input: 50, output: 5 });

  assert.deepEqual(mgr.get('US-9')?.tokenTotals, { input: 150, output: 25 });
  assert.equal(rows.get('US-9')?.tokenTotals, JSON.stringify({ input: 150, output: 25 }));
});

test('US-ROB2: addTokens em story inexistente é no-op (não cria sessão)', async () => {
  const { svc, rows } = makeFakePrisma();
  const mgr = new AgentSessionManager(makeConfig(), svc);
  await mgr.addTokens('US-ghost', { input: 10, output: 1 });
  assert.equal(rows.size, 0);
  assert.equal(mgr.get('US-ghost'), undefined);
});

test('US-ROB2: abort marca liveness=dead e registra lastError', async () => {
  const { svc, rows } = makeFakePrisma();
  const mgr = new AgentSessionManager(makeConfig(), svc);
  mgr.start('US-3');
  await Promise.resolve();

  mgr.abort('US-3');
  await Promise.resolve();

  const row = rows.get('US-3');
  assert.equal(row?.livenessState, LivenessState.Dead);
  assert.equal(row?.lastError, 'aborted');
});

test('US-ROB2: remove marca liveness=dead na linha durável', async () => {
  const { svc, rows } = makeFakePrisma();
  const mgr = new AgentSessionManager(makeConfig(), svc);
  mgr.start('US-5');
  await Promise.resolve();

  mgr.remove('US-5');
  await Promise.resolve();

  assert.equal(rows.get('US-5')?.livenessState, LivenessState.Dead);
  assert.equal(mgr.get('US-5'), undefined, 'sessão sai do cache quente');
});

test('US-ROB2: flag desligada (runtimePersistEnabled=false) não escreve no banco', async () => {
  const { svc, rows } = makeFakePrisma();
  const mgr = new AgentSessionManager(makeConfig(false), svc);
  mgr.start('US-8');
  mgr.setState('US-8', 'running');
  await mgr.addTokens('US-8', { input: 5, output: 5 });
  await Promise.resolve();

  assert.equal(rows.size, 0, 'nenhuma persistência quando a flag está off');
  // O cache em memória segue funcionando normalmente.
  assert.deepEqual(mgr.get('US-8')?.tokenTotals, { input: 5, output: 5 });
});

test('US-ROB2: persistState é defensivo — falha de DB não propaga', async () => {
  const failing = {
    agentRuntimeState: {
      upsert: async () => {
        throw new Error('db down');
      },
    },
  } as unknown as PrismaService;
  const mgr = new AgentSessionManager(makeConfig(), failing);

  // Nenhuma dessas chamadas pode lançar mesmo com o DB falhando.
  assert.doesNotThrow(() => mgr.start('US-boom'));
  await assert.doesNotReject(() => mgr.addTokens('US-boom', { input: 1, output: 1 }));
  assert.doesNotThrow(() => mgr.abort('US-boom'));
});
