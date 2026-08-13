import { Logger, Module } from '@nestjs/common';
import { Orchestrator } from './orchestrator';
import { AiEngineController } from './ai-engine.controller';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { ValidationRunner } from './validators/validation.runner';
import { CopilotCliRunner } from './runners/copilot-cli.runner';
import { MockAgentRunner } from './runners/mock-agent.runner';
import { AgentAdapterRegistry } from './runners/agent-adapter.registry';
import { AGENT_RUNNER, type AgentRunner } from './runners/agent-runner.interface';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { WorkspaceService } from './workspaces/workspace.service';
import { WakeupQueueService } from './wakeup-queue.service';

/**
 * Módulo do loop engine (núcleo).
 *
 * O AgentRunner é injetado via token `AGENT_RUNNER` (plugável). US-OBS4: a
 * implementação ativa é resolvida pelo `AgentAdapterRegistry` a partir de
 * `config.agentAdapter` (env `AGENT_ADAPTER`, default `copilot-cli`). O legado
 * `AGENT_RUNNER_KIND` (`mock|copilot-cli`) continua respeitado como fallback
 * para não regredir os ambientes de dev/testes que o usam.
 *
 * O AgentSessionManager é in-process; ponto de extensão para BullMQ+Redis.
 */
@Module({
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
      inject: [APP_CONFIG, AgentAdapterRegistry, MockAgentRunner],
      useFactory: (
        config: AppConfig,
        registry: AgentAdapterRegistry,
        mock: MockAgentRunner,
      ): AgentRunner => {
        // Retrocompat: o legado AGENT_RUNNER_KIND=mock ainda força o mock
        // (dev/testes). Fora isso, o adapter resolve via registry a partir de
        // AGENT_ADAPTER, mantendo copilot-cli como default.
        const active =
          config.agent.runnerKind === 'mock' &&
          process.env.AGENT_ADAPTER === undefined
            ? mock
            : registry.resolveActive();
        new Logger('AiEngineModule').log(
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
