import { Inject, Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
} from './agent-runner.interface';
import { CliAdapter, type CliEvent } from './cli-adapter';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';

/**
 * Implementação real do AgentRunner: invoca a **Copilot CLI** (ou qualquer
 * comando compatível com o protocolo JSONL do CliAdapter) como subprocesso.
 *
 * Fluxo:
 *  1. Monta o comando via CliAdapter e faz `spawn` no `input.cwd` (worktree).
 *  2. Entrega o prompt (stdin ou arg, conforme promptMode).
 *  3. Lê stdout linha a linha → parseia em CliEvent → emite `onChunk`
 *     (thought/output), trata `question` (HITL, bloqueia via `onQuestion`) e
 *     `result` (resultado final da iteração).
 *  4. Respeita `input.signal` (AbortSignal) para stop hard: mata o processo.
 *  5. Timeout de inatividade de stdout (streamIdleTimeoutMs).
 *
 * Ver docs/loop-engine.md, ADR-0016 e ADR-0017.
 */
@Injectable()
export class CopilotCliRunner implements AgentRunner {
  readonly id = 'copilot-cli';
  private readonly logger = new Logger(CopilotCliRunner.name);
  private readonly adapter: CliAdapter;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.adapter = new CliAdapter(config);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const plan = this.adapter.buildSpawnPlan(input.prompt);
    this.logger.log(
      `spawn: ${plan.command} ${plan.args.join(' ')} (cwd=${input.cwd}, phase=${input.phase}, modelo=${input.model ?? '(default)'})`,
    );

    const child = spawn(plan.command, plan.args, {
      cwd: input.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Modelo resolvido por-card injetado como COPILOT_MODEL — o adapter o
      // respeita e força `--model <id>` explícito no Copilot CLI.
      // cliSessionId injetado como COPILOT_SESSION_ID — o adapter o traduz em
      // `--session-id <id>`, dando memória e resiliência HITL a restart
      // (retoma a sessão persistida em disco). Ver ADR-0022.
      env:
        input.model || input.cliSessionId
          ? {
              ...process.env,
              ...(input.model ? { COPILOT_MODEL: input.model } : {}),
              ...(input.cliSessionId ? { COPILOT_SESSION_ID: input.cliSessionId } : {}),
            }
          : process.env,
    });

