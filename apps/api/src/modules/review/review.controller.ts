import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { ReviewActionDTO, ReviewComment } from '@kanban-ai/shared';

import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { ReviewService } from './review.service';
import { ReviewActionService } from './review-action.service';
import {
  createReviewCommentSchema,
  snoozeReviewActionSchema,
  type CreateReviewCommentDto,
  type SnoozeReviewActionDto,
} from './review.schema';

/**
 * US-OBS3 (ADR-0037) — comentários de review POR LINHA aninhados no card.
 *
 *  - `POST   /cards/:id/review/comments`                        cria comentário
 *  - `GET    /cards/:id/review/comments`                        lista por card
 *  - `PATCH  /cards/:id/review/comments/:commentId/resolve`     resolve
 *
 * US-OBS2-4 — review actions (sinais de anomalia, visíveis e não-intrusivos):
 *  - `GET    /cards/:id/review/actions`                         lista por card
 *  - `PATCH  /cards/:id/review/actions/:actionId/snooze`        snooza um sinal
 *
 * Observabilidade/evidência — não reintroduz DOR/acceptance (ADR-0007).
 */
@Controller('cards')
export class ReviewController {
  constructor(
    private readonly review: ReviewService,
    private readonly reviewActions: ReviewActionService,
  ) {}

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

  @Get(':id/review/actions')
  listActions(@Param('id') cardId: string): Promise<ReviewActionDTO[]> {
    return this.reviewActions.listByCard(cardId);
  }

  @Patch(':id/review/actions/:actionId/snooze')
  snoozeAction(
    @Param('actionId') actionId: string,
    @Body(new ZodValidationPipe(snoozeReviewActionSchema)) dto: SnoozeReviewActionDto,
  ): Promise<ReviewActionDTO> {
    return this.reviewActions.snooze(actionId, dto.untilMs);
  }
}
