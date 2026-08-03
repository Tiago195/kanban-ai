import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { IterationPhase, ValidationStrategy } from '@kanban-ai/shared';
import { ValidationStrategy as PrismaValidationStrategy } from '@prisma/client';
import { PrismaService } from '../../shared/db/prisma.service';

const PHASE_OPTIONS: IterationPhase[] = ['reproduce', 'analysis', 'implementation', 'validation'];

/** Enum do Prisma (underscore) → formato do contrato compartilhado (com +/-). */
const VALIDATION_TO_SHARED: Record<PrismaValidationStrategy, ValidationStrategy> = {
  [PrismaValidationStrategy.flows_regression]: 'flows+regression',
  [PrismaValidationStrategy.bug_gone_regression]: 'bug-gone+regression',
  [PrismaValidationStrategy.regression_only]: 'regression-only',
};

const VALIDATION_TO_PRISMA: Record<ValidationStrategy, PrismaValidationStrategy> = {
  'flows+regression': PrismaValidationStrategy.flows_regression,
  'bug-gone+regression': PrismaValidationStrategy.bug_gone_regression,
  'regression-only': PrismaValidationStrategy.regression_only,
};

interface LoopProfileRow {
  id: string;
  boardId: string;
  profileId: string;
  name: string;
  builtin: boolean;
  description: string;
  phases: IterationPhase[];
  validation: PrismaValidationStrategy;
  firstStep: string;
}

@Injectable()
export class LoopProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(row: LoopProfileRow) {
    return { ...row, validation: VALIDATION_TO_SHARED[row.validation] };
  }

  async findAll(boardId?: string) {
    const rows = await this.prisma.loopProfile.findMany({
      where: boardId ? { boardId } : undefined,
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => this.toDto(row as LoopProfileRow));
  }

  private normalizePhases(phases?: string[]): IterationPhase[] {
    const filtered = (phases ?? []).filter((phase): phase is IterationPhase =>
      PHASE_OPTIONS.includes(phase as IterationPhase),
    );
    const list: IterationPhase[] = filtered.length ? filtered : ['analysis', 'implementation'];
    // a última fase é SEMPRE a validação (teste de mesa dos fluxos).
    if (list[list.length - 1] !== 'validation') list.push('validation');
    return list;
  }

  async create(data: {
    boardId: string;
    name: string;
    description?: string;
    phases?: string[];
    validation?: ValidationStrategy;
    firstStep?: string;
  }) {
    const name = data.name?.trim();
    if (!name) throw new BadRequestException('name é obrigatório');
    const profileId = `lp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const row = await this.prisma.loopProfile.create({
      data: {
        boardId: data.boardId,
        profileId,
        name,
        builtin: false,
        description: data.description ?? 'Perfil personalizado.',
        phases: this.normalizePhases(data.phases),
        validation: VALIDATION_TO_PRISMA[data.validation ?? 'flows+regression'],
        firstStep: data.firstStep ?? 'Entender a tarefa, onde mexer e os efeitos colaterais.',
      },
    });
    return this.toDto(row as LoopProfileRow);
  }

  async update(
    id: string,
    data: {
      name?: string;
      description?: string;
      phases?: string[];
      validation?: ValidationStrategy;
      firstStep?: string;
    },
  ) {
    const existing = await this.prisma.loopProfile.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('loop profile não encontrado');

    const patch: Record<string, unknown> = {};
    // perfis embutidos só permitem ajustar description/phases (não o nome nem identidade).
    if (data.name !== undefined && !existing.builtin) patch.name = data.name.trim() || existing.name;
    if (data.description !== undefined) patch.description = data.description;
    if (data.phases !== undefined) patch.phases = this.normalizePhases(data.phases);
    if (data.validation !== undefined) patch.validation = VALIDATION_TO_PRISMA[data.validation];
    if (data.firstStep !== undefined) patch.firstStep = data.firstStep;

    const row = await this.prisma.loopProfile.update({ where: { id }, data: patch });
    return this.toDto(row as LoopProfileRow);
  }

  async remove(id: string) {
    const existing = await this.prisma.loopProfile.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('loop profile não encontrado');
    if (existing.builtin) throw new BadRequestException('perfis embutidos não podem ser excluídos');

    // desvincula labels que apontavam para este perfil (usa profileId, não o uuid).
    await this.prisma.label.updateMany({
      where: { boardId: existing.boardId, loopProfileId: existing.profileId },
      data: { loopProfileId: null },
    });
    await this.prisma.loopProfile.delete({ where: { id } });
    return { deletedId: id, profileId: existing.profileId };
  }
}
