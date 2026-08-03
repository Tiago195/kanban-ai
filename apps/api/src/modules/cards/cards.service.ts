import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { TASK_CREATION_COLUMNS } from '@kanban-ai/shared';
import type { EpicDerivedStatus } from '@kanban-ai/shared';
import type {
  AttachAssigneeDto,
  AttachLabelDto,
  CreateCardDto,
  CreateDodItemDto,
  CreateFlowDto,
  MoveCardDto,
  UpdateCardDto,
  UpdateDodItemDto,
} from './cards.schema';
import { deriveEpicStatus, type ColumnLike } from './cards.epic-status';
import { mapIteration, type PrismaIterationRow } from './iteration.mapper';
import { Orchestrator } from '../ai-engine/orchestrator';
import { ModelsService } from '../models/models.service';

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

  async findAll(boardId?: string) {
    const cards = await this.prisma.card.findMany({
      where: boardId ? { boardId } : undefined,
      orderBy: [{ type: 'asc' }, { position: 'asc' }],
      include: {
        labels: { select: { labelId: true } },
        assignees: { select: { assigneeId: true } },
      },
    });
    const summaries = cards.map(({ labels, assignees, ...card }) => ({
      ...card,
      labelIds: labels.map((l) => l.labelId),
      assigneeIds: assignees.map((a) => a.assigneeId),
    }));
    await this.attachResolvedModel(summaries, boardId);
    return this.attachEpicStatus(summaries);
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

      // Posição = fim da coluna alvo.
      const position =
        dto.type === 'task'
          ? taskColumnId
            ? await tx.card.count({ where: { taskColumnId } })
            : 0
          : columnId
            ? await tx.card.count({ where: { boardColumnId: columnId } })
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
          ...(dto.type === 'task'
            ? { taskColumnId }
            : { boardColumnId: columnId }),
        },
      });
    });

    this.realtime.broadcast({ type: 'card.created', card: card as never });
    return card;
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

      const toColumn = await tx.column.findUnique({ where: { id: dto.columnId } });
      if (!toColumn) throw new BadRequestException('coluna de destino inexistente');

      const isTaskBoard = toColumn.isTaskColumn;
      const fromColumnId = isTaskBoard ? card.taskColumnId : card.boardColumnId;

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

      return { card, toColumn, fromColumnId, isTaskBoard, everInProgress };
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
      // Acorda o loop engine (auto-play server-side).
      await this.orchestrator.onStoryEnterInProgress(id);
    }

    // Recomputa e emite o status do epic pai (para stories).
    if (!result.isTaskBoard && result.card.parentId) {
      await this.emitEpicStatus(result.card.parentId);
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
