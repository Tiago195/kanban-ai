import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StopMode } from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { AGENT_RUNNER, type AgentRunner } from './runners/agent-runner.interface';
import { WorkspaceService } from '../../workspaces/workspace.service';
import { ValidationRunner } from './validators/validation.runner';
import { resolveLoopProfile } from './loop-profiles/loop-profiles';

/**
 * Núcleo do loop engine. Orquestra o ciclo de vida das sessões de agent.
 *
 * Fluxo (ver docs/loop-engine.md):
 *  - Story → In Progress dispara `onStoryEnterInProgress`, que "acorda" um agent
 *    e encadeia iterações.
 *  - Um watchdog (setInterval de watchdogIntervalMs) verifica sessões vivas e
 *    "cutuca" as travadas — respeitando idempotência (salvaguarda #3).
 *  - Stop tem dois modos: graceful (não inicia a próxima) e hard (AbortSignal).
 *
 * ⚠️ Em grande parte STUB — a execução real de iterações está pendente.
 */
@Injectable()
export class Orchestrator implements OnModuleInit {
  private readonly logger = new Logger(Orchestrator.name);
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();
  private readonly stopRequested = new Map<string, StopMode>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AgentSessionManager,
    private readonly workspaces: WorkspaceService,
    private readonly validation: ValidationRunner,
    private readonly realtime: RealtimeService,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Salvaguarda #1: reconciliação no boot. */
  async onModuleInit(): Promise<void> {
    await this.reconcileOnBoot();
  }

  /**
   * Ao subir, varre stories em In Progress no Postgres e recria os watchdogs.
   * O estado de verdade é o banco, não a memória.
   */
  async reconcileOnBoot(): Promise<void> {
    // TODO: buscar stories em coluna "In Progress" no Postgres e recriar watchdogs/sessões.
    // Estado de verdade = banco (this.prisma), não memória.
    void this.prisma;
    void this.runner;
    void this.workspaces;
    void this.validation;
    this.logger.log('reconcileOnBoot() — nenhuma story ativa (stub)');
  }

  /** Disparado quando uma story entra em "In Progress". */
  async onStoryEnterInProgress(storyId: string): Promise<void> {
    if (!this.sessions.canStart()) {
      // Salvaguarda #2: limite de concorrência — aguardar slot.
      this.logger.warn(`Limite de sessões atingido; story=${storyId} aguardando slot`);
      return;
    }

    const session = this.sessions.start(storyId);
    this.realtime.broadcast({ type: 'auto.started', storyId });
    this.realtime.broadcast({
      type: 'agent.session.state_changed',
      storyId,
      sessionId: session.sessionId,
      state: session.state,
    });

    this.startWatchdog(storyId);
    // TODO: encadear a primeira iteração (runIteration) usando o loop profile.
    void resolveLoopProfile; // referência ao helper (stub)
  }

  /** Cria o watchdog periódico da story (morre em Review/Done ou stop manual). */
  private startWatchdog(storyId: string): void {
    if (this.watchdogs.has(storyId)) return; // idempotência (salvaguarda #3)
    const handle = setInterval(() => {
      void this.tickWatchdog(storyId);
    }, this.config.agent.watchdogIntervalMs);
    this.watchdogs.set(storyId, handle);
  }

  private async tickWatchdog(storyId: string): Promise<void> {
    const session = this.sessions.get(storyId);
    if (!session) return;
    // Salvaguarda #3: só cutuca sessões dead/idle-travadas, nunca duplica iteração running.
    if (session.state === 'dead') {
      this.logger.warn(`Watchdog: sessão morta para story=${storyId} — TODO retomar`);
      // TODO: enviar mensagem para a MESMA sessão retomar o fluxo.
    }
  }

  /** Para o loop de uma story. */
  async stop(storyId: string, mode: StopMode): Promise<void> {
    this.stopRequested.set(storyId, mode);
    if (mode === 'hard') {
      this.sessions.abort(storyId); // salvaguarda #4: AbortSignal
    }
    this.clearWatchdog(storyId);
    this.realtime.broadcast({ type: 'auto.stopped', storyId, mode });
    // TODO (graceful): esperar iteração atual e não iniciar a próxima.
  }

  private clearWatchdog(storyId: string): void {
    const handle = this.watchdogs.get(storyId);
    if (handle) {
      clearInterval(handle);
      this.watchdogs.delete(storyId);
    }
  }

  // TODO: runIteration(storyId) — construir prompt do diário, chamar runner.run(),
  //       persistir Iteration, emitir iteration.appended, marcar DOD, encadear próxima.
  // TODO: quando todos DOD marcados → validation.validate() → derivar task em falha.
}
