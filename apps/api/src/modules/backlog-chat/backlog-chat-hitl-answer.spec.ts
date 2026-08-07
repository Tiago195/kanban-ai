import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BacklogChatOrchestrator } from './backlog-chat.orchestrator';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { BacklogCliRunner } from './runner/backlog-cli.runner';
import type { CardsService } from '../cards/cards.service';

/**
 * bug-backlog-hitl-hang: o adapter da CLI é one-shot — ao emitir a pergunta, o
 * processo `copilot` já saiu. Escrever a resposta no stdin é no-op e o turno
 * termina sem proposta. A correção: `answerQuestion` SEMPRE re-spawna um turno
 * novo com a resposta (fast-path e resiliência unificados). Se houver uma
 * promise HITL viva no mesmo processo, ela é encerrada com um sentinela
 * (rejeição graciosa) para o turno "morto" desistir sem duplicar a resposta.
 */

interface FakeMessage {
  sessionId: string;
  role: string;
  text: string;
  questionId?: string;
  channel?: string;
  ts: number;
}

function makeOrchestrator(messages: FakeMessage[]) {
  const created: FakeMessage[] = [];
  const prisma = {
    backlogChatMessage: {
      findFirst: async (args: {
        where: { sessionId: string; role?: string; questionId?: string };
      }) => {
        const w = args.where;
        return (
          [...messages, ...created].find(
            (m) =>
              m.sessionId === w.sessionId &&
              (w.role === undefined || m.role === w.role) &&
              (w.questionId === undefined || m.questionId === w.questionId),
          ) ?? null
        );
      },
      create: async (args: { data: FakeMessage }) => {
        created.push(args.data);
        return args.data;
      },
    },
    backlogChatSession: {
      findUnique: async () => ({ id: 's1', boardId: 'b1', status: 'open' }),
    },
  } as unknown as PrismaService;
  const broadcasts: unknown[] = [];
  const realtime = {
    broadcast(e: unknown) {
      broadcasts.push(e);
    },
  } as unknown as RealtimeService;
  const runner = {} as unknown as BacklogCliRunner;
  const cards = {} as unknown as CardsService;
  const orch = new BacklogChatOrchestrator(prisma, realtime, runner, cards);

  const calls: Array<{ text: string; channel: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (orch as any).runTurn = async (
    _sessionId: string,
    _boardId: string,
    userText: string,
    channel: string,
  ) => {
    calls.push({ text: userText, channel });
  };
  return { orch, calls, created, broadcasts };
}

test('answerQuestion (resiliência, sem promise viva): persiste resposta e re-spawna turno', async () => {
  const { orch, calls, created } = makeOrchestrator([
    { sessionId: 's1', role: 'ai', text: 'auto ou manual?', questionId: 'q1', channel: 'main', ts: 1 },
  ]);
  const ok = await orch.answerQuestion('s1', 'q1', 'auto');
  assert.equal(ok, true);
  // aguarda o re-spawn assíncrono (respawnAfterAnswer)
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.length, 1, 'deve re-spawnar exatamente um turno');
  assert.equal(calls[0].text, 'auto');
  assert.equal(calls[0].channel, 'main');
  const answers = created.filter((m) => m.role === 'user' && m.questionId === 'q1');
  assert.equal(answers.length, 1, 'resposta persistida uma única vez');
});

test('answerQuestion (fast-path, promise viva): rejeita com sentinela e re-spawna', async () => {
  const { orch, calls, created } = makeOrchestrator([
    { sessionId: 's1', role: 'ai', text: 'auto ou manual?', questionId: 'q1', channel: 'main', ts: 1 },
  ]);
  // Simula uma promise HITL viva no processo (o que o waitForAnswer faria).
  let rejectedWith: Error | null = null;
  const pending = {
    questionId: 'q1',
    channel: 'main',
    resolve: () => {},
    reject: (e: Error) => {
      rejectedWith = e;
    },
    timer: setTimeout(() => {}, 0),
  };
  clearTimeout(pending.timer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (orch as any).pending.set('s1', pending);

  const ok = await orch.answerQuestion('s1', 'q1', 'auto');
  assert.equal(ok, true);
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(rejectedWith, 'promise viva deve ser rejeitada');
  assert.equal((rejectedWith as unknown as Error).name, 'HitlRespawnSignal');
  assert.equal(calls.length, 1, 'deve re-spawnar um turno mesmo no fast-path');
  const answers = created.filter((m) => m.role === 'user' && m.questionId === 'q1');
  assert.equal(answers.length, 1, 'resposta persistida uma única vez (sem duplicar)');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((orch as any).pending.has('s1'), false, 'pending removido');
});

test('answerQuestion: pergunta inexistente -> false, sem re-spawn', async () => {
  const { orch, calls } = makeOrchestrator([]);
  const ok = await orch.answerQuestion('s1', 'q-none', 'x');
  assert.equal(ok, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0);
});

test('answerQuestion: pergunta já respondida -> false (idempotente)', async () => {
  const { orch, calls } = makeOrchestrator([
    { sessionId: 's1', role: 'ai', text: 'q?', questionId: 'q1', channel: 'main', ts: 1 },
    { sessionId: 's1', role: 'user', text: 'já respondi', questionId: 'q1', channel: 'main', ts: 2 },
  ]);
  const ok = await orch.answerQuestion('s1', 'q1', 'de novo');
  assert.equal(ok, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0);
});
