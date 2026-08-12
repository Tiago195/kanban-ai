import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BacklogChatOrchestrator } from './backlog-chat.orchestrator';
import { buildBacklogPrompt } from './skill/backlog-po.prompt';
import type { BacklogProposal } from '@kanban-ai/shared';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { BacklogCliRunner } from './runner/backlog-cli.runner';
import type { CardsService } from '../cards/cards.service';
import type { AssigneesService } from '../assignees/assignees.service';

/**
 * story-chat-threads: valida o rastreio Card ↔ BacklogChatSession.
 *
 * 1) apply() carimba `backlogChatSessionId = sessionId` em épico/story/task.
 * 2) openStorySession() reusa a sessão original (story de backlog-chat) ou cria
 *    uma zerada e vincula (story manual).
 * 3) materializeStoryTasks() cria cards type:task em To Do (via CardsService) e
 *    limpa `needsHuman` da story.
 */

function fullProposal(): BacklogProposal {
  return {
    version: 1,
    epic: { title: 'Épico', description: 'desc', points: 8 },
    stories: [
      {
        id: 's1-0',
        title: 'Story 1',
        description: 'd',
        points: 3,
        tasks: [{ id: 't-0', title: 'Task A', description: 'implementa a Task A' }],
      },
    ],
  };
}

function makeCardsMock(createCalls: Array<Record<string, unknown>>): CardsService {
  let seq = 0;
  return {
    create: async (dto: Record<string, unknown>) => {
      createCalls.push(dto);
      seq += 1;
      const prefix = dto.type === 'epic' ? 'EP' : dto.type === 'story' ? 'US' : 'TK';
      return { id: `${dto.type}-${seq}`, key: `${prefix}-${seq}`, title: dto.title };
    },
  } as unknown as CardsService;
}

test('apply(): carimba backlogChatSessionId em épico, story e task', async () => {
  const proposal = fullProposal();
  const prisma = {
    backlogChatSession: {
      findUnique: async () => ({ id: 'sess-1', boardId: 'b1', status: 'open' }),
      update: async () => ({}),
    },
    backlogProposalRevision: {
      findUnique: async () => ({ sessionId: 'sess-1', version: 1, proposal }),
    },
    dodItem: { create: async () => ({}) },
    affectedFlow: { create: async () => ({}) },
  } as unknown as PrismaService;

  const createCalls: Array<Record<string, unknown>> = [];
  const cards = makeCardsMock(createCalls);

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    cards,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  await orch.apply('sess-1', 1);

  const epicCall = createCalls.find((c) => c.type === 'epic');
  const storyCall = createCalls.find((c) => c.type === 'story');
  const taskCall = createCalls.find((c) => c.type === 'task');
  assert.ok(epicCall && storyCall && taskCall, 'épico, story e task devem existir');
  assert.equal(epicCall!.backlogChatSessionId, 'sess-1');
  assert.equal(storyCall!.backlogChatSessionId, 'sess-1');
  assert.equal(taskCall!.backlogChatSessionId, 'sess-1');
  assert.equal(taskCall!.description, 'implementa a Task A', 'apply preserva a descrição da task');
});

test('openStorySession(): reusa a sessão original quando a story veio de backlog-chat', async () => {
  const prisma = {
    card: {
      findUnique: async () => ({
        id: 'story-1',
        type: 'story',
        title: 'Minha história',
        boardId: 'b1',
        backlogChatSessionId: 'sess-orig',
      }),
      update: async () => {
        throw new Error('não deve vincular ao reusar');
      },
    },
    backlogChatSession: {
      findUnique: async () => ({ id: 'sess-orig', boardId: 'b1', status: 'open' }),
      create: async () => {
        throw new Error('não deve criar nova sessão ao reusar');
      },
    },
    backlogChatMessage: {
      findFirst: async () => null,
    },
  } as unknown as PrismaService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    {} as unknown as CardsService,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  const res = await orch.openStorySession('story-1');
  assert.equal(res.sessionId, 'sess-orig');
  assert.equal(res.storyId, 'story-1');
  assert.equal(res.reused, true);
});

test('openStorySession(): cria sessão zerada e vincula para story manual', async () => {
  let linkedTo: string | null = null;
  const prisma = {
    card: {
      findUnique: async () => ({
        id: 'story-2',
        type: 'story',
        title: 'História manual',
        boardId: 'b9',
        backlogChatSessionId: null,
      }),
      update: async (args: { data: { backlogChatSessionId: string } }) => {
        linkedTo = args.data.backlogChatSessionId;
        return {};
      },
    },
    backlogChatSession: {
      findUnique: async () => null,
      create: async () => ({ id: 'sess-new', boardId: 'b9', title: 'História manual' }),
    },
  } as unknown as PrismaService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    {} as unknown as CardsService,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  const res = await orch.openStorySession('story-2');
  assert.equal(res.sessionId, 'sess-new');
  assert.equal(res.reused, false);
  assert.equal(linkedTo, 'sess-new', 'a story manual deve ter sido vinculada à nova sessão');
});

