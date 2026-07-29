import { Module } from '@nestjs/common';
import { Orchestrator } from './orchestrator';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { ValidationRunner } from './validators/validation.runner';
import { CopilotCliRunner } from './runners/copilot-cli.runner';
import { AGENT_RUNNER } from './runners/agent-runner.interface';

/**
 * Módulo do loop engine (núcleo).
 *
 * O AgentRunner é injetado via token `AGENT_RUNNER` (plugável). v1 = Copilot CLI.
 * O AgentSessionManager é in-process; ponto de extensão para BullMQ+Redis.
 */
@Module({
  providers: [
    Orchestrator,
    AgentSessionManager,
    ValidationRunner,
    CopilotCliRunner,
    { provide: AGENT_RUNNER, useExisting: CopilotCliRunner },
  ],
  exports: [Orchestrator],
})
export class AiEngineModule {}