    return this.consume(child, input, plan.stdinPrompt);
  }

  private consume(
    child: ChildProcessWithoutNullStreams,
    input: AgentRunInput,
    stdinPrompt: string | null,
  ): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve, reject) => {
      let result: AgentRunResult | null = null;
      let settled = false;
      let idleTimer: NodeJS.Timeout | null = null;
      // Enquanto uma pergunta HITL está pendente (aguardando resposta humana), o
      // idle timeout de stdout NÃO se aplica: o subprocesso one-shot já encerrou
      // e o humano pode levar minutos para responder. O tempo de espera é
      // governado pelo `hitlTimeoutMs` (em `waitForAnswer`), não por este timer.
      let hitlPending = false;
      // Serializa o processamento das linhas para preservar ordem quando há
      // await (HITL bloqueia até a resposta chegar).
      let queue: Promise<void> = Promise.resolve();

      const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (input.signal) input.signal.removeEventListener('abort', onAbort);
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const kill = () => {
        if (!child.killed) child.kill('SIGTERM');
      };

      const onAbort = () => {
        kill();
        finish(() => reject(new Error('aborted')));
      };

      if (input.signal) {
        if (input.signal.aborted) {
          kill();
          reject(new Error('aborted'));
          return;
        }
        input.signal.addEventListener('abort', onAbort);
      }

      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        // Suspenso durante HITL: não rearmar enquanto aguardamos resposta humana.
        if (hitlPending) return;
        idleTimer = setTimeout(() => {
          kill();
          finish(() =>
            reject(
              new Error(`stream idle timeout (${this.adapter.streamIdleTimeoutMs}ms)`),
            ),
          );
        }, this.adapter.streamIdleTimeoutMs);
      };
      resetIdle();

      // Handlers para a camada de evento pausar/retomar o idle timer ao redor da
      // espera HITL (evita matar a iteração enquanto o humano decide).
      const suspendIdle = () => {
        hitlPending = true;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
      };
      const resumeIdle = () => {
        hitlPending = false;
        resetIdle();
      };

      const rl = readline.createInterface({ input: child.stdout });

      rl.on('line', (line) => {
        resetIdle();
        const event = this.adapter.parseLine(line);
        if (!event) return;
        queue = queue.then(() =>
          this.handleEvent(event, input, child, (r) => {
            result = r;
          }, { suspendIdle, resumeIdle }),
        );
        // Uma falha no processamento (ex.: HITL abortado/substituído/timeout)
        // não pode virar unhandled rejection — encerra a iteração limpando o
        // processo. `finish` é idempotente (só age uma vez).
        queue.catch((err: unknown) => {
          kill();
          finish(() =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
        });
      });

      child.stderr.on('data', (buf: Buffer) => {
        this.logger.debug(`[cli stderr] ${buf.toString().trimEnd()}`);
      });

      child.on('error', (err) => {
        finish(() => reject(err));
      });

      child.on('close', (code) => {
        // Aguarda o processamento (incl. HITL) drenar antes de resolver. Um
        // `.catch` evita unhandled rejection caso o queue já tenha falhado
        // (a rejeição real já foi tratada no handler de `queue.catch` acima).
        void queue
          .then(() => {
            finish(() => {
              if (result) {
                resolve(result);
                return;
              }
              if (code === 0) {
                resolve({
                  detail: '(cli) processo encerrou sem evento result',
                  summary: '(cli) iteração sem resultado estruturado',
                  dodTouched: [],
                  nextStep: 'Revisar saída da CLI (nenhum result emitido)',
                  done: false,
                });
                return;
              }
              reject(new Error(`cli exited with code ${code}`));
            });
          })
          .catch(() => undefined);
      });

      // Entrega o prompt via stdin quando aplicável.
      if (stdinPrompt !== null) {
        child.stdin.write(
          stdinPrompt.endsWith('\n') ? stdinPrompt : `${stdinPrompt}\n`,
        );
      }
    });
  }

  private async handleEvent(
    event: CliEvent,
    input: AgentRunInput,
    child: ChildProcessWithoutNullStreams,
    setResult: (r: AgentRunResult) => void,
    idle: { suspendIdle: () => void; resumeIdle: () => void },
  ): Promise<void> {
    switch (event.kind) {
      case 'thought':
      case 'output':
        input.onChunk?.({ kind: event.kind, delta: event.text });
        return;
      case 'question': {
        if (!input.onQuestion) {
          this.logger.warn(`pergunta ignorada (sem onQuestion): ${event.prompt}`);
          return;
        }
        // Suspende o idle timeout de stdout durante a espera HITL: o humano pode
        // levar minutos e o subprocesso one-shot já encerrou. O `hitlTimeoutMs`
        // (em waitForAnswer) é quem limita essa espera.
        idle.suspendIdle();
        try {
          const answer = await input.onQuestion({
            id: event.id,
            prompt: event.prompt,
            options: event.options,
          });
          // Escreve a resposta no stdin da MESMA sessão → a CLI retoma (quando o
          // runner é interativo). No modelo one-shot do Copilot CLI o processo já
          // encerrou; o write é inofensivo (stdin drenado) e a resposta é
          // reinjetada no prompt da PRÓXIMA iteração via handoff/lastro.
          if (child.stdin.writable) {
            child.stdin.write(answer.endsWith('\n') ? answer : `${answer}\n`);
          }
        } finally {
          idle.resumeIdle();
        }
        return;
      }
      case 'result':
        setResult({
          detail: event.detail,
          summary: event.summary,
          dodTouched: event.dodTouched,
          proposedDod: event.proposedDod,
          affectedFlows: event.affectedFlows,
          nextStep: event.nextStep,
          done: event.done,
          evidence: event.evidence,
          fatalError: event.fatalError,
        });
        return;
    }
  }
}