test('materializeStoryTasks(): cria tasks em To Do e limpa needsHuman', async () => {
  const createCalls: Array<Record<string, unknown>> = [];
  let updated: Record<string, unknown> | null = null;
  const prisma = {
    card: {
      findUnique: async (args: { select?: Record<string, boolean> }) => {
        // 1ª chamada (materialize): dados da story; chamadas em clearStoryNeedsHuman.
        if (args.select && 'needsHuman' in args.select && Object.keys(args.select).length === 1) {
          return { needsHuman: true };
        }
        if (args.select && 'type' in args.select) {
          return {
            id: 'story-3',
            type: 'story',
            boardId: 'b1',
            backlogChatSessionId: 'sess-x',
          };
        }
        return { id: 'story-3', needsHuman: false, needsHumanReason: null };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        updated = args.data;
        return {};
      },
    },
  } as unknown as PrismaService;

  const cards = makeCardsMock(createCalls);
  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    cards,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  const res = await orch.materializeStoryTasks('story-3', [
    { title: 'Task 1', description: 'faz o A e o B' },
    { title: '  ' },
    { title: 'Task 2' },
  ]);
  assert.equal(res.cards.length, 2, 'títulos vazios são ignorados');
  assert.ok(createCalls.every((c) => c.type === 'task' && c.parentId === 'story-3'));
  assert.ok(createCalls.every((c) => c.backlogChatSessionId === 'sess-x'));
  assert.equal(createCalls[0].description, 'faz o A e o B', 'descrição é preservada');
  assert.equal(createCalls[1].description, '', 'sem descrição vira string vazia');
  assert.ok(updated, 'needsHuman deve ter sido limpo');
  assert.equal((updated as Record<string, unknown>).needsHuman, false);
  assert.equal((updated as Record<string, unknown>).needsHumanReason, null);
});

test('resolveAppliedStoryCard(): casa a story-card do board pelo título (sessão applied)', async () => {
  let queried: Record<string, unknown> | null = null;
  const prisma = {
    card: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queried = args.where;
        return [
          { id: 'card-a', title: 'Outra história', boardId: 'b1' },
          { id: 'card-b', title: 'Story 1', boardId: 'b1' },
        ];
      },
    },
  } as unknown as PrismaService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    {} as unknown as CardsService,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  const res = await orch.resolveAppliedStoryCard('sess-1', '  Story 1 ');
  assert.ok(res, 'deve resolver a story-card');
  assert.equal(res!.storyId, 'card-b', 'casa pelo título (trim), não a primeira');
  assert.equal(res!.sessionId, 'sess-1');
  assert.equal(res!.boardId, 'b1');
  assert.equal(res!.reused, true);
  // Filtra por sessão + type:story (as duas âncoras estáveis do vínculo).
  assert.ok(queried, 'findMany deve ter sido chamado');
  assert.equal((queried as Record<string, unknown>).backlogChatSessionId, 'sess-1');
  assert.equal((queried as Record<string, unknown>).type, 'story');
});

test('resolveAppliedStoryCard(): retorna null quando nenhuma story-card casa', async () => {
  const prisma = {
    card: {
      findMany: async () => [
        { id: 'card-a', title: 'A', boardId: 'b1' },
        { id: 'card-b', title: 'B', boardId: 'b1' },
      ],
    },
  } as unknown as PrismaService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    {} as unknown as CardsService,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  const res = await orch.resolveAppliedStoryCard('sess-1', 'Inexistente');
  assert.equal(res, null, 'sem match único, resolve null');
});

test('resolveAppliedStoryCard(): fallback para a única story-card da sessão', async () => {
  const prisma = {
    card: {
      findMany: async () => [{ id: 'card-only', title: 'Título renomeado', boardId: 'b1' }],
    },
  } as unknown as PrismaService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    {} as unknown as CardsService,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  const res = await orch.resolveAppliedStoryCard('sess-1', 'Título original diferente');
  assert.ok(res, 'com uma única story-card, casa por fallback');
  assert.equal(res!.storyId, 'card-only');
});

