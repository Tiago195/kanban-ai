import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';
import { TASK_CREATION_COLUMNS } from '@kanban-ai/shared';
import type { CreateCardDto } from './cards.schema';

/**
 * Serviço de Cards (epic | story | task).
 * Concentra as invariantes de domínio extraídas do artifact.
 */
@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(boardId?: string) {
    return this.prisma.card.findMany({
      where: boardId ? { boardId } : undefined,
      orderBy: [{ type: 'asc' }, { position: 'asc' }],
    });
  }

  findOne(id: string) {
    return this.prisma.card.findUnique({
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
      },
    });
  }

  /**
   * Cria um card aplicando as invariantes de domínio.
   * INVARIANTE: task só pode ser criada em coluna Backlog/To Do.
   */
  async create(dto: CreateCardDto) {
    if (dto.type === 'task' && dto.columnId) {
      const column = await this.prisma.column.findUnique({ where: { id: dto.columnId } });
      const title = column?.title ?? '';
      if (!(TASK_CREATION_COLUMNS as readonly string[]).includes(title)) {
        throw new BadRequestException(
          `Tasks só podem ser criadas em: ${TASK_CREATION_COLUMNS.join(', ')}`,
        );
      }
    }

    const board = await this.prisma.board.findUnique({ where: { id: dto.boardId } });
    if (!board) throw new BadRequestException('board inexistente');

    const seq = board.seq + 1;
    const prefix = dto.type === 'epic' ? 'EP' : dto.type === 'story' ? 'US' : 'TK';

    // TODO: transação + posicionamento correto na coluna + emissão de evento WS card.created.
    const [, card] = await this.prisma.$transaction([
      this.prisma.board.update({ where: { id: board.id }, data: { seq } }),
      this.prisma.card.create({
        data: {
          boardId: dto.boardId,
          type: dto.type,
          key: `${prefix}-${seq}`,
          title: dto.title,
          description: dto.description ?? '',
          points: dto.points,
          parentId: dto.parentId ?? null,
          ...(dto.type === 'task'
            ? { taskColumnId: dto.columnId }
            : { boardColumnId: dto.columnId }),
        },
      }),
    ]);

    return card;
  }

  // TODO: move() com regra de epic derivado das stories + emissão de eventos WS.
}
