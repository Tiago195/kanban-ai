import { Module } from '@nestjs/common';
import { CardsController } from './cards.controller';
import { CardsService } from './cards.service';
import { AiEngineModule } from '../ai-engine/ai-engine.module';
import { ModelsModule } from '../models/models.module';

@Module({
  imports: [AiEngineModule, ModelsModule],
  controllers: [CardsController],
  providers: [CardsService],
  exports: [CardsService],
})
export class CardsModule {}
