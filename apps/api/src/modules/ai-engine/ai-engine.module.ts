import { Logger, Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ReviewModule } from '../review/review.module';
import { Orchestrator } from './orchestrator';
import { AiEngineController } from './ai-engine.controller';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { ValidationRunner } from './validators/validation.runner';
import { CopilotCliRunner } from './runners/copilot-cli.runner';
import { MockAgentRunner } from './runners/mock-agent.runner';
import { AgentAdapterRegistry } from './runners/agent-adapter.registry';
import { AGENT_RUNNER, type AgentRunner } from './runners/agent-runner.interface';
import {
  APP_CONFIG,
  warnLegacyAgentRunnerKindOnce,
  type AppConfig,
} from '../../shared/config/config';
import { WorkspaceService } from './workspaces/workspace.service';
import { WakeupQueueService } from './wakeup-queue.service';

/**
 * Módulo do loop engine (núcleo).
 *
 * O AgentRunner é injetado via token `AGENT_RUNNER` (plugável). US-F3.1: a
 * implementação ativa é resolvida pelo `AgentAdapterRegistry` a partir de
 * `config.agentAdapter` — a ÚNICA fonte de verdade da seleção (env
 * `AGENT_ADAPTER`; sem envs, default do processo `mock` — ADR-0014). A env
 * legada `AGENT_RUNNER_KIND`
 * é apenas um alias DEPRECADO que alimenta essa resolução na ausência de
 * `AGENT_ADAPTER` (warning de deprecação emitido uma vez no boot).
 *
 * O AgentSessionManager é in-process; ponto de extensão para BullMQ+Redis.
 */
@Module({
  imports: [ProjectsModule, ReviewModule],
  controllers: [AiEngineController],
  providers: [
    Orchestrator,
    AgentSessionManager,
    ValidationRunner,
    WorkspaceService,
    WakeupQueueService,
    CopilotCliRunner,
    MockAgentRunner,
    AgentAdapterRegistry,
    {
      provide: AGENT_RUNNER,
      inject: [APP_CONFIG, AgentAdapterRegistry],
      useFactory: (
        config: AppConfig,
        registry: AgentAdapterRegistry,
      ): AgentRunner => {
        const logger = new Logger('AiEngineModule');
        // US-F3.1 — config.agentAdapter já absorveu o alias deprecado
        // AGENT_RUNNER_KIND (precedência na resolveAgentAdapter); aqui só
        // resolvemos via registry e avisamos a deprecação UMA vez no boot.
        warnLegacyAgentRunnerKindOnce((message) => logger.warn(message));
        const active = registry.resolveActive();
        logger.log(
          `AGENT_RUNNER ativo: adapter=${config.agentAdapter} (${active.id})` +
            (active.id === 'copilot-cli'
              ? ` — comando: ${config.agent.cliCommand} ${config.agent.cliArgs.join(' ')}`.trimEnd()
              : ''),
        );
        return active;
      },
    },
  ],
  exports: [Orchestrator, AgentAdapterRegistry],
})
export class AiEngineModule {}
