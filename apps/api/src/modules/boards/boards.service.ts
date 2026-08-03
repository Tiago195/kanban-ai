import { Injectable, NotFoundException } from '@nestjs/common';
import type { ValidationStrategy } from '@kanban-ai/shared';
import { ValidationStrategy as PrismaValidationStrategy } from '@prisma/client';
import { PrismaService } from '../../shared/db/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';

const VALIDATION_TO_SHARED: Record<PrismaValidationStrategy, ValidationStrategy> = {
  [PrismaValidationStrategy.flows_regression]: 'flows+regression',
  [PrismaValidationStrategy.bug_gone_regression]: 'bug-gone+regression',
  [PrismaValidationStrategy.regression_only]: 'regression-only',
};

/**
 * Serviço de leitura/escrita de Boards.
 * v1: leitura real; mutações mais complexas ficam como TODO.
 */
@Injectable()
export class BoardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  findAll() {
    return this.prisma.board.findMany({
      include: { columns: { orderBy: { position: 'asc' } } },
    });
  }

  async findOne(id: string) {
    const board = await this.prisma.board.findUnique({
      where: { id },
      include: {
        columns: { orderBy: { position: 'asc' } },
        labels: true,
        assignees: true,
        loopProfiles: { orderBy: { name: 'asc' } },
      },
    });
    if (!board) return board;
    return {
      ...board,
      loopProfiles: board.loopProfiles.map((profile) => ({
        ...profile,
        validation: VALIDATION_TO_SHARED[profile.validation],
      })),
    };
  }

  // TODO: create/update/delete board + colunas padrão.

  /** Define (ou limpa, com null) o modelo default do quadro e emite `board.updated`. */
  async setDefaultModel(id: string, defaultModel: string | null) {
    const board = await this.prisma.board.findUnique({ where: { id }, select: { id: true } });
    if (!board) throw new NotFoundException('board inexistente');
    await this.prisma.board.update({ where: { id }, data: { defaultModel } });
    this.realtime.broadcast({ type: 'board.updated', boardId: id, defaultModel });
    return this.findOne(id);
  }
}
