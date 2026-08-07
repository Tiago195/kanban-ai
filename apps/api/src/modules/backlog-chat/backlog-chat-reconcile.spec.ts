import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BacklogChatOrchestrator } from './backlog-chat.orchestrator';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { BacklogCliRunner } from './runner/backlog-cli.runner';
import type { CardsService } from '../cards/cards.service';

/**
 * bug-dropped-turn: se o browser fecha (ou a API reinicia) DURANTE um turno do
 * PO, a sessão fica `open` com uma mensagem do humano como última e nenhuma
 * resposta da AI. `reconcileOpenTurns` (chamado no boot) deve redisparar o
 * turno. Se a última mensagem já for da AI (turno concluiu), não faz nada.
 */

interface FakeSession {
  id: string;
  boardId: string;
  status: string;
}
interface FakeMessage {
  sessionId: string;
  role: string;
  text: string;
  channel?: string;
  ts: number;
}

function makeOrchestrator(sessions: FakeSession[], messages: FakeMessage[]) {
  const prisma = {
    backlogChatSession: {
      findMany: async () => sessions.filter((s) => s.status === 'open'),
    },
    backlogChatMessage: {
      findFirst: async (args: { where: { sessionId: string }; orderBy?: unknown }) => {
        const msgs = messages
          .filter((m) => m.sessionId === args.where.sessionId)
          .sort((a, b) => b.ts - a.ts);
        return msgs[0] ?? null;
      },
    },
  } as unknown as PrismaService;
  const realtime = { broadcast() {} } as unknown as RealtimeService;
  const runner = {} as unknown as BacklogCliRunner;
  const cards = {} as unknown as CardsService;
  const orch = new BacklogChatOrchestrator(prisma, realtime, runner, cards);

  // Espiona `runTurn` (privado) sem invocar o runner real.
  const calls: Array<{ sessionId: string; boardId: string; text: string; channel: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (orch as any).runTurn = async (
    sessionId: string,
    boardId: string,
    userText: string,
    channel: string,
  ) => {
    calls.push({ sessionId, boardId, text: userText, channel });
  };
  return { orch, calls };
}

test('reconcileOpenTurns: última mensagem do humano -> retoma o turno', async () => {
  const { orch, calls } = makeOrchestrator(
    [{ id: 's1', boardId: 'b1', status: 'open' }],
    [
      { sessionId: 's1', role: 'ai', text: 'olá', ts: 1 },
      { sessionId: 's1', role: 'user', text: 'crie 3 épicos', channel: 'main', ts: 2 },
    ],
  );
  const resumed = await orch.reconcileOpenTurns();
  assert.equal(resumed, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: 's1', boardId: 'b1', text: 'crie 3 épicos', channel: 'main' });
});

test('reconcileOpenTurns: última mensagem da AI -> NÃO retoma (turno concluiu)', async () => {
  const { orch, calls } = makeOrchestrator(
    [{ id: 's1', boardId: 'b1', status: 'open' }],
    [
      { sessionId: 's1', role: 'user', text: 'crie 3 épicos', ts: 1 },
      { sessionId: 's1', role: 'ai', text: 'aqui está a proposta', ts: 2 },
    ],
  );
  const resumed = await orch.reconcileOpenTurns();
  assert.equal(resumed, 0);
  assert.equal(calls.length, 0);
});

test('reconcileOpenTurns: sessão applied não é considerada (findMany filtra open)', async () => {
  const { orch, calls } = makeOrchestrator(
    [{ id: 's1', boardId: 'b1', status: 'applied' }],
    [{ sessionId: 's1', role: 'user', text: 'x', ts: 1 }],
  );
  const resumed = await orch.reconcileOpenTurns();
  assert.equal(resumed, 0);
  assert.equal(calls.length, 0);
});
