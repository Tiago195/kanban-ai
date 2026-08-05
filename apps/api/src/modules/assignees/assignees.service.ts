import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';

/** Assignees = agents autônomos (não humanos). */
@Injectable()
export class AssigneesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(boardId?: string) {
    return this.prisma.assignee.findMany({ where: boardId ? { boardId } : undefined });
  }

  create(data: { boardId: string; name: string; model?: string; instructions?: string }) {
    return this.prisma.assignee.create({
      data: {
        boardId: data.boardId,
        name: data.name,
        model: data.model,
        instructions: data.instructions ?? '',
      },
    });
  }

  remove(id: string) {
    return this.prisma.assignee.delete({ where: { id } });
  }
}
