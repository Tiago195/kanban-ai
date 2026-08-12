import { Module } from '@nestjs/common';
import { ConfigModule } from './shared/config/config.module';
import { PrismaModule } from './shared/db/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { HealthModule } from './modules/health/health.module';
import { BoardsModule } from './modules/boards/boards.module';
import { CardsModule } from './modules/cards/cards.module';
import { LabelsModule } from './modules/labels/labels.module';
import { LoopProfilesModule } from './modules/loop-profiles/loop-profiles.module';
import { AssigneesModule } from './modules/assignees/assignees.module';
import { ModelsModule } from './modules/models/models.module';
import { AiEngineModule } from './modules/ai-engine/ai-engine.module';
import { BacklogChatModule } from './modules/backlog-chat/backlog-chat.module';
import { MemoryModule } from './modules/memory/memory.module';

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
    LoopProfilesModule,
    AssigneesModule,
    ModelsModule,
    AiEngineModule,
    BacklogChatModule,
    MemoryModule,
  ],
})
export class AppModule {}
