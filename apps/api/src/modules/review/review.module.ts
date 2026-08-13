import { Module } from '@nestjs/common';

import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

/**
 * US-OBS3 (ADR-0037) — comentários de review por linha.
 *
 * `PrismaService` vem do `PrismaModule` global; `RealtimeService` é global
 * (`@Global` em `RealtimeModule`), então basta declarar o provider/controller.
 */
@Module({
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
