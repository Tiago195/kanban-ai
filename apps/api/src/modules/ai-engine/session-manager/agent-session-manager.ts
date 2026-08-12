import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentSessionState, LivenessState } from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';
import { PrismaService } from '../../../shared/db/prisma.service';

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
  /** US-ROB2: totais de tokens acumulados na sessão (cache do valor persistido). */
  tokenTotals?: { input: number; output: number };
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

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * US-ROB2 — persistência durável (best-effort) do estado de runtime. O Map
   * segue como cache quente e fonte de verdade em memória; a tabela
   * `AgentRuntimeState` é só durabilidade (sobrevive a restart). Guardado por
   * `runtimePersistEnabled` (default ON) e SEMPRE defensivo: uma falha de DB
   * NUNCA pode derrubar o loop — apenas registra um warning.
   */
  private async persistState(
    storyId: string,
    patch: {
      livenessState?: LivenessState;
      lastError?: string | null;
      tokenTotals?: { input: number; output: number };
    },
  ): Promise<void> {
    if (!this.config.agent.runtimePersistEnabled) return;
    try {
      const data: Record<string, unknown> = {};
      if (patch.livenessState !== undefined) data.livenessState = patch.livenessState;
      if (patch.lastError !== undefined) data.lastError = patch.lastError;
      if (patch.tokenTotals !== undefined) {
        data.tokenTotals = JSON.stringify(patch.tokenTotals);
      }
      await this.prisma.agentRuntimeState.upsert({
        where: { sessionId: storyId },
        create: {
          sessionId: storyId,
          storyId,
          livenessState: patch.livenessState ?? LivenessState.Starting,
          lastError: patch.lastError ?? null,
          ...(patch.tokenTotals
            ? { tokenTotals: JSON.stringify(patch.tokenTotals) }
            : {}),
        },
        update: data,
      });
    } catch (err) {
      this.logger.warn(
        `persistState falhou (story=${storyId}) — loop segue: ${(err as Error).message}`,
      );
    }
  }

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
      // US-ROB2: sessionId estável (== storyId). Sobrevive a restart e alinha
      // com a granularidade real de concorrência (por-story, invariante 7).
      // Não usar Date.now() — isso quebrava a correlação após reinício.
      sessionId: storyId,
      state: 'idle',
      abort: new AbortController(),
      createdAt: Date.now(),
      pending: null,
    };
    this.sessions.set(storyId, session);
    this.logger.log(`Sessão criada para story=${storyId}`);
    // Persistência durável best-effort (não bloqueia o start).
    void this.persistState(storyId, { livenessState: LivenessState.Starting });
    return session;
  }

  get(storyId: string): AgentSession | undefined {
    return this.sessions.get(storyId);
  }

  setState(storyId: string, state: AgentSessionState): void {
    const s = this.sessions.get(storyId);
    if (s) {
      s.state = state;
      // Espelha o estado efêmero no liveness persistido: running→alive,
      // idle→starting (aguardando), dead→dead.
      const liveness =
        state === 'running'
          ? LivenessState.Alive
          : state === 'dead'
            ? LivenessState.Dead
            : LivenessState.Starting;
      void this.persistState(storyId, { livenessState: liveness });
    }
  }

  /**
   * US-ROB2 — acumula os totais de tokens da sessão na linha durável. Chamado
   * pelo orquestrador ao fim de cada iteração com os tokens reportados pelo
   * runner. Idempotente por natureza (soma no cache e reescreve o total).
   */
  async addTokens(storyId: string, delta: { input: number; output: number }): Promise<void> {
    const s = this.sessions.get(storyId);
    if (!s) return;
    s.tokenTotals = {
      input: (s.tokenTotals?.input ?? 0) + (delta.input || 0),
      output: (s.tokenTotals?.output ?? 0) + (delta.output || 0),
    };
    await this.persistState(storyId, { tokenTotals: s.tokenTotals });
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
      void this.persistState(storyId, {
        livenessState: LivenessState.Dead,
        lastError: 'aborted',
      });
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
    // Marca a linha durável como encerrada (não deletamos — histórico/auditoria
    // e base para reconciliação no boot).
    void this.persistState(storyId, { livenessState: LivenessState.Dead });
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.state === 'running').length;
  }

  /**
   * Ids de todas as stories com sessão ativa (qualquer estado exceto dead).
   * Usado pela SERIALIZAÇÃO do orchestrator para detectar duas stories rodando
   * sobre o mesmo repo-alvo (aiProject).
   */
  activeStoryIds(): string[] {
    return [...this.sessions.values()]
      .filter((s) => s.state !== 'dead')
      .map((s) => s.storyId);
  }
}
