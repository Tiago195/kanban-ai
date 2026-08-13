import { Module } from '@nestjs/common';

import { AiEngineModule } from '../ai-engine/ai-engine.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * US-OBS1 — módulo do dashboard de frota (`GET /dashboard`).
 *
 * Importa `AiEngineModule` para injetar o `Orchestrator` (que ele exporta) e
 * reusar `computeStoryMetrics`. `PrismaService` vem do `PrismaModule` global.
 */
@Module({
  imports: [AiEngineModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