test('materializeStoryTasks() numa sessão applied: cria filhos sem tocar épico/stories', async () => {
  // Simula o caminho pós-apply: a story-card já existe (carimbada com a sessão),
  // e materializar cria SÓ os cards type:task filhos — nenhum épico/story novo.
  const createCalls: Array<Record<string, unknown>> = [];
  const prisma = {
    card: {
      findUnique: async (args: { select?: Record<string, boolean> }) => {
        if (args.select && 'needsHuman' in args.select && Object.keys(args.select).length === 1) {
          return { needsHuman: false };
        }
        return {
          id: 'story-applied',
          type: 'story',
          boardId: 'b1',
          backlogChatSessionId: 'sess-applied',
        };
      },
      update: async () => ({}),
    },
  } as unknown as PrismaService;

  const cards = makeCardsMock(createCalls);
  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    cards,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  const res = await orch.materializeStoryTasks('story-applied', [
    { title: 'Nova task 1' },
    { title: 'Nova task 2' },
  ]);
  assert.equal(res.cards.length, 2);
  assert.ok(
    createCalls.every((c) => c.type === 'task'),
    'nenhum épico/story é recriado — só tasks',
  );
  assert.ok(
    createCalls.every((c) => c.parentId === 'story-applied'),
    'tasks são filhas da story-card existente',
  );
  assert.ok(
    createCalls.every((c) => c.backlogChatSessionId === 'sess-applied'),
    'tasks herdam o vínculo de sessão da story',
  );
});

test('buildBacklogPrompt(): com storyCard injeta o contexto da story e proíbe "qual é a história?"', () => {
  const prompt = buildBacklogPrompt({
    boardTitle: 'Meu Board',
    history: [],
    userText: 'me ajuda com as tasks',
    storyCard: {
      key: 'US-37',
      title: 'Engine de regras do Super Velha',
      description: 'Implementar o motor de regras do jogo.',
      aiSummary: 'Contexto do jogo da velha 3x3.',
      aiNotes: 'Atenção às condições de vitória diagonais.',
      points: 5,
      dod: ['Regras testadas', 'Cobertura > 80%'],
      epicTitle: 'Super Velha',
      existingTasks: ['Modelar tabuleiro'],
    },
  });
  // O bloco do chat da story aparece e carrega os dados reais.
  assert.match(prompt, /CHAT DE UMA STORY QUE JÁ EXISTE/);
  assert.match(prompt, /US-37/);
  assert.match(prompt, /Engine de regras do Super Velha/);
  assert.match(prompt, /Implementar o motor de regras do jogo\./);
  assert.match(prompt, /Contexto do jogo da velha 3x3\./);
  assert.match(prompt, /Regras testadas/);
  assert.match(prompt, /Super Velha/); // épico
  assert.match(prompt, /Modelar tabuleiro/); // task existente
  // Instrução explícita para NÃO perguntar qual é a história.
  assert.match(prompt, /NÃO pergunte "qual é a história"/);
});

test('buildBacklogPrompt(): sem storyCard NÃO injeta o bloco do chat da story', () => {
  const prompt = buildBacklogPrompt({
    boardTitle: 'Meu Board',
    history: [],
    userText: 'quero um backlog',
  });
  assert.doesNotMatch(prompt, /CHAT DE UMA STORY QUE JÁ EXISTE/);
});

test('buildBacklogPrompt(): storyCard emite KANBAN_TASKS (não texto puro)', () => {
  const prompt = buildBacklogPrompt({
    boardTitle: 'Meu Board',
    history: [],
    userText: 'sugira as tasks',
    storyCard: {
      key: 'US-38',
      title: 'História com tasks',
      description: 'desc',
      points: 3,
      dod: [],
      existingTasks: [],
    },
  });
  // Deve instruir a emissão do bloco de controle estruturado.
  assert.match(prompt, /KANBAN_TASKS/);
  assert.match(prompt, /<<<KANBAN_TASKS>>>/);
  assert.match(prompt, /<<<END_KANBAN_TASKS>>>/);
});

test('buildBacklogPrompt(): focusTask injeta thread da task e instrui KANBAN_TASKS_PATCH', () => {
  const prompt = buildBacklogPrompt({
    boardTitle: 'Meu Board',
    history: [],
    userText: 'muda o título dessa task',
    focusTask: {
      id: 'task-abc',
      index: 2,
      title: 'Implementar endpoint de login',
      description: 'com validação',
    },
  });
  assert.match(prompt, /KANBAN_TASKS_PATCH/);
  assert.match(prompt, /<<<KANBAN_TASKS_PATCH>>>/);
  // Ancora nos paths cirúrgicos do índice da task focada.
  assert.match(prompt, /\/tasks\/2\/title/);
  assert.match(prompt, /Implementar endpoint de login/);
});

test('buildBacklogPrompt(): currentTaskProposalJson aparece como proposta corrente', () => {
  const json = JSON.stringify({ version: 3, tasks: [{ id: 't1', title: 'X' }] });
  const prompt = buildBacklogPrompt({
    boardTitle: 'Meu Board',
    history: [],
    userText: 'ok',
    currentTaskProposalJson: json,
  });
  assert.match(prompt, /"version":3/);
  assert.match(prompt, /KANBAN_TASKS_PATCH/);
});

