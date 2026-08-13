import { Module } from '@nestjs/common';

import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';
import { ReviewActionService } from './review-action.service';

/**
 * US-OBS3 (ADR-0037) — comentários de review por linha.
 * US-OBS2-4 — review actions (sinais de anomalia rate-limitados/snooze-aware).
 *
 * `PrismaService` vem do `PrismaModule` global; `RealtimeService` é global
 * (`@Global` em `RealtimeModule`), então basta declarar o provider/controller.
 * `ReviewActionService` é EXPORTADO para o `ai-engine` consumir no scan periódico.
 */
@Module({
  controllers: [ReviewController],
  providers: [ReviewService, ReviewActionService],
  exports: [ReviewActionService],
})
export class ReviewModule {}
