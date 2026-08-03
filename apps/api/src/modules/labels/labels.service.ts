import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';

@Injectable()
export class LabelsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(boardId?: string) {
    return this.prisma.label.findMany({ where: boardId ? { boardId } : undefined });
  }

  create(data: { boardId: string; name: string; color?: string; loopProfileId?: string }) {
    return this.prisma.label.create({ data });
  }

  update(id: string, data: { loopProfileId?: string | null; name?: string; color?: string }) {
    return this.prisma.label.update({ where: { id }, data });
  }

  remove(id: string) {
    return this.prisma.label.delete({ where: { id } });
  }
}
