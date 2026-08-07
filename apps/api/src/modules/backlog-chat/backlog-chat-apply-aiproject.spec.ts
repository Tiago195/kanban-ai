import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBacklogPatch } from './backlog-patch';
import { BacklogChatOrchestrator } from './backlog-chat.orchestrator';
import type { BacklogProposal } from '@kanban-ai/shared';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { BacklogCliRunner } from './runner/backlog-cli.runner';
import type { CardsService } from '../cards/cards.service';

/**
 * imp-aiproject-missing: o épico criado pelo PO deve persistir `aiProject`
 * (repo-alvo descoberto na fase de discovery) para que mover uma story para
 * "In Progress" não caia no modal "Falta o Projeto-alvo". As stories filhas
 * herdam via fallback epic→story no loop engine.
 */

function baseProposal(): BacklogProposal {
  return {
    version: 1,
    epic: { title: 'Épico', description: 'desc', points: 8 },
    stories: [{ id: 's1-0', title: 'Story 1', description: 'd', points: 3 }],
  };
}

test('applyBacklogPatch: /epic/aiProject define o repo-alvo no épico', () => {
  const next = applyBacklogPatch(baseProposal(), {
    baseVersion: 1,
    ops: [{ op: 'replace', path: '/epic/aiProject', value: '/home/user/dev/jogo' }],
  });
  assert.equal(next.epic.aiProject, '/home/user/dev/jogo');
  assert.equal(next.version, 2);
});

test('apply(): épico é criado com aiProject vindo da proposta', async () => {
  const proposal: BacklogProposal = {
    version: 1,
    epic: { title: 'Épico', description: 'desc', points: 8, aiProject: '/home/user/dev/jogo' },
    stories: [{ id: 's1-0', title: 'Story 1', description: 'd', points: 3 }],
  };

  const prisma = {
    backlogChatSession: {
      findUnique: async () => ({ id: 's1', boardId: 'b1', status: 'open' }),
      update: async () => ({}),
    },
    backlogProposalRevision: {
      findUnique: async () => ({ sessionId: 's1', version: 1, proposal }),
    },
    dodItem: { create: async () => ({}) },
    affectedFlow: { create: async () => ({}) },
  } as unknown as PrismaService;

  const createCalls: Array<Record<string, unknown>> = [];
  let seq = 0;
  const cards = {
    create: async (dto: Record<string, unknown>) => {
      createCalls.push(dto);
      seq += 1;
      const prefix = dto.type === 'epic' ? 'EP' : dto.type === 'story' ? 'US' : 'TK';
      return { id: `${dto.type}-${seq}`, key: `${prefix}-${seq}`, title: dto.title };
    },
  } as unknown as CardsService;

  const realtime = { broadcast() {} } as unknown as RealtimeService;
  const runner = {} as unknown as BacklogCliRunner;

  const orch = new BacklogChatOrchestrator(
    prisma,
    realtime,
    runner,
    cards,
  );

  const res = await orch.apply('s1', 1);

  const epicCall = createCalls.find((c) => c.type === 'epic');
  assert.ok(epicCall, 'épico deve ter sido criado');
  assert.equal(epicCall!.aiProject, '/home/user/dev/jogo');
  assert.ok(res.cards.some((c) => c.type === 'epic'));
});

test('apply(): sem aiProject na proposta, épico não recebe o campo (retrocompat)', async () => {
  const proposal = baseProposal(); // sem aiProject

  const prisma = {
    backlogChatSession: {
      findUnique: async () => ({ id: 's1', boardId: 'b1', status: 'open' }),
      update: async () => ({}),
    },
    backlogProposalRevision: {
      findUnique: async () => ({ sessionId: 's1', version: 1, proposal }),
    },
    dodItem: { create: async () => ({}) },
    affectedFlow: { create: async () => ({}) },
  } as unknown as PrismaService;

  const createCalls: Array<Record<string, unknown>> = [];
  let seq = 0;
  const cards = {
    create: async (dto: Record<string, unknown>) => {
      createCalls.push(dto);
      seq += 1;
      const prefix = dto.type === 'epic' ? 'EP' : dto.type === 'story' ? 'US' : 'TK';
      return { id: `${dto.type}-${seq}`, key: `${prefix}-${seq}`, title: dto.title };
    },
  } as unknown as CardsService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    cards,
  );

  await orch.apply('s1', 1);
  const epicCall = createCalls.find((c) => c.type === 'epic');
  assert.ok(epicCall);
  assert.equal('aiProject' in epicCall!, false);
});
