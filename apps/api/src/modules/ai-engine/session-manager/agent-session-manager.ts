import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentSessionState } from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';

/** Estado interno de uma sessão de agent (por story). */
interface AgentSession {
  storyId: string;
  sessionId: string;
  state: AgentSessionState;
  abort: AbortController;
  createdAt: number;
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
      s.abort.abort();
      s.state = 'dead';
      this.logger.warn(`Sessão abortada (hard) story=${storyId}`);
    }
  }

  remove(storyId: string): void {
    this.sessions.delete(storyId);
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.state === 'running').length;
  }
}
