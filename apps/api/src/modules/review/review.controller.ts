import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { ReviewComment } from '@kanban-ai/shared';

import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { ReviewService } from './review.service';
import { createReviewCommentSchema, type CreateReviewCommentDto } from './review.schema';

/**
 * US-OBS3 (ADR-0037) — comentários de review POR LINHA aninhados no card.
 *
 *  - `POST   /cards/:id/review/comments`                        cria comentário
 *  - `GET    /cards/:id/review/comments`                        lista por card
 *  - `PATCH  /cards/:id/review/comments/:commentId/resolve`     resolve
 *
 * Observabilidade/evidência — não reintroduz DOR/acceptance (ADR-0007).
 */
@Controller('cards')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Post(':id/review/comments')
  addComment(
    @Param('id') cardId: string,
    @Body(new ZodValidationPipe(createReviewCommentSchema)) dto: CreateReviewCommentDto,
  ): Promise<ReviewComment> {
    return this.review.addComment({ cardId, ...dto });
  }

  @Get(':id/review/comments')
  listByCard(@Param('id') cardId: string): Promise<ReviewComment[]> {
    return this.review.listByCard(cardId);
  }

  @Patch(':id/review/comments/:commentId/resolve')
  resolve(@Param('commentId') commentId: string): Promise<ReviewComment> {
    return this.review.resolve(commentId);
  }
}
