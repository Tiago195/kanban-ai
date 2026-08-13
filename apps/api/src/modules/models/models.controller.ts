import { Controller, Get } from '@nestjs/common';
import type { AgentAdapterDescriptor, AgentModel } from '@kanban-ai/shared';
import { ModelsService } from './models.service';
import { AgentAdapterRegistry } from '../ai-engine/runners/agent-adapter.registry';

@Controller('agents')
export class ModelsController {
  constructor(
    private readonly models: ModelsService,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /** Lista os modelos de AI disponiveis para o login atual. */
  @Get('models')
  list(): { models: AgentModel[]; default: string } {
    return { models: this.models.list(), default: this.models.defaultModelId() };
  }

  /**
   * US-OBS4 — lista os adapters multi-agente conhecidos (copilot-cli/claude/
   * codex/gemini/mock) com `isDefault`/`available`. NUNCA expõe credenciais:
   * `available` é apenas um booleano de presença. Ver ADR-0036.
   */
  @Get('adapters')
  listAdapters(): { adapters: AgentAdapterDescriptor[] } {
    return { adapters: this.adapters.listDescriptors() };
  }
}
