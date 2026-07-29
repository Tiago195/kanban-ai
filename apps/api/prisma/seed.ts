/**
 * Seed do Kanban-AI — porta o seed() do artifact de referência
 * (docs/reference/kanban.html), adaptado ao schema Prisma.
 *
 * NOTA v1: `acceptance` e `DOR` foram REMOVIDOS. Apenas DOD.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { BUILTIN_LOOP_PROFILES } from '../src/modules/ai-engine/loop-profiles/loop-profiles';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Limpeza idempotente (ordem respeita FKs via cascade a partir do board).
  await prisma.board.deleteMany({});

  const board = await prisma.board.create({
    data: { title: 'Sprint Board', seq: 0 },
  });

  // ── Colunas do board principal (stories) ──
  const boardColDefs = [
    { title: 'Backlog', wipLimit: null, position: 0 },
    { title: 'To Do', wipLimit: 5, position: 1 },
    { title: 'In Progress', wipLimit: 3, position: 2 },
    { title: 'Review', wipLimit: 3, position: 3 },
    { title: 'Done', wipLimit: null, position: 4 },
  ];
  const boardCols: Record<string, string> = {};
  for (const c of boardColDefs) {
    const col = await prisma.column.create({
      data: {
        boardId: board.id,
        title: c.title,
        wipLimit: c.wipLimit ?? undefined,
        position: c.position,
        isTaskColumn: false,
      },
    });
    boardCols[c.title] = col.id;
  }

  // ── Colunas do mini-kanban de tasks (protegidas) ──
  const taskColDefs = ['To Do', 'In Progress', 'Review', 'Done'];
  const taskCols: Record<string, string> = {};
  for (let i = 0; i < taskColDefs.length; i++) {
    const col = await prisma.column.create({
      data: {
        boardId: board.id,
        title: taskColDefs[i],
        position: i,
        protected: true,
        isTaskColumn: true,
      },
    });
    taskCols[taskColDefs[i]] = col.id;
  }

  // ── Loop profiles embutidos ──
  for (const p of Object.values(BUILTIN_LOOP_PROFILES)) {
    await prisma.loopProfile.create({
      data: {
        boardId: board.id,
        profileId: p.id,
        name: p.name,
        builtin: p.builtin,
        description: p.description,
        phases: p.phases,
        validation:
          p.validation === 'flows+regression'
            ? 'flows_regression'
            : p.validation === 'bug-gone+regression'
              ? 'bug_gone_regression'
              : 'regression_only',
        firstStep: p.firstStep,
      },
    });
  }

  // ── Labels (Bug->bug, Feature->feature vinculam a loop profiles) ──
  const labelDefs = [
    { name: 'Bug', color: '#e5484d', loopProfileId: 'bug' },
    { name: 'Feature', color: '#3b82f6', loopProfileId: 'feature' },
    { name: 'Chore', color: '#8b5cf6' },
    { name: 'Docs', color: '#0ea5e9' },
    { name: 'Urgent', color: '#f59e0b' },
  ];
  const labels: string[] = [];
  for (const l of labelDefs) {
    const label = await prisma.label.create({
      data: {
        boardId: board.id,
        name: l.name,
        color: l.color,
        loopProfileId: l.loopProfileId,
      },
    });
    labels.push(label.id);
  }

  // ── Assignees (agents autônomos) ──
  const agentDefs = [
    { name: 'Claude-Dev', model: 'opus' },
    { name: 'GPT-Reviewer', model: 'gpt' },
    { name: 'Copilot-QA', model: 'copilot' },
  ];
  const agents: string[] = [];
  for (const a of agentDefs) {
    const agent = await prisma.assignee.create({
      data: { boardId: board.id, name: a.name, model: a.model },
    });
    agents.push(agent.id);
  }

  // Helper para criar card com chave sequencial.
  let seq = 0;
  const mkCard = async (
    data: Omit<Prisma.CardCreateInput, 'board' | 'key'> & { type: 'epic' | 'story' | 'task' },
  ): Promise<string> => {
    seq += 1;
    const prefix = data.type === 'epic' ? 'EP' : data.type === 'story' ? 'US' : 'TK';
    const card = await prisma.card.create({
      data: { ...data, key: `${prefix}-${seq}`, board: { connect: { id: board.id } } },
    });
    await prisma.activity.create({ data: { cardId: card.id, text: 'card criado' } });
    return card.id;
  };

  const chk = (items: Array<{ text: string; done?: boolean }>) =>
    items.map((t, i) => ({ text: t.text, done: !!t.done, position: i }));

  // ── Épico ──
  const ep1 = await mkCard({
    type: 'epic',
    title: 'Onboarding de novos clientes',
    description: 'Épico que cobre todo o fluxo de entrada de um novo cliente no produto.',
    labels: { create: [{ labelId: labels[1] }] },
    dodItems: { create: chk([{ text: 'Todas as histórias em Done' }, { text: 'Métrica de sucesso atingida' }]) },
  });

  // ── Story US-1 (In Progress) ──
  const us1 = await mkCard({
    type: 'story',
    title: 'Cadastro com e-mail e senha',
    description: 'Como visitante, quero me cadastrar com e-mail e senha, para acessar o produto.',
    points: 5,
    parent: { connect: { id: ep1 } },
    boardColumn: { connect: { id: boardCols['In Progress'] } },
    everInProgress: true,
    aiSummary: 'Implementar cadastro por e-mail/senha, criando a conta e disparando verificação.',
    aiProject: 'uh-openxchange-provisioner-api',
    aiNotes: 'Cuidado com colisão de e-mail já existente e com o hash de senha (bcrypt).',
    labels: { create: [{ labelId: labels[1] }] },
    assignees: { create: [{ assigneeId: agents[0] }] },
    dodItems: {
      create: chk([{ text: 'Código revisado' }, { text: 'Testes automatizados' }, { text: 'Deploy em staging' }]),
    },
    affectedFlows: {
      create: [
        {
          name: 'Cadastro de usuário',
          files: ['src/routes/signup.js', 'src/services/userService.js'],
          note: 'Fluxo principal criado por esta história.',
        },
        {
          name: 'Envio de e-mail de verificação',
          files: ['src/services/mailService.js'],
          note: 'Disparado após criar a conta.',
        },
        {
          name: 'Login',
          files: ['src/routes/login.js'],
          note: 'Regressão: garantir que login continua ok com o novo hash.',
        },
      ],
    },
    comments: { create: [{ text: 'Iniciando implementação do endpoint.' }] },
  });

  // ── Tasks da US-1 ──
  const t1 = await mkCard({
    type: 'task',
    title: 'Criar endpoint POST /signup',
    parent: { connect: { id: us1 } },
    taskColumn: { connect: { id: taskCols['In Progress'] } },
    loopType: 'feature',
    execState: 'implementing',
    assignees: { create: [{ assigneeId: agents[0] }] },
    labels: { create: [{ labelId: labels[1] }] },
    dodItems: {
      create: chk([
        { text: 'Endpoint responde 201 com payload válido' },
        { text: 'E-mail duplicado retorna 409' },
        { text: 'Testes de integração passando' },
      ]),
    },
    iterations: {
      create: [
        {
          index: 1,
          agentId: agents[0],
          phase: 'analysis',
          detail:
            'Mapeado o endpoint POST /signup em src/routes/signup.js. Precisa validar corpo (e-mail/senha), checar duplicidade em userService e persistir com hash bcrypt. Efeito colateral: dispara mailService (verificação). Cuidado com condição de corrida em e-mails simultâneos.',
          summary: 'Analisei o endpoint e mapeei arquivos e efeitos colaterais.',
          handoffState: 'implementing',
          handoffNextStep: 'Implementar o handler do POST /signup com validação e criação da conta.',
          handoffFiles: ['src/routes/signup.js', 'src/services/userService.js'],
          handoffDodIds: [],
          dodTouched: [],
        },
      ],
    },
  });

  const t2 = await mkCard({
    type: 'task',
    title: 'Validação de senha forte',
    parent: { connect: { id: us1 } },
    taskColumn: { connect: { id: taskCols['In Progress'] } },
    loopType: 'feature',
    execState: 'idle',
    assignees: { create: [{ assigneeId: agents[2] }] },
    dodItems: {
      create: chk([{ text: 'Regra de senha forte aplicada' }, { text: 'Mensagem de erro clara' }]),
    },
  });

  // t2 depende de t1
  await prisma.taskDependency.create({ data: { dependentId: t2, dependsOnId: t1 } });

  // Task de docs (Done)
  await mkCard({
    type: 'task',
    title: 'Escrever docs de API',
    parent: { connect: { id: us1 } },
    taskColumn: { connect: { id: taskCols['Done'] } },
    execState: 'done',
    labels: { create: [{ labelId: labels[3] }] },
    assignees: { create: [{ assigneeId: agents[1] }] },
  });

  // ── Demais stories ──
  await mkCard({
    type: 'story',
    title: 'Recuperação de senha',
    description: 'Como usuário, quero recuperar minha senha por e-mail.',
    points: 3,
    parent: { connect: { id: ep1 } },
    boardColumn: { connect: { id: boardCols['To Do'] } },
    blocked: true,
    labels: { create: [{ labelId: labels[0] }] },
    assignees: { create: [{ assigneeId: agents[1] }] },
  });

  await mkCard({
    type: 'story',
    title: 'Dashboard inicial',
    description: 'Tela inicial pós-login.',
    points: 8,
    parent: { connect: { id: ep1 } },
    boardColumn: { connect: { id: boardCols['Review'] } },
    labels: { create: [{ labelId: labels[1] }] },
    assignees: { create: [{ assigneeId: agents[0] }] },
  });

  await mkCard({
    type: 'story',
    title: 'Auditoria de acesso',
    description: 'Registrar logins.',
    points: 5,
    parent: { connect: { id: ep1 } },
    boardColumn: { connect: { id: boardCols['Backlog'] } },
    labels: { create: [{ labelId: labels[2] }] },
  });

  // Atualiza o contador de chaves do board.
  await prisma.board.update({ where: { id: board.id }, data: { seq } });

  const counts = {
    cards: await prisma.card.count(),
    labels: await prisma.label.count(),
    assignees: await prisma.assignee.count(),
    loopProfiles: await prisma.loopProfile.count(),
    iterations: await prisma.iteration.count(),
  };
  // eslint-disable-next-line no-console
  console.log('Seed concluído:', counts);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
