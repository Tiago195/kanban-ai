import { Module } from '@nestjs/common';
import { Orchestrator } from './orchestrator';
import { AiEngineController } from './ai-engine.controller';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { ValidationRunner } from './validators/validation.runner';
import { CopilotCliRunner } from './runners/copilot-cli.runner';
import { MockAgentRunner } from './runners/mock-agent.runner';
import { AGENT_RUNNER, type AgentRunner } from './runners/agent-runner.interface';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';

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
    CopilotCliRunner,
    MockAgentRunner,
    {
      provide: AGENT_RUNNER,
      inject: [APP_CONFIG, MockAgentRunner, CopilotCliRunner],
      useFactory: (
        config: AppConfig,
        mock: MockAgentRunner,
        cli: CopilotCliRunner,
      ): AgentRunner => (config.agent.runnerKind === 'copilot-cli' ? cli : mock),
    },
  ],
  exports: [Orchestrator],
})
export class AiEngineModule {}
