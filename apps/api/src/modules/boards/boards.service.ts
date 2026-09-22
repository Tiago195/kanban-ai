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

  /**
   * OBS-01/06: o board tem DUAS raias de colunas que compartilham títulos
   * (Backlog/To Do/In Progress/Review/Done) — a raia de board/story
   * (`isTaskColumn:false`) e a raia de task (`isTaskColumn:true`). Via REST puro
   * os títulos se repetem e parecem duplicados. Além do booleano `isTaskColumn`
   * (fonte da verdade), expomos um campo derivado `lane` ('board' | 'task') para
   * deixar a distinção óbvia a qualquer consumidor do endpoint.
   */
  private withLane<C extends { isTaskColumn: boolean }>(column: C): C & { lane: 'board' | 'task' } {
    return { ...column, lane: column.isTaskColumn ? 'task' : 'board' };
  }

  private decorateColumns<T extends { columns: Array<{ isTaskColumn: boolean }> }>(board: T) {
    return { ...board, columns: board.columns.map((c) => this.withLane(c)) };
  }

  async findAll() {
    const boards = await this.prisma.board.findMany({
      include: { columns: { orderBy: { position: 'asc' } } },
    });
    return boards.map((board) => this.decorateColumns(board));
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
    return this.decorateColumns({
      ...board,
      loopProfiles: board.loopProfiles.map((profile) => ({
        ...profile,
        validation: VALIDATION_TO_SHARED[profile.validation],
      })),
    });
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

  /**
   * US-F3.10 — define (ou limpa, com null) o adapter default do quadro (raiz da
   * cascata de adapter, análogo a setDefaultModel) e emite `board.updated`.
   */
  async setDefaultAdapter(id: string, defaultAdapter: string | null) {
    const board = await this.prisma.board.findUnique({ where: { id }, select: { id: true } });
    if (!board) throw new NotFoundException('board inexistente');
    await this.prisma.board.update({ where: { id }, data: { defaultAdapter } });
    this.realtime.broadcast({ type: 'board.updated', boardId: id, defaultAdapter });
    return this.findOne(id);
  }

  /**
   * EP-PROJECT / US-PROJ6 — associa (ou desassocia, com null) o `Project` do
   * quadro (raiz da cascata de repo-alvo). Valida a FK quando não-nula (recusa
   * projectId inexistente) e emite `board.updated` para a UI refletir sem F5.
   */
  async setProjectId(id: string, projectId: string | null) {
    const board = await this.prisma.board.findUnique({ where: { id }, select: { id: true } });
    if (!board) throw new NotFoundException('board inexistente');
    if (projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('project inexistente');
    }
    await this.prisma.board.update({ where: { id }, data: { projectId } });
    this.realtime.broadcast({ type: 'board.updated', boardId: id, projectId });
    return this.findOne(id);
  }
}
