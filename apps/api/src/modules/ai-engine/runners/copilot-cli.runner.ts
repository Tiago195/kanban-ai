import { Injectable, Logger } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult, AgentRunner } from './agent-runner.interface';

/**
 * Implementação v1 do AgentRunner: invoca a **Copilot CLI** como subprocesso.
 *
 * ⚠️ STUB — a execução real ainda não está implementada. Ver TODOs.
 *
 * Decisões em aberto (documentadas em docs/loop-engine.md):
 *  - Formato exato do payload enviado à CLI (flags/stdin/arquivo de prompt).
 *  - Como detectar "iteração terminou": exit code, parse de stdout, ou arquivo
 *    de saída estruturado (JSON) escrito pela CLI.
 *  - Como extrair `dodTouched` / `nextStep` / `done` do output.
 */
@Injectable()
export class CopilotCliRunner implements AgentRunner {
  readonly id = 'copilot-cli';
  private readonly logger = new Logger(CopilotCliRunner.name);

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.logger.warn(
      `CopilotCliRunner.run() é um STUB (cwd=${input.cwd}, model=${input.model}, phase=${input.phase})`,
    );

    // TODO: spawn('copilot', [...], { cwd: input.cwd, signal: input.signal })
    // TODO: escrever o prompt (input.prompt) via stdin ou arquivo temporário.
    // TODO: capturar stdout/stderr; respeitar input.signal (AbortSignal) para stop hard.
    // TODO: parsear o resultado estruturado e mapear para AgentRunResult.

    return {
      detail: '(stub) nenhuma execução real ocorreu',
      summary: '(stub) iteração não implementada',
      dodTouched: [],
      nextStep: 'Implementar CopilotCliRunner.run()',
      done: false,
    };
  }
}
