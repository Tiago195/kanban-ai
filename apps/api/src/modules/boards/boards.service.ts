import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';

/**
 * Serviço de leitura/escrita de Boards.
 * v1: leitura real; mutações mais complexas ficam como TODO.
 */
@Injectable()
export class BoardsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.board.findMany({
      include: { columns: { orderBy: { position: 'asc' } } },
    });
  }

  findOne(id: string) {
    return this.prisma.board.findUnique({
      where: { id },
      include: {
        columns: { orderBy: { position: 'asc' } },
        labels: true,
        assignees: true,
        loopProfiles: true,
      },
    });
  }

  // TODO: create/update/delete board + colunas padrão.
}
