import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentSessionState } from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';

/** Pergunta pendente (HITL) numa sessão aguardando resposta do humano. */
export interface PendingQuestion {
  taskId: string;
  questionId: string;
  prompt: string;
  options?: string[];
  /** Resolve a Promise de `onQuestion` do runner com a resposta do humano. */
  resolve: (answer: string) => void;
  /** Rejeita (ex.: timeout HITL ou abort). */
  reject: (err: Error) => void;
  createdAt: number;
}

/** Estado interno de uma sessão de agent (por story). */
interface AgentSession {
  storyId: string;
  sessionId: string;
  state: AgentSessionState;
  abort: AbortController;
  createdAt: number;
  /** Pergunta pendente (HITL) — presente quando a sessão está em awaiting-input. */
  pending: PendingQuestion | null;
}

/**
 * Gerencia sessões de agent **in-process** (SEM Redis no v1).
 *
 * Fica atrás desta interface para poder ser trocado por **BullMQ + Redis** no
 * futuro sem mexer no orquestrador.
 *
 * Estados: running | idle | dead (ver AgentSessionState).
 *
 * ⚠️ Salvaguardas (parcialmente stubadas — ver docs/loop-engine.md):
 *  1. Reconciliation no boot (Orchestrator.reconcileOnBoot).
 *  2. Limite de concorrência (maxConcurrentSessions).
 *  3. Idempotência do watchdog (só age em dead/idle-travado).
 *  4. Encerramento limpo via AbortSignal.
 */
@Injectable()
export class AgentSessionManager {
  private readonly logger = new Logger(AgentSessionManager.name);
  private readonly sessions = new Map<string, AgentSession>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Salvaguarda #2: respeita o limite de sessões concorrentes. */
  canStart(): boolean {
    const active = [...this.sessions.values()].filter((s) => s.state === 'running').length;
    return active < this.config.agent.maxConcurrentSessions;
  }

  start(storyId: string): AgentSession {
    const existing = this.sessions.get(storyId);
    if (existing) return existing;

    const session: AgentSession = {
      storyId,
      sessionId: `sess-${storyId}-${Date.now()}`,
      state: 'idle',
      abort: new AbortController(),
      createdAt: Date.now(),
      pending: null,
    };
    this.sessions.set(storyId, session);
    this.logger.log(`Sessão criada para story=${storyId}`);
    return session;
  }

  get(storyId: string): AgentSession | undefined {
    return this.sessions.get(storyId);
  }

  setState(storyId: string, state: AgentSessionState): void {
    const s = this.sessions.get(storyId);
    if (s) s.state = state;
  }

  /** Salvaguarda #4: aborta a iteração em curso (stop hard). */
  abort(storyId: string): void {
    const s = this.sessions.get(storyId);
    if (s) {
      if (s.pending) {
        s.pending.reject(new Error('aborted'));
        s.pending = null;
      }
      s.abort.abort();
      s.state = 'dead';
      this.logger.warn(`Sessão abortada (hard) story=${storyId}`);
    }
  }

  /**
   * Registra uma pergunta pendente (HITL) e retorna uma Promise que resolve com
   * a resposta do humano (via `resolveQuestion`). A sessão fica em espera até
   * ser respondida, abortada ou expirar (hitlTimeoutMs).
   */
  waitForAnswer(
    storyId: string,
    question: { taskId: string; questionId: string; prompt: string; options?: string[] },
  ): Promise<string> {
    const session = this.sessions.get(storyId);
    if (!session) {
      return Promise.reject(new Error(`sessão inexistente para story=${storyId}`));
    }
    if (session.pending) {
      session.pending.reject(new Error('substituída por nova pergunta'));
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (session.pending?.questionId === question.questionId) {
          session.pending = null;
        }
        reject(new Error(`HITL timeout (${this.config.agent.hitlTimeoutMs}ms)`));
      }, this.config.agent.hitlTimeoutMs);

      session.pending = {
        ...question,
        createdAt: Date.now(),
        resolve: (answer) => {
          clearTimeout(timeout);
          resolve(answer);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      };
      this.logger.log(
        `Pergunta pendente (HITL) story=${storyId} task=${question.taskId} q=${question.questionId}`,
      );
    });
  }

  /** Resolve a pergunta pendente com a resposta do humano (endpoint HITL). */
  resolveQuestion(storyId: string, questionId: string, answer: string): boolean {
    const s = this.sessions.get(storyId);
    if (!s?.pending || s.pending.questionId !== questionId) return false;
    const { resolve } = s.pending;
    s.pending = null;
    resolve(answer);
    this.logger.log(`Pergunta respondida story=${storyId} q=${questionId}`);
    return true;
  }

  /** Retorna a pergunta pendente da sessão, se houver. */
  getPending(storyId: string): PendingQuestion | null {
    return this.sessions.get(storyId)?.pending ?? null;
  }

  /** Localiza a story cuja pergunta pendente corresponde a um questionId. */
  findPendingByQuestion(
    questionId: string,
  ): { storyId: string; pending: PendingQuestion } | null {
    for (const s of this.sessions.values()) {
      if (s.pending?.questionId === questionId) {
        return { storyId: s.storyId, pending: s.pending };
      }
    }
    return null;
  }

  remove(storyId: string): void {
    this.sessions.delete(storyId);
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.state === 'running').length;
  }
}
