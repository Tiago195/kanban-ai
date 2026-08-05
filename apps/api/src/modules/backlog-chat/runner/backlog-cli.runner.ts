import { Inject, Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type {
  BacklogProposal,
  BacklogProposalPatch,
} from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';

/**
 * Evento estruturado extraído do stdout da CLI para o chat de backlog.
 *
 * Reusa o mesmo transporte JSONL do loop engine, mas com kinds próprios do
 * domínio de backlog: além de `thought`/`output`/`question`, reconhece
 * `proposal` (proposta completa) e `patch` (refinamento cirúrgico).
 */
export type BacklogCliEvent =
  | { kind: 'thought'; text: string }
  | { kind: 'output'; text: string }
  | { kind: 'question'; id: string; prompt: string; options?: string[] }
  | { kind: 'proposal'; proposal: BacklogProposal }
  | { kind: 'patch'; patch: BacklogProposalPatch };

/** Callbacks de streaming/HITL de uma execução do chat de backlog. */
export interface BacklogRunHandlers {
  onChunk?: (chunk: { kind: 'thought' | 'output'; delta: string }) => void;
  onQuestion?: (q: { id: string; prompt: string; options?: string[] }) => Promise<string>;
  onProposal?: (proposal: BacklogProposal) => Promise<void> | void;
  onPatch?: (patch: BacklogProposalPatch) => Promise<void> | void;
}

/** Entrada de uma execução (um turno da conversa). */
export interface BacklogRunInput {
  prompt: string;
  signal?: AbortSignal;
  handlers: BacklogRunHandlers;
  /**
   * UUID da sessão do Copilot a retomar. Repassado ao adapter via
   * COPILOT_SESSION_ID → `copilot --session-id <id>`, dando memória
   * conversacional persistente e sobrevivência do HITL a restarts da API.
   */
  cliSessionId?: string;
}

/**
 * Runner dedicado do chat de backlog: invoca a MESMA Copilot CLI (config
 * compartilhada) como subprocesso one-shot por turno, e traduz o stdout JSONL
 * em eventos de backlog.
 *
 * Mantido SEPARADO do `CopilotCliRunner` (loop engine) porque a semântica de
 * saída é diferente: aqui não há `result`/DOD/iteração — há proposta e patch.
 */
@Injectable()
export class BacklogCliRunner {
  readonly id = 'backlog-copilot-cli';
  private readonly logger = new Logger(BacklogCliRunner.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async run(input: BacklogRunInput): Promise<void> {
    const { cliCommand, cliArgs, promptMode } = this.config.agent;
    const useArg = promptMode === 'arg';
    const args = useArg
      ? cliArgs.map((a) => a.replace('{prompt}', input.prompt))
      : [...cliArgs];
    const stdinPrompt = useArg ? null : input.prompt;

    this.logger.log(
      `spawn: ${cliCommand} ${args.join(' ')} (backlog-chat turn)`,
    );

    const child = spawn(cliCommand, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: input.cliSessionId
        ? { ...process.env, COPILOT_SESSION_ID: input.cliSessionId }
        : process.env,
    });

    return this.consume(child, input, stdinPrompt);
  }

  private consume(
    child: ChildProcessWithoutNullStreams,
    input: BacklogRunInput,
    stdinPrompt: string | null,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let idleTimer: NodeJS.Timeout | null = null;
      let hitlPending = false;
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
        if (hitlPending) return;
        idleTimer = setTimeout(() => {
          kill();
          finish(() =>
            reject(
              new Error(
                `stream idle timeout (${this.config.agent.streamIdleTimeoutMs}ms)`,
              ),
            ),
          );
        }, this.config.agent.streamIdleTimeoutMs);
      };
      resetIdle();

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
        const event = this.parseLine(line);
        if (!event) return;
        queue = queue.then(() =>
          this.handleEvent(event, input, child, { suspendIdle, resumeIdle }),
        );
        queue.catch((err: unknown) => {
          kill();
          finish(() =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
        });
      });

      child.stderr.on('data', (buf: Buffer) => {
        this.logger.debug(`[backlog cli stderr] ${buf.toString().trimEnd()}`);
      });
      child.on('error', (err) => finish(() => reject(err)));
      child.on('close', (code) => {
        void queue
          .then(() => {
            finish(() => {
              if (code === 0 || code === null) resolve();
              else reject(new Error(`backlog cli exited with code ${code}`));
            });
          })
          .catch(() => undefined);
      });

      if (stdinPrompt !== null) {
        child.stdin.write(
          stdinPrompt.endsWith('\n') ? stdinPrompt : `${stdinPrompt}\n`,
        );
      }
    });
  }

  private async handleEvent(
    event: BacklogCliEvent,
    input: BacklogRunInput,
    child: ChildProcessWithoutNullStreams,
    idle: { suspendIdle: () => void; resumeIdle: () => void },
  ): Promise<void> {
    const h = input.handlers;
    switch (event.kind) {
      case 'thought':
      case 'output':
        h.onChunk?.({ kind: event.kind, delta: event.text });
        return;
      case 'question': {
        if (!h.onQuestion) {
          this.logger.warn(`pergunta ignorada (sem onQuestion): ${event.prompt}`);
          return;
        }
        idle.suspendIdle();
        try {
          const answer = await h.onQuestion({
            id: event.id,
            prompt: event.prompt,
            options: event.options,
          });
          if (child.stdin.writable) {
            child.stdin.write(answer.endsWith('\n') ? answer : `${answer}\n`);
          }
        } finally {
          idle.resumeIdle();
        }
        return;
      }
      case 'proposal':
        await h.onProposal?.(event.proposal);
        return;
      case 'patch':
        await h.onPatch?.(event.patch);
        return;
    }
  }

  /**
   * Parseia uma linha de stdout em um `BacklogCliEvent`. Linhas não-JSON ou sem
   * `kind` reconhecido viram `thought` (fallback tolerante). O wrapper
   * (`docker/copilot-cli-adapter.mjs`) emite `{kind:"proposal"|"patch", ...}`.
   */
  parseLine(line: string): BacklogCliEvent | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { kind: 'thought', text: trimmed };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { kind: 'thought', text: trimmed };
    }

    const obj = parsed as Record<string, unknown>;
    const kind = obj.kind;

    // O adapter (compartilhado com o loop-engine) emite um evento `result` ao
    // final de todo turno — inclusive JUNTO com um `question` (HITL). O domínio
    // de backlog NÃO consome `result` (usa proposal/patch/question); ignorá-lo
    // evita que seu JSON cru vaze como uma mensagem `thought` no transcript
    // (bug: aparecia `{"kind":"result",...}` cru no chat e o fluxo "travava").
    if (kind === 'result') return null;

    if (kind === 'output') return { kind: 'output', text: str(obj.text) };
    if (kind === 'question') {
      return {
        kind: 'question',
        id: str(obj.id) || `q-${Date.now()}`,
        prompt: str(obj.prompt),
        options: Array.isArray(obj.options)
          ? obj.options.map((o) => String(o))
          : undefined,
      };
    }
    if (kind === 'proposal' && isObj(obj.proposal)) {
      return { kind: 'proposal', proposal: obj.proposal as unknown as BacklogProposal };
    }
    if (kind === 'patch' && isObj(obj.patch)) {
      return { kind: 'patch', patch: obj.patch as unknown as BacklogProposalPatch };
    }
    return { kind: 'thought', text: str(obj.text) || trimmed };
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
