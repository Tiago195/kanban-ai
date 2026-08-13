import { Injectable, NotFoundException } from '@nestjs/common';
import type { ReviewComment, ReviewCommentInput } from '@kanban-ai/shared';

import { PrismaService } from '../../shared/db/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';

/** Linha crua do Prisma para `ReviewComment` (datas como `Date`). */
type ReviewCommentRow = {
  id: string;
  cardId: string;
  iterationId: string | null;
  filePath: string;
  line: number;
  body: string;
  author: string;
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * US-OBS3 (ADR-0037) — CRUD de comentários de review POR LINHA.
 *
 * Comentários são OBSERVABILIDADE/evidência vinculada a um card (task/story) e
 * opcionalmente à iteração que os originou. Eles NÃO reintroduzem
 * DOR/acceptance nem formam um novo checklist obrigatório — o único gate de
 * conclusão continua sendo o DOD (ADR-0007).
 *
 * Emite `review.comment_added` pelo mesmo hub WS dos demais eventos ao criar.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Persiste um comentário de review e emite `review.comment_added`. */
  async addComment(input: ReviewCommentInput): Promise<ReviewComment> {
    const row = (await this.prisma.reviewComment.create({
      data: {
        cardId: input.cardId,
        iterationId: input.iterationId ?? null,
        filePath: input.filePath,
        line: input.line,
        body: input.body,
        author: input.author,
      },
    })) as ReviewCommentRow;

    const comment = this.map(row);
    this.realtime.broadcast({
      type: 'review.comment_added',
      cardId: comment.cardId,
      comment,
    });
    return comment;
  }

  /** Lista os comentários de um card (por arquivo/linha, mais antigos primeiro). */
  async listByCard(cardId: string): Promise<ReviewComment[]> {
    const rows = (await this.prisma.reviewComment.findMany({
      where: { cardId },
      orderBy: [{ filePath: 'asc' }, { line: 'asc' }, { createdAt: 'asc' }],
    })) as ReviewCommentRow[];
    return rows.map((r) => this.map(r));
  }

  /** Marca um comentário como resolvido (idempotente). */
  async resolve(commentId: string): Promise<ReviewComment> {
    const existing = (await this.prisma.reviewComment.findUnique({
      where: { id: commentId },
    })) as ReviewCommentRow | null;
    if (!existing) {
      throw new NotFoundException(`ReviewComment ${commentId} não encontrado`);
    }
    const row = (await this.prisma.reviewComment.update({
      where: { id: commentId },
      data: { resolved: true },
    })) as ReviewCommentRow;
    return this.map(row);
  }

  private map(row: ReviewCommentRow): ReviewComment {
    return {
      id: row.id,
      cardId: row.cardId,
      iterationId: row.iterationId ?? null,
      filePath: row.filePath,
      line: row.line,
      body: row.body,
      author: row.author,
      resolved: row.resolved,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(row.createdAt).toISOString(),
      updatedAt:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : new Date(row.updatedAt).toISOString(),
    };
  }
}
