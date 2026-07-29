import { Module } from '@nestjs/common';
import { ConfigModule } from './shared/config/config.module';
import { PrismaModule } from './shared/db/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { HealthModule } from './modules/health/health.module';
import { BoardsModule } from './modules/boards/boards.module';
import { CardsModule } from './modules/cards/cards.module';
import { LabelsModule } from './modules/labels/labels.module';
import { AssigneesModule } from './modules/assignees/assignees.module';
import { AiEngineModule } from './modules/ai-engine/ai-engine.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RealtimeModule,
    WorkspacesModule,
    HealthModule,
    BoardsModule,
    CardsModule,
    LabelsModule,
    AssigneesModule,
    AiEngineModule,
  ],
})
export class AppModule {}
