import { Logger, Module } from '@nestjs/common';
import { Orchestrator } from './orchestrator';
import { AiEngineController } from './ai-engine.controller';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { ValidationRunner } from './validators/validation.runner';
import { CopilotCliRunner } from './runners/copilot-cli.runner';
import { MockAgentRunner } from './runners/mock-agent.runner';
import { AGENT_RUNNER, type AgentRunner } from './runners/agent-runner.interface';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { WorkspaceService } from './workspaces/workspace.service';
import { WakeupQueueService } from './wakeup-queue.service';

/**
 * Módulo do loop engine (núcleo).
 *
 * O AgentRunner é injetado via token `AGENT_RUNNER` (plugável). A implementação
 * ativa é escolhida por `config.agent.runnerKind` (env `AGENT_RUNNER_KIND`):
 *  - `mock` (padrão nesta fatia): runner determinístico server-side, sem processo.
 *  - `copilot-cli`: invoca a Copilot CLI (stub até a próxima fatia).
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
    {
      provide: AGENT_RUNNER,
      inject: [APP_CONFIG, MockAgentRunner, CopilotCliRunner],
      useFactory: (
        config: AppConfig,
        mock: MockAgentRunner,
        cli: CopilotCliRunner,
      ): AgentRunner => {
        const active = config.agent.runnerKind === 'copilot-cli' ? cli : mock;
        new Logger('AiEngineModule').log(
          `AGENT_RUNNER ativo: ${config.agent.runnerKind} (${active.id})` +
            (config.agent.runnerKind === 'copilot-cli'
              ? ` — comando: ${config.agent.cliCommand} ${config.agent.cliArgs.join(' ')}`.trimEnd()
              : ''),
        );
        return active;
      },
    },
  ],
  exports: [Orchestrator],
})
export class AiEngineModule {}
