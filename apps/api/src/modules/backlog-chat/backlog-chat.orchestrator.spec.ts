import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BacklogChatOrchestrator } from './backlog-chat.orchestrator';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { BacklogCliRunner } from './runner/backlog-cli.runner';
import type { CardsService } from '../cards/cards.service';
import type { AssigneesService } from '../assignees/assignees.service';

/**
 * US-COLAB4 — integração de `@mention` delegation no `sendMessage`.
 *
 * Cobre o DOD §4.7:
 *  - `@<assignee-existente> <texto>` → 1 task na story + attach do assignee.
 *  - `@<perfil>` (`@feature`) → task com `loopType`.
 *  - menção desconhecida (`@ninguem`) → não cria task órfã.
 *  - texto sem menção → nenhuma task criada (retrocompat, `runTurn` intacto).
 *  - dedup: no máximo 1 task por handle distinto por mensagem.
 */

interface Harness {
  createCalls: Array<Record<string, unknown>>;
  attachCalls: Array<{ cardId: string; assigneeId: string }>;
  runTurnCalls: number;
}

function makeOrch(opts: {
  story?: { id: string; boardId: string } | null;
  assignees?: Array<{ id: string; name: string }>;
  customProfiles?: string[];
}): { orch: BacklogChatOrchestrator; h: Harness } {
  const story = opts.story === undefined ? { id: 'story-1', boardId: 'b1' } : opts.story;
  const assignees = opts.assignees ?? [];
  const customProfiles = new Set(opts.customProfiles ?? []);
  const h: Harness = { createCalls: [], attachCalls: [], runTurnCalls: 0 };

  const prisma = {
    backlogChatSession: {
      findUnique: async () => ({ id: 'sess-1', boardId: 'b1', status: 'open', title: 'x' }),
      update: async () => ({}),
    },
    backlogChatMessage: {
      create: async () => ({}),
    },
    card: {
      findFirst: async () => story,
    },
    loopProfile: {
      findUnique: async ({ where }: { where: { boardId_profileId: { profileId: string } } }) =>
        customProfiles.has(where.boardId_profileId.profileId)
          ? { profileId: where.boardId_profileId.profileId }
          : null,
    },
  } as unknown as PrismaService;

  let seq = 0;
  const cards = {
    create: async (dto: Record<string, unknown>) => {
      h.createCalls.push(dto);
      seq += 1;
      return { id: `task-${seq}`, key: `TK-${seq}`, title: dto.title };
    },
    attachAssignee: async (cardId: string, dto: { assigneeId: string }) => {
      h.attachCalls.push({ cardId, assigneeId: dto.assigneeId });
      return {};
    },
  } as unknown as CardsService;

  const assigneesSvc = {
    findAll: async () => assignees,
  } as unknown as AssigneesService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    cards,
    assigneesSvc,
  );

  // Neutraliza o turno da CLI: só conta que foi disparado.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (orch as any).runTurn = async () => {
    h.runTurnCalls += 1;
  };

  return { orch, h };
}

test('sendMessage(@assignee): cria 1 task na story e anexa o assignee', async () => {
  const { orch, h } = makeOrch({
    assignees: [{ id: 'a-backend', name: 'backend' }],
  });

  await orch.sendMessage('sess-1', '@backend corrige o login');

  assert.equal(h.createCalls.length, 1);
  const dto = h.createCalls[0];
  assert.equal(dto.type, 'task');
  assert.equal(dto.title, 'corrige o login');
  assert.equal(dto.parentId, 'story-1');
  assert.equal(dto.boardId, 'b1');
  assert.equal(dto.loopType, undefined); // assignee puro: sem loopType
  assert.equal(dto.points, undefined); // invariante 5: task sem pontos
  assert.deepEqual(h.attachCalls, [{ cardId: 'task-1', assigneeId: 'a-backend' }]);
});

test('sendMessage(@perfil): cria task com loopType do perfil (builtin)', async () => {
  const { orch, h } = makeOrch({});

  await orch.sendMessage('sess-1', '@feature implementa o fluxo novo');

  assert.equal(h.createCalls.length, 1);
  assert.equal(h.createCalls[0].loopType, 'feature');
  assert.equal(h.createCalls[0].title, 'implementa o fluxo novo');
  assert.equal(h.attachCalls.length, 0); // perfil puro: nada a anexar
});

test('sendMessage(@perfil-custom): loopType custom resolvido pelo board', async () => {
  const { orch, h } = makeOrch({ customProfiles: ['orchestrator'] });

  await orch.sendMessage('sess-1', '@orchestrator gerencia o board');

  assert.equal(h.createCalls.length, 1);
  assert.equal(h.createCalls[0].loopType, 'orchestrator');
});

test('sendMessage(ambiguidade): assignee + loopType → anexa assignee E seta loopType', async () => {
  const { orch, h } = makeOrch({
    assignees: [{ id: 'a-feat', name: 'feature' }],
  });

  await orch.sendMessage('sess-1', '@feature faz a coisa');

  assert.equal(h.createCalls.length, 1);
  assert.equal(h.createCalls[0].loopType, 'feature');
  assert.deepEqual(h.attachCalls, [{ cardId: 'task-1', assigneeId: 'a-feat' }]);
});

test('sendMessage(menção desconhecida): não cria task órfã', async () => {
  const { orch, h } = makeOrch({ assignees: [{ id: 'a-backend', name: 'backend' }] });

  await orch.sendMessage('sess-1', '@ninguem faz algo');

  assert.equal(h.createCalls.length, 0);
  assert.equal(h.attachCalls.length, 0);
  assert.equal(h.runTurnCalls, 1); // o turno normal segue disparando
});

test('sendMessage(sem menção): comportamento inalterado (nenhuma task)', async () => {
  const { orch, h } = makeOrch({ assignees: [{ id: 'a-backend', name: 'backend' }] });

  await orch.sendMessage('sess-1', 'só uma mensagem normal');

  assert.equal(h.createCalls.length, 0);
  assert.equal(h.attachCalls.length, 0);
  assert.equal(h.runTurnCalls, 1);
});

test('sendMessage(dedup): 1 task por handle distinto por mensagem', async () => {
  const { orch, h } = makeOrch({ assignees: [{ id: 'a-backend', name: 'backend' }] });

  await orch.sendMessage('sess-1', '@backend faz A @backend faz B');

  assert.equal(h.createCalls.length, 1); // segunda menção de @backend é ignorada
});

test('sendMessage(múltiplas menções distintas): 1 task por handle', async () => {
  const { orch, h } = makeOrch({
    assignees: [
      { id: 'a-backend', name: 'backend' },
      { id: 'a-frontend', name: 'frontend' },
    ],
  });

  await orch.sendMessage('sess-1', '@backend arruma a API @frontend ajusta o botão');

  assert.equal(h.createCalls.length, 2);
  assert.equal(h.attachCalls.length, 2);
});

test('sendMessage(sem story materializada): ignora menções, não cria task', async () => {
  const { orch, h } = makeOrch({
    story: null,
    assignees: [{ id: 'a-backend', name: 'backend' }],
  });

  await orch.sendMessage('sess-1', '@backend corrige o login');

  assert.equal(h.createCalls.length, 0);
  assert.equal(h.runTurnCalls, 1);
});
