import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/db/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { TASK_CREATION_COLUMNS, MISSING_REQUIRED_FIELDS } from '@kanban-ai/shared';
import type { EpicDerivedStatus, MissingRequiredFieldsError } from '@kanban-ai/shared';
import type {
  AttachAssigneeDto,
  AttachLabelDto,
  CreateCardDto,
  CreateCommentDto,
  CreateDependencyDto,
  CreateDodItemDto,
  CreateFlowDto,
  ListCardsQueryDto,
  MoveCardDto,
  UpdateCardDto,
  UpdateDodItemDto,
} from './cards.schema';
import { deriveEpicStatus, type ColumnLike } from './cards.epic-status';
import { mapIteration, type PrismaIterationRow } from './iteration.mapper';
import { Orchestrator } from '../ai-engine/orchestrator';
import { ModelsService } from '../models/models.service';
import { BUILTIN_LOOP_PROFILES } from '../ai-engine/loop-profiles/loop-profiles';

/** Status derivado exposto na leitura, por epic. */
export interface EpicStatusView {
  status: EpicDerivedStatus;
  done: number;
  total: number;
}

/**
 * Serviço de Cards (epic | story | task).
 * Concentra as invariantes de domínio extraídas do artifact e emite eventos WS.
 */
@Injectable()
export class CardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly orchestrator: Orchestrator,
    private readonly models: ModelsService,
  ) {}

  async findAll(query: ListCardsQueryDto = {}) {
    const { boardId, type, columnId, updatedSince, limit, cursor, fields, tenantId } = query;
    // Degrada com elegância em schema drift (bug-cards-500): se o health-check
    // de boot detectou coluna(s) ausente(s), respondemos 503 com um aviso
    // acionável em vez de deixar o Prisma estourar um 500 opaco (P2022).
    const health = this.prisma.getSchemaHealth();
    if (health && !health.ok) {
      throw new ServiceUnavailableException({
        message:
          'Banco desatualizado (migrations pendentes). Rode `npm run db:migrate:deploy`.',
        missingColumns: health.missing,
      });
    }
    try {
      // Filtros opcionais (todos retrocompatíveis: ausentes = comportamento antigo).
      const where: Prisma.CardWhereInput = {};
      if (boardId) where.boardId = boardId;
      if (type) where.type = type;
      if (columnId) {
        // Uma coluna pode ser raia de board (stories) ou de task; casa em qualquer uma.
        where.OR = [{ boardColumnId: columnId }, { taskColumnId: columnId }];
      }
      if (updatedSince) where.updatedAt = { gte: new Date(updatedSince) };
      // US-COLAB1: filtro estrito de tenant. Com tenantId, só cards com esse
      // tenantId exato (cards globais com tenantId=null NÃO vazam). Sem tenantId,
      // nenhuma cláusula → todos os cards (retrocompat). Ver ADR-0030.
      if (tenantId) where.tenantId = tenantId;

      // Paginação por cursor: só ativa quando `limit` é passado. Buscamos
      // `limit + 1` para saber se há próxima página sem um count extra.
      const paginated = typeof limit === 'number';
      const cards = await this.prisma.card.findMany({
        where: Object.keys(where).length ? where : undefined,
        orderBy: [{ type: 'asc' }, { position: 'asc' }, { id: 'asc' }],
        include: {
          labels: { select: { labelId: true } },
          assignees: { select: { assigneeId: true } },
        },
        ...(paginated
          ? {
              take: limit + 1,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }
          : {}),
      });

      let nextCursor: string | null = null;
      let page = cards;
      if (paginated && cards.length > limit) {
        page = cards.slice(0, limit);
        nextCursor = page[page.length - 1]?.id ?? null;
      }

      const summaries = page.map(({ labels, assignees, ...card }) => ({
        ...card,
        labelIds: labels.map((l) => l.labelId),
        assigneeIds: assignees.map((a) => a.assigneeId),
      }));
      await this.attachResolvedModel(summaries, boardId);
      const enriched = await this.attachEpicStatus(summaries);

      // Projeção `summary`: campos essenciais para consumidores headless (MCP/LLM)
      // não estourarem contexto. `full` (default) mantém retrocompatibilidade.
      const projected = fields === 'summary' ? enriched.map(projectSummary) : enriched;

      // Só embrulha em envelope quando paginado, preservando o contrato antigo
      // (array puro) para o front-end e demais consumidores existentes.
      return paginated ? { items: projected, nextCursor } : projected;
    } catch (err) {
      // Rede de segurança: se o health-check não pegou o drift (ex.: banco
      // indisponível no boot) mas a query falha por coluna inexistente (P2022),
      // traduzimos para 503 acionável em vez de vazar um 500 opaco.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2022') {
        const column = (err.meta as { column?: string } | undefined)?.column;
        throw new ServiceUnavailableException({
          message:
            'Banco desatualizado (migrations pendentes). Rode `npm run db:migrate:deploy`.',
          missingColumns: column ? [column] : [],
        });
      }
      throw err;
    }
  }

  /**
   * Anexa `resolvedModel` a cada card resolvendo a cascata em memória
   * (card → parent → board.defaultModel → CLI default), sem N+1 no banco.
   */
  private async attachResolvedModel<
    T extends { id: string; parentId: string | null; boardId: string; model: string | null },
  >(cards: T[], boardId?: string): Promise<void> {
    if (cards.length === 0) return;
    const byId = new Map(cards.map((c) => [c.id, c]));

    const boardIds = boardId ? [boardId] : [...new Set(cards.map((c) => c.boardId))];
    const boards = await this.prisma.board.findMany({
      where: { id: { in: boardIds } },
      select: { id: true, defaultModel: true },
    });
    const boardDefault = new Map(boards.map((b) => [b.id, b.defaultModel]));
    const cliDefault = this.models.defaultModelId();

    const resolveFor = (card: T): string => {
      let node: T | undefined = card;
      const seen = new Set<string>();
      while (node && !seen.has(node.id)) {
        seen.add(node.id);
        if (node.model) return node.model;
        node = node.parentId ? byId.get(node.parentId) : undefined;
      }
      return boardDefault.get(card.boardId) ?? cliDefault;
    };

    for (const card of cards) {
      (card as T & { resolvedModel: string }).resolvedModel = resolveFor(card);
    }
  }

  async findOne(id: string) {
    const card = await this.prisma.card.findUnique({
      where: { id },
      include: {
        dodItems: { orderBy: { position: 'asc' } },
        comments: { orderBy: { ts: 'asc' } },
        activities: { orderBy: { ts: 'asc' } },
        affectedFlows: true,
        iterations: { orderBy: { index: 'asc' } },
        labels: { include: { label: true } },
        assignees: { include: { assignee: true } },
        children: true,
        dependsOn: { include: { dependsOn: { select: { id: true, key: true, title: true, execState: true } } } },
      },
    });
    if (!card) return card;
    const resolvedModel = await this.resolveModel(card.id, card.parentId, card.boardId, card.model);
    return {
      ...card,
      resolvedModel,
      iterations: card.iterations.map((it) => mapIteration(it as PrismaIterationRow)),
    };
  }

  /**
   * Resolve o modelo efetivo de um card via herança em cascata:
   * `card.model ?? parent.model (recursivo) ?? board.defaultModel ?? CLI default`.
   */
  async resolveModel(
    cardId: string,
    parentId: string | null,
    boardId: string,
    ownModel: string | null,
  ): Promise<string> {
    if (ownModel) return ownModel;

    // Sobe a hierarquia (task → story → epic) procurando um model explícito.
    let currentParentId = parentId;
    const seen = new Set<string>([cardId]);
    while (currentParentId && !seen.has(currentParentId)) {
      seen.add(currentParentId);
      const parent = await this.prisma.card.findUnique({
        where: { id: currentParentId },
        select: { model: true, parentId: true },
      });
      if (!parent) break;
      if (parent.model) return parent.model;
      currentParentId = parent.parentId;
    }

    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
      select: { defaultModel: true },
    });
    if (board?.defaultModel) return board.defaultModel;

    return this.models.defaultModelId();
  }

  /**
   * Anexa `epicStatus` (derivado) a cada card do tipo epic da lista.
   * Não persiste — é computado a partir das stories filhas.
   */
  private async attachEpicStatus<T extends { id: string; type: string }>(cards: T[]) {
    const epics = cards.filter((c) => c.type === 'epic');
    if (epics.length === 0) return cards;

    const boardIds = new Set(
      cards.map((c) => (c as unknown as { boardId?: string }).boardId).filter(Boolean) as string[],
    );
    const columns = await this.prisma.column.findMany({
      where: boardIds.size ? { boardId: { in: [...boardIds] } } : undefined,
    });
    const columnsById = new Map<string, ColumnLike>(columns.map((c) => [c.id, c]));

    const statusByEpic = new Map<string, EpicStatusView>();
    for (const epic of epics) {
      const stories = await this.prisma.card.findMany({
        where: { parentId: epic.id, type: 'story' },
        select: { everInProgress: true, boardColumnId: true },
      });
      statusByEpic.set(epic.id, deriveEpicStatus(stories, columnsById));
    }

    return cards.map((c) =>
      c.type === 'epic' ? { ...c, epicStatus: statusByEpic.get(c.id) } : c,
    );
  }

  /**
   * Valida um `loopType` contra os profiles builtin e os LoopProfile custom do
   * board. Lança BadRequestException listando os válidos quando não encontrado.
   */
  private async validateLoopType(boardId: string, loopType: string): Promise<void> {
    if (BUILTIN_LOOP_PROFILES[loopType]) return;
    const custom = await this.prisma.loopProfile.findUnique({
      where: { boardId_profileId: { boardId, profileId: loopType } },
    });
    if (custom) return;
    const builtinIds = Object.keys(BUILTIN_LOOP_PROFILES);
    const customProfiles = await this.prisma.loopProfile.findMany({
      where: { boardId },
      select: { profileId: true },
    });
    const validIds = [...new Set([...builtinIds, ...customProfiles.map((p) => p.profileId)])];
    throw new BadRequestException(
      `loopType '${loopType}' inválido. Válidos: ${validIds.join(', ')}`,
    );
  }

  /**
   * Cria um card aplicando as invariantes de domínio.
   * INVARIANTE: task só pode ser criada em coluna Backlog/To Do.
   */
  async create(dto: CreateCardDto) {
    const columnId = dto.columnId;
    if (dto.type === 'task' && columnId) {
      const column = await this.prisma.column.findUnique({ where: { id: columnId } });
      const title = column?.title ?? '';
      if (!(TASK_CREATION_COLUMNS as readonly string[]).includes(title)) {
        throw new BadRequestException(
          `Tasks só podem ser criadas em: ${TASK_CREATION_COLUMNS.join(', ')}`,
        );
      }
    }

    // INVARIANTE: task não tem story points (só story/epic os têm).
    if (dto.type === 'task' && dto.points != null) {
      throw new BadRequestException('task não tem story points; use points apenas em story/epic');
    }

    if (dto.loopType !== undefined) {
      await this.validateLoopType(dto.boardId, dto.loopType);
    }

    if (dto.idempotencyKey) {
      const existing = await this.prisma.card.findFirst({
        where: { boardId: dto.boardId, idempotencyKey: dto.idempotencyKey },
      });
      if (existing) return existing;
    }

    const card = await this.prisma.$transaction(async (tx) => {
      const board = await tx.board.findUnique({ where: { id: dto.boardId } });
      if (!board) throw new BadRequestException('board inexistente');

      const seq = board.seq + 1;
      const prefix = dto.type === 'epic' ? 'EP' : dto.type === 'story' ? 'US' : 'TK';
      await tx.board.update({ where: { id: board.id }, data: { seq } });

      // #1: garantir que toda task nasça numa coluna do mini-kanban. Se o POST
      // não informou columnId, cai na coluna de task "To Do".
      let taskColumnId = dto.type === 'task' ? columnId : undefined;
      if (dto.type === 'task' && !taskColumnId) {
        const todo = await tx.column.findFirst({
          where: { boardId: dto.boardId, isTaskColumn: true, title: 'To Do' },
          select: { id: true },
        });
        taskColumnId = todo?.id;
      }

      // #2: garantir que toda STORY nasça numa coluna do board. Se o POST não
      // informou columnId (ex.: apply do backlog-chat), cai em "Backlog" — do
      // contrário a story fica com boardColumnId=null e não renderiza em nenhuma
      // coluna do board. O EPIC segue SEM coluna: seu status é derivado das
      // stories filhas (invariante de domínio), então nunca ocupa coluna.
      let boardColumnId = dto.type === 'story' || dto.type === 'epic' ? columnId : undefined;
      if (dto.type === 'story' && !boardColumnId) {
        const backlog = await tx.column.findFirst({
          where: { boardId: dto.boardId, isTaskColumn: false, title: 'Backlog' },
          select: { id: true },
        });
        boardColumnId = backlog?.id;
      }

      // Posição = fim da coluna alvo.
      const position =
        dto.type === 'task'
          ? taskColumnId
            ? await tx.card.count({ where: { taskColumnId } })
            : 0
          : boardColumnId
            ? await tx.card.count({ where: { boardColumnId } })
            : 0;

      return tx.card.create({
        data: {
          boardId: dto.boardId,
          type: dto.type,
          key: `${prefix}-${seq}`,
          title: dto.title,
          description: dto.description ?? '',
          points: dto.points ?? null,
          parentId: dto.parentId ?? null,
          position,
          ...(dto.loopType !== undefined ? { loopType: dto.loopType } : {}),
          ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
          ...(dto.idempotencyKey !== undefined ? { idempotencyKey: dto.idempotencyKey } : {}),
          ...(dto.startInPlanMode !== undefined ? { startInPlanMode: dto.startInPlanMode } : {}),
          ...(dto.aiSummary !== undefined ? { aiSummary: dto.aiSummary } : {}),
          ...(dto.aiProject !== undefined ? { aiProject: dto.aiProject } : {}),
          ...(dto.aiNotes !== undefined ? { aiNotes: dto.aiNotes } : {}),
          ...(dto.backlogChatSessionId !== undefined
            ? { backlogChatSessionId: dto.backlogChatSessionId }
            : {}),
          ...(dto.tenantId !== undefined ? { tenantId: dto.tenantId } : {}),
          ...(dto.type === 'task'
            ? { taskColumnId }
            : { boardColumnId }),
        },
      });
    });

    this.realtime.broadcast({ type: 'card.created', card: card as never });

    // BUG-09: quando uma task é adicionada a uma story que JÁ está em In Progress,
    // o loop engine precisa retomar — antes ele ficava parado (a story tinha 0
    // tasks quando entrou em In Progress, ou o auto-play já havia encerrado
    // graceful). Detectamos esse caso e re-disparamos o loop (idempotente).
    if (dto.type === 'task' && card.parentId) {
      await this.maybeResumeLoopOnTaskAdded(card.parentId);
    }

    return card;
  }

  /**
   * BUG-09: se a story-pai está numa coluna "In Progress" do board (lane de
   * board, não de task), reativa o loop engine ao ganhar uma nova task. Também
   * limpa o flag `needsHuman` que o guard de "story sem tasks" (BUG-08) possa
   * ter setado, para que a retomada não fique presa no badge "Precisa de você".
   * `onStoryEnterInProgress` é idempotente (se já houver sessão ativa, é no-op).
   */
  private async maybeResumeLoopOnTaskAdded(storyId: string): Promise<void> {
    const story = await this.prisma.card.findUnique({
      where: { id: storyId },
      select: {
        id: true,
        type: true,
        needsHuman: true,
        boardColumn: { select: { isTaskColumn: true, title: true } },
      },
    });
    if (!story || story.type !== 'story') return;

    const inProgress =
      story.boardColumn?.isTaskColumn === false &&
      story.boardColumn?.title === 'In Progress';
    if (!inProgress) return;

    if (story.needsHuman) {
      await this.prisma.card.update({
        where: { id: storyId },
        data: { needsHuman: false, needsHumanReason: null },
      });
    }

    await this.orchestrator.enqueueWakeup(storyId, 'task_added');
    await this.orchestrator.onStoryEnterInProgress(storyId);
  }

  /**
   * Exclui um card e todos os seus descendentes (cascata pela relação
   * `Hierarchy` no schema). Se o card excluído for uma story, recomputa o status
   * do epic pai. Emite `card.deleted` com todos os ids removidos.
   */
  async remove(id: string) {
    const card = await this.prisma.card.findUnique({ where: { id } });
    if (!card) throw new NotFoundException('card inexistente');

    // Coleta recursiva de descendentes (para informar a UI quais cards sumiram).
    const deletedIds: string[] = [];
    const collect = async (cardId: string) => {
      deletedIds.push(cardId);
      const children = await this.prisma.card.findMany({
        where: { parentId: cardId },
        select: { id: true },
      });
      for (const child of children) {
        await collect(child.id);
      }
    };
    await collect(id);

    // A FK `parentId` tem onDelete: Cascade — apagar o card raiz remove a árvore.
    await this.prisma.card.delete({ where: { id } });

    this.realtime.broadcast({
      type: 'card.deleted',
      cardId: id,
      parentId: card.parentId,
      deletedIds,
    });

    // Story removida altera o status derivado do epic pai.
    if (card.type === 'story' && card.parentId) {
      await this.emitEpicStatus(card.parentId);
    }

    return { deletedIds };
  }

  /**
   * Move um card entre colunas (board ou mini-kanban), recalculando posições na
   * origem e no destino, marcando `everInProgress` e recomputando o status do
   * epic pai. Tudo em transação; emite `card.moved` e (se mudou) `epic.status.derived`.
   */
  async move(id: string, dto: MoveCardDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      const card = await tx.card.findUnique({ where: { id } });
      if (!card) throw new NotFoundException('card inexistente');

      // INVARIANTE: epic é derivado das stories filhas; ninguém o move
      // diretamente (o front nem o renderiza em colunas arrastáveis).
      if (card.type === 'epic') {
        throw new BadRequestException(
          'epic não pode ser movido: seu status é derivado das stories filhas',
        );
      }

      const toColumn = await tx.column.findUnique({ where: { id: dto.columnId } });
      if (!toColumn) throw new BadRequestException('coluna de destino inexistente');

      // GATE: uma story só pode entrar em "In Progress" se tiver um
      // Projeto-alvo (aiProject) definido — próprio ou herdado do épico pai.
      // Sem ele, o loop engine não consegue criar o worktree isolado no
      // repositório-alvo e a AI não tem onde trabalhar. Rejeitamos a transição
      // com um código estruturado para o front exigir o campo certo.
      if (
        card.type === 'story' &&
        !toColumn.isTaskColumn &&
        toColumn.title.trim().toLowerCase() === 'in progress'
      ) {
        let effectiveProject = card.aiProject?.trim() ?? '';
        if (!effectiveProject && card.parentId) {
          const epic = await tx.card.findUnique({
            where: { id: card.parentId },
            select: { aiProject: true },
          });
          effectiveProject = epic?.aiProject?.trim() ?? '';
        }
        if (!effectiveProject) {
          const payload: MissingRequiredFieldsError = {
            code: MISSING_REQUIRED_FIELDS,
            fields: ['aiProject'],
            message:
              'Defina o Projeto-alvo (repositório onde a AI trabalha) antes de mover a story para In Progress.',
          };
          throw new BadRequestException(payload);
        }
      }

      const isTaskBoard = toColumn.isTaskColumn;
      const fromColumnId = isTaskBoard ? card.taskColumnId : card.boardColumnId;

      // BUG-A8: capturamos o título da coluna de origem para detectar quando uma
      // story SAI de "In Progress" — assim o orchestrator pode liberar a sessão
      // e destravar a serialização por aiProject (hook simétrico ao enter).
      const fromColumn = fromColumnId
        ? await tx.column.findUnique({
            where: { id: fromColumnId },
            select: { title: true, isTaskColumn: true },
          })
        : null;

      // Coleta os cards atuais da coluna de destino (exceto o próprio), ordenados.
      const destCards = await tx.card.findMany({
        where: isTaskBoard
          ? { taskColumnId: dto.columnId, NOT: { id } }
          : { boardColumnId: dto.columnId, NOT: { id } },
        orderBy: { position: 'asc' },
        select: { id: true },
      });

      const targetIndex =
        dto.position === undefined
          ? destCards.length
          : Math.max(0, Math.min(dto.position, destCards.length));

      // Nova ordem na coluna de destino.
      const ordered = [...destCards.map((c) => c.id)];
      ordered.splice(targetIndex, 0, id);

      // Reescreve posições da coluna de destino.
      for (let i = 0; i < ordered.length; i++) {
        await tx.card.update({
          where: { id: ordered[i] },
          data: {
            position: i,
            ...(isTaskBoard ? { taskColumnId: dto.columnId } : { boardColumnId: dto.columnId }),
          },
        });
      }

      // Recompacta a coluna de origem, se diferente do destino.
      if (fromColumnId && fromColumnId !== dto.columnId) {
        const originCards = await tx.card.findMany({
          where: isTaskBoard
            ? { taskColumnId: fromColumnId, NOT: { id } }
            : { boardColumnId: fromColumnId, NOT: { id } },
          orderBy: { position: 'asc' },
          select: { id: true },
        });
        for (let i = 0; i < originCards.length; i++) {
          await tx.card.update({ where: { id: originCards[i].id }, data: { position: i } });
        }
      }

      // everInProgress pegajoso: story/epic que entra em In Progress+ fica marcado.
      let everInProgress = card.everInProgress;
      if (!isTaskBoard && !everInProgress) {
        const beyond = ['in progress', 'review', 'done'];
        if (beyond.includes(toColumn.title.trim().toLowerCase())) {
          everInProgress = true;
          await tx.card.update({ where: { id }, data: { everInProgress: true } });
        }
      }

      return { card, toColumn, fromColumn, fromColumnId, isTaskBoard, everInProgress };
    });

    this.realtime.broadcast({
      type: 'card.moved',
      cardId: id,
      parentId: result.card.parentId ?? null,
      fromColumnId: result.fromColumnId,
      toColumnId: dto.columnId,
      isTaskBoard: result.isTaskBoard,
    });

    // Story entrou em In Progress — evento dedicado (fundação p/ o loop engine).
    if (
      !result.isTaskBoard &&
      result.card.type === 'story' &&
      result.everInProgress &&
      result.toColumn.title.trim().toLowerCase() === 'in progress'
    ) {
      this.realtime.broadcast({ type: 'story.entered_in_progress', storyId: id });
      // US-COLAB3: enfileira (coalesce) o wakeup durável ANTES de acordar direto.
      await this.orchestrator.enqueueWakeup(id, 'story_in_progress');
      // Acorda o loop engine (auto-play server-side).
      await this.orchestrator.onStoryEnterInProgress(id);
    }

    // BUG-A8: story SAIU de "In Progress" (movida para Done/Review/To Do/Backlog).
    // Libera a sessão em memória e destrava a serialização por aiProject, para
    // que outra story do mesmo repo-alvo não fique bloqueada por uma sessão
    // fantasma. Hook simétrico ao onStoryEnterInProgress.
    if (
      !result.isTaskBoard &&
      result.card.type === 'story' &&
      result.fromColumn?.title?.trim().toLowerCase() === 'in progress' &&
      result.toColumn.title.trim().toLowerCase() !== 'in progress'
    ) {
      this.orchestrator.onStoryLeaveInProgress(id);
    }

    // Recomputa e emite o status do epic pai (para stories).
    if (!result.isTaskBoard && result.card.parentId) {
      await this.emitEpicStatus(result.card.parentId);
    }

    // US-BLOCK3 (EP-BLOCK) — caminho de board/UI para status→Done: quando um card
    // chega numa coluna "Done" (task no mini-kanban ou story no board), acorda os
    // dependentes cujo conjunto de blockers ficou totalmente resolvido (reverso
    // do M3). Delegado ao orchestrator, que aplica invariante 6 + idempotência.
    if (result.toColumn.title.trim().toLowerCase() === 'done') {
      await this.orchestrator.onCardResolved(id);
    }

    return this.findOne(id);
  }

  /** Recomputa o status derivado de um epic e emite `epic.status.derived`. */
  private async emitEpicStatus(epicId: string) {
    const epic = await this.prisma.card.findUnique({ where: { id: epicId } });
    if (!epic || epic.type !== 'epic') return;

    const [stories, columns] = await Promise.all([
      this.prisma.card.findMany({
        where: { parentId: epicId, type: 'story' },
        select: { everInProgress: true, boardColumnId: true },
      }),
      this.prisma.column.findMany({ where: { boardId: epic.boardId } }),
    ]);
    const columnsById = new Map<string, ColumnLike>(columns.map((c) => [c.id, c]));
    const derived = deriveEpicStatus(stories, columnsById);

    this.realtime.broadcast({
      type: 'epic.status.derived',
      epicId,
      status: derived.status,
      done: derived.done,
      total: derived.total,
    });
  }

  /** Edita campos de um card e emite `card.updated`. */
  async update(id: string, dto: UpdateCardDto) {
    const card = await this.prisma.card.findUnique({ where: { id } });
    if (!card) throw new NotFoundException('card inexistente');

    if (dto.points !== undefined && card.type === 'task' && dto.points !== null) {
      throw new BadRequestException('tasks não têm story points');
    }

    if (dto.loopType !== undefined && dto.loopType !== null) {
      await this.validateLoopType(card.boardId, dto.loopType);
    }

    await this.prisma.card.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.points !== undefined ? { points: dto.points } : {}),
        ...(dto.blocked !== undefined ? { blocked: dto.blocked } : {}),
        ...(dto.aiSummary !== undefined ? { aiSummary: dto.aiSummary } : {}),
        ...(dto.aiProject !== undefined ? { aiProject: dto.aiProject } : {}),
        ...(dto.aiNotes !== undefined ? { aiNotes: dto.aiNotes } : {}),
        ...(dto.model !== undefined ? { model: dto.model } : {}),
        ...(dto.loopType !== undefined ? { loopType: dto.loopType } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.startInPlanMode !== undefined ? { startInPlanMode: dto.startInPlanMode } : {}),
      },
    });

    const full = await this.findOne(id);
    this.realtime.broadcast({ type: 'card.updated', cardId: id, card: full as never });
    return full;
  }

  // ── DOD ──────────────────────────────────────────────────────────────────

  async addDodItem(cardId: string, dto: CreateDodItemDto) {
    const card = await this.prisma.card.findUnique({ where: { id: cardId } });
    if (!card) throw new NotFoundException('card inexistente');
    const position = await this.prisma.dodItem.count({ where: { cardId } });
    await this.prisma.dodItem.create({ data: { cardId, text: dto.text, position } });
    return this.emitCardUpdated(cardId);
  }

  async updateDodItem(itemId: string, dto: UpdateDodItemDto) {
    const item = await this.prisma.dodItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('item de DOD inexistente');
    const updated = await this.prisma.dodItem.update({
      where: { id: itemId },
      data: {
        ...(dto.text !== undefined ? { text: dto.text } : {}),
        ...(dto.done !== undefined ? { done: dto.done } : {}),
      },
    });
    if (dto.done !== undefined) {
      this.realtime.broadcast({
        type: 'dod.checked',
        cardId: item.cardId,
        itemId,
        done: updated.done,
      });
    } else {
      await this.emitCardUpdated(item.cardId);
    }
    return updated;
  }

  async removeDodItem(itemId: string) {
    const item = await this.prisma.dodItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('item de DOD inexistente');
    await this.prisma.dodItem.delete({ where: { id: itemId } });
    return this.emitCardUpdated(item.cardId);
  }

  // ── Labels ─────────────────────────────────────────────────────────────────

  async attachLabel(cardId: string, dto: AttachLabelDto) {
    await this.assertCard(cardId);
    await this.prisma.cardLabel.upsert({
      where: { cardId_labelId: { cardId, labelId: dto.labelId } },
      create: { cardId, labelId: dto.labelId },
      update: {},
    });
    this.realtime.broadcast({ type: 'label.attached', cardId, labelId: dto.labelId });
    return this.findOne(cardId);
  }

  async detachLabel(cardId: string, labelId: string) {
    await this.prisma.cardLabel
      .delete({ where: { cardId_labelId: { cardId, labelId } } })
      .catch(() => undefined);
    this.realtime.broadcast({ type: 'label.detached', cardId, labelId });
    return this.findOne(cardId);
  }

  // ── Assignees ────────────────────────────────────────────────────────────────

  async attachAssignee(cardId: string, dto: AttachAssigneeDto) {
    await this.assertCard(cardId);
    await this.prisma.cardAssignee.upsert({
      where: { cardId_assigneeId: { cardId, assigneeId: dto.assigneeId } },
      create: { cardId, assigneeId: dto.assigneeId },
      update: {},
    });
    this.realtime.broadcast({ type: 'assignee.attached', cardId, assigneeId: dto.assigneeId });
    return this.findOne(cardId);
  }

  async detachAssignee(cardId: string, assigneeId: string) {
    await this.prisma.cardAssignee
      .delete({ where: { cardId_assigneeId: { cardId, assigneeId } } })
      .catch(() => undefined);
    this.realtime.broadcast({ type: 'assignee.detached', cardId, assigneeId });
    return this.findOne(cardId);
  }

  // ── AffectedFlows ────────────────────────────────────────────────────────────

  async addFlow(cardId: string, dto: CreateFlowDto) {
    await this.assertCard(cardId);
    await this.prisma.affectedFlow.create({
      data: { cardId, name: dto.name, files: dto.files, note: dto.note },
    });
    return this.emitFlowChanged(cardId);
  }

  async removeFlow(flowId: string) {
    const flow = await this.prisma.affectedFlow.findUnique({ where: { id: flowId } });
    if (!flow) throw new NotFoundException('flow inexistente');
    await this.prisma.affectedFlow.delete({ where: { id: flowId } });
    return this.emitFlowChanged(flow.cardId);
  }

  // ── Comments ─────────────────────────────────────────────────────────────────

  /** Lista os comentários de um card (ordem cronológica). Read-only. */
  async listComments(cardId: string) {
    await this.assertCard(cardId);
    return this.prisma.comment.findMany({
      where: { cardId },
      orderBy: { ts: 'asc' },
    });
  }

  /**
   * Cria um comentário num card (handoff/resumo). Emite `comment.created` para a
   * UI reagir. `authorId` aponta um assignee (agent) ou null.
   */
  async addComment(cardId: string, dto: CreateCommentDto) {
    const card = await this.assertCard(cardId);
    const comment = await this.prisma.comment.create({
      data: { cardId, text: dto.text, authorId: dto.authorId ?? null },
    });
    this.realtime.broadcast({
      type: 'comment.created',
      cardId,
      parentId: card.parentId ?? null,
    });
    return comment;
  }

  // ── Task dependencies (grafo) ─────────────────────────────────────────────────

  /**
   * Cria uma aresta de dependência: a task do path (dependente) precisa que
   * `dependsOnId` termine antes. Valida que ambos existem, são tasks, do mesmo
   * board, e rejeita auto-dependência e ciclo direto (A→B e B→A).
   */
  async addDependency(cardId: string, dto: CreateDependencyDto) {
    if (cardId === dto.dependsOnId) {
      throw new BadRequestException('uma task não pode depender de si mesma');
    }
    const [dependent, dependsOn] = await Promise.all([
      this.prisma.card.findUnique({ where: { id: cardId } }),
      this.prisma.card.findUnique({ where: { id: dto.dependsOnId } }),
    ]);
    if (!dependent) throw new NotFoundException('task dependente inexistente');
    if (!dependsOn) throw new NotFoundException('task de dependência inexistente');
    if (dependent.type !== 'task' || dependsOn.type !== 'task') {
      throw new BadRequestException('dependências só existem entre tasks');
    }
    if (dependent.boardId !== dependsOn.boardId) {
      throw new BadRequestException('as tasks devem pertencer ao mesmo board');
    }
    const inverse = await this.prisma.taskDependency.findUnique({
      where: { dependentId_dependsOnId: { dependentId: dto.dependsOnId, dependsOnId: cardId } },
    });
    if (inverse) {
      throw new BadRequestException('dependência cíclica: a relação inversa já existe');
    }

    await this.prisma.taskDependency.upsert({
      where: { dependentId_dependsOnId: { dependentId: cardId, dependsOnId: dto.dependsOnId } },
      create: { dependentId: cardId, dependsOnId: dto.dependsOnId },
      update: {},
    });
    return this.emitCardUpdated(cardId);
  }

  /** Remove uma aresta de dependência (idempotente). */
  async removeDependency(cardId: string, dependsOnId: string) {
    await this.prisma.taskDependency
      .delete({
        where: { dependentId_dependsOnId: { dependentId: cardId, dependsOnId } },
      })
      .catch(() => undefined);
    return this.emitCardUpdated(cardId);
  }

  // ── helpers de emissão ───────────────────────────────────────────────────────

  private async assertCard(cardId: string) {
    const card = await this.prisma.card.findUnique({ where: { id: cardId } });
    if (!card) throw new NotFoundException('card inexistente');
    return card;
  }

  private async emitCardUpdated(cardId: string) {
    const full = await this.findOne(cardId);
    this.realtime.broadcast({ type: 'card.updated', cardId, card: full as never });
    return full;
  }

  private async emitFlowChanged(cardId: string) {
    const flows = await this.prisma.affectedFlow.findMany({ where: { cardId } });
    this.realtime.broadcast({ type: 'flow.changed', cardId, flows: flows as never });
    return this.findOne(cardId);
  }
}

/**
 * Campos essenciais expostos no modo `fields=summary` do `GET /cards`. Mantém a
 * resposta enxuta para consumidores headless (MCP/LLM) que só precisam navegar a
 * lista — o detalhe completo continua disponível via `get_card`/`GET /cards/:id`.
 */
const SUMMARY_FIELDS = [
  'id',
  'key',
  'boardId',
  'type',
  'title',
  'parentId',
  'boardColumnId',
  'taskColumnId',
  'position',
  'points',
  'blocked',
  'needsHuman',
  'execState',
  'epicStatus',
  'updatedAt',
] as const;

function projectSummary<T extends Record<string, unknown>>(card: T): Partial<T> {
  const out: Partial<T> = {};
  for (const f of SUMMARY_FIELDS) {
    if (f in card) out[f as keyof T] = card[f as keyof T];
  }
  return out;
}