test('applyTaskPatch(): aplica ops cirúrgicas e incrementa a versão', async () => {
  const created: Array<Record<string, unknown>> = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const current = {
    version: 1,
    tasks: [
      { id: 't1', title: 'Task um', description: 'desc um' },
      { id: 't2', title: 'Task dois' },
    ],
    rationale: 'antes',
  };
  const prisma = {
    backlogChatMessage: {
      findFirst: async () => ({ proposal: current }),
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'm1' };
      },
    },
  } as unknown as PrismaService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast: (e: Record<string, unknown>) => broadcasts.push(e) } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    {} as unknown as CardsService,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  await (orch as unknown as {
    applyTaskPatch: (sessionId: string, patch: unknown) => Promise<void>;
  }).applyTaskPatch('sess-1', {
    ops: [
      { op: 'replace', path: '/tasks/0/title', value: 'Task um (refinada)' },
      { op: 'remove', path: '/tasks/1' },
      { op: 'add', path: '/tasks/-', value: { title: 'Task nova' } },
      { op: 'replace', path: '/rationale', value: 'depois' },
    ],
  });

  assert.equal(created.length, 1, 'grava uma msg task_proposal');
  const next = created[0].proposal as {
    version: number;
    rationale?: string;
    tasks: Array<{ title: string }>;
  };
  assert.equal(next.version, 2, 'incrementa a versão');
  assert.equal(next.rationale, 'depois');
  assert.equal(next.tasks[0].title, 'Task um (refinada)');
  // t2 removida; task nova adicionada no fim.
  assert.equal(next.tasks.length, 2);
  assert.equal(next.tasks[1].title, 'Task nova');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, 'backlog.task_proposal');
});

test('resolveStoryCardContext(): resolve a story-card única vinculada à sessão (com DoD, épico e tasks)', async () => {
  const prisma = {
    card: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        // 1ª chamada: stories vinculadas à sessão.
        if (args.where.type === 'story') {
          return [
            {
              id: 'story-1',
              key: 'US-37',
              title: 'Engine de regras',
              description: 'desc',
              aiSummary: 'sum',
              aiNotes: 'notes',
              points: 5,
              parent: { title: 'Super Velha', type: 'epic' },
            },
          ];
        }
        // 2ª chamada: tasks filhas.
        return [{ title: 'Modelar tabuleiro' }];
      },
    },
    dodItem: {
      findMany: async () => [{ text: 'Regras testadas' }, { text: 'Cobertura > 80%' }],
    },
  } as unknown as PrismaService;

  const orch = new BacklogChatOrchestrator(
    prisma,
    { broadcast() {} } as unknown as RealtimeService,
    {} as unknown as BacklogCliRunner,
    {} as unknown as CardsService,
    { findAll: async () => [] } as unknown as AssigneesService,
  );

  const ctx = await (
    orch as unknown as {
      resolveStoryCardContext: (id: string) => Promise<Record<string, unknown> | undefined>;
    }
  ).resolveStoryCardContext('sess-1');

  assert.ok(ctx, 'deve resolver o contexto da story');
  assert.equal(ctx!.key, 'US-37');
  assert.equal(ctx!.title, 'Engine de regras');
  assert.equal(ctx!.points, 5);
  assert.equal(ctx!.epicTitle, 'Super Velha');
  assert.deepEqual(ctx!.dod, ['Regras testadas', 'Cobertura > 80%']);
  assert.deepEqual(ctx!.existingTasks, ['Modelar tabuleiro']);
});

test('resolveStoryCardContext(): retorna undefined quando há 0 ou >1 story vinculada', async () => {
  const makeOrch = (stories: unknown[]) => {
    const prisma = {
      card: { findMany: async () => stories },
      dodItem: { findMany: async () => [] },
    } as unknown as PrismaService;
    return new BacklogChatOrchestrator(
      prisma,
      { broadcast() {} } as unknown as RealtimeService,
      {} as unknown as BacklogCliRunner,
      {} as unknown as CardsService,
      { findAll: async () => [] } as unknown as AssigneesService,
    );
  };
  const call = (orch: BacklogChatOrchestrator) =>
    (
      orch as unknown as {
        resolveStoryCardContext: (id: string) => Promise<Record<string, unknown> | undefined>;
      }
    ).resolveStoryCardContext('sess-1');

  assert.equal(await call(makeOrch([])), undefined, '0 stories → undefined');
  assert.equal(
    await call(makeOrch([{ id: 'a', type: 'story' }, { id: 'b', type: 'story' }])),
    undefined,
    '>1 story (backlog-chat aplicado com várias) → undefined (chat geral)',
  );
});
