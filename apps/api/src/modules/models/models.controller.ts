import { Controller, Get } from '@nestjs/common';
import type { AgentModel } from '@kanban-ai/shared';
import { ModelsService } from './models.service';

@Controller('agents')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  /** Lista os modelos de AI disponiveis para o login atual. */
  @Get('models')
  list(): { models: AgentModel[]; default: string } {
    return { models: this.models.list(), default: this.models.defaultModelId() };
  }
}
