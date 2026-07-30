import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StopMode } from '@kanban-ai/shared';
import type { ExecState, AffectedFlow } from '@kanban-ai/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/db/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { WorkspaceService } from './workspaces/workspace.service';
import { AGENT_RUNNER, type AgentRunner } from './runners/agent-runner.interface';
import { ValidationRunner } from './validators/validation.runner';
import { resolveLoopProfile } from './loop-profiles/loop-profiles';
import { mapIteration, type PrismaIterationRow } from '../cards/iteration.mapper';
import {
  dodAllDone,
  execStateAfterPhase,
  fromPrismaExecState,
  nextPhaseFor,
  pendingDeps,
  pickNextTask,
  storyHasPendingTasks,
  toPrismaExecState,
  type LoopTask,
} from './loop-helpers';

/**
 * Núcleo do loop engine. Orquestra o ciclo de vida das sessões de agent e o
 * loop de iterações de cada task, portando a lógica do artifact de referência
 * (docs/reference/kanban.html, linhas ~993–1101) para o backend: persiste
 * `Iteration` no Postgres (em transação) e emite eventos WS tipados.
 *
 * Runner ativo é escolhido por config (mock nesta fatia). Validação sempre passa
 * no mock; `createDerivedTask` está implementado mas só é exercitado pela AI real.
 */
@Injectable()
export class Orchestrator implements OnModuleInit {
  private readonly logger = new Logger(Orchestrator.name);
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();
  private readonly autoTimers = new Map<string, NodeJS.Timeout>();
  private readonly stopRequested = new Map<string, StopMode>();
  // Guarda contra iterações concorrentes na MESMA story: enquanto uma iteração
  // está em execução (inclusive parada em awaiting-input à espera de HITL), o
  // auto-play não deve iniciar outra — senão a pergunta pendente seria
  // substituída. Ver ADR-0018.
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AgentSessionManager,
    private readonly validation: ValidationRunner,
    private readonly workspaces: WorkspaceService,
    private readonly realtime: RealtimeService,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Salvaguarda #1: reconciliação no boot. */
  async onModuleInit(): Promise<void> {
    await this.reconcileOnBoot();
  }

  /**
   * Ao subir, varre stories em coluna "In Progress" no Postgres e recria o
   * auto-play. O estado de verdade é o banco, não a memória.
   */
  async reconcileOnBoot(): Promise<void> {
    const stories = await this.prisma.card.findMany({
      where: {
        type: 'story',
        boardColumn: { is: { title: { equals: 'In Progress', mode: 'insensitive' } } },
      },
      select: { id: true },
    });
    if (stories.length === 0) {
      this.logger.log('reconcileOnBoot() — nenhuma story ativa');
      return;
    }
    for (const story of stories) {
      this.logger.log(`reconcileOnBoot() — retomando loop da story=${story.id}`);
      await this.onStoryEnterInProgress(story.id);
    }
  }

  /** Disparado quando uma story entra em "In Progress" — acorda o motor. */
  async onStoryEnterInProgress(storyId: string): Promise<void> {
    if (this.sessions.get(storyId)) return; // idempotência: sessão já ativa
    if (!this.sessions.canStart()) {
      // Salvaguarda #2: limite de concorrência.
      this.logger.warn(`Limite de sessões atingido; story=${storyId} aguardando slot`);
      return;
    }

    const session = this.sessions.start(storyId);
    this.realtime.broadcast({
      type: 'agent.session.state_changed',
      storyId,
      sessionId: session.sessionId,
      state: session.state,
    });

    this.startWatchdog(storyId);
    await this.log(storyId, 'história em In Progress — motor de AI acordado');
    this.startAuto(storyId);
  }

  // ── Loop core ───────────────────────────────────────────────────────────────

  /**
   * Roda UMA iteração de uma task (núcleo do loop) — artifact `runIteration`
   * (linhas ~993–1051). Persiste a `Iteration` em transação, atualiza execState
   * e DOD, e emite os eventos WS. Retorna true se rodou algo.
   */
  async runIteration(taskId: string): Promise<boolean> {
    const task = await this.loadTask(taskId);
    if (!task || task.execState === 'done') return false;

    const byId = await this.loadSiblingsById(taskId);
    if (pendingDeps(task, byId).length > 0) {
      await this.setExecState(taskId, 'blocked-dep');
      return false;
    }

    const raw = await this.prisma.card.findUnique({
      where: { id: taskId },
      select: { title: true, loopType: true, assignees: { select: { assigneeId: true } } },
    });
    const profile = resolveLoopProfile(raw?.loopType);
    const phase = nextPhaseFor(task, profile);
    const agentId = raw?.assignees[0]?.assigneeId ?? null;
    const context = await this.buildContext(taskId, raw?.title ?? '(task)');
    const storyId = context.storyId ?? taskId;

    // b6: contexto do runner (sem os campos internos storyId/affectedFlows).
    const { storyId: _s, affectedFlows: _af, ...runnerContext } = context;

    // b6: worktree real como diretório de trabalho isolado.
    let cwd = '';
    try {
      cwd = await this.workspaces.ensureWorktree(storyId);
    } catch (err) {
      this.logger.warn(
        `Falha ao preparar worktree para story=${storyId}: ${(err as Error).message}`,
      );
    }

    // b6: sinal de cancelamento cooperativo (stop hard) vindo da sessão.
    const signal = this.sessions.get(storyId)?.abort.signal;

    const runResult = await this.runner.run({
      cwd,
      model: this.config.agent.defaultModel,
      phase,
      prompt: this.buildPrompt(phase, context),
      context: runnerContext,
      signal,
      // b6: repassa cada chunk de streaming para o WS (buffer reativo no front).
      onChunk: (chunk) =>
        this.realtime.broadcast({
          type: 'agent.chunk',
          taskId,
          storyId,
          kind: chunk.kind,
          delta: chunk.delta,
        }),
      // b6: HITL — emite agent.question, entra em awaiting-input e aguarda resposta.
      onQuestion: async (question) => {
        const questionId = question.id || randomUUID();
        this.realtime.broadcast({
          type: 'agent.question',
          taskId,
          storyId,
          questionId,
          prompt: question.prompt,
          options: question.options,
        });
        await this.log(taskId, `AI pausou e perguntou (HITL): ${question.prompt}`);
        try {
          const answer = await this.sessions.waitForAnswer(storyId, {
            taskId,
            questionId,
            prompt: question.prompt,
            options: question.options,
          });
          this.realtime.broadcast({ type: 'agent.answered', taskId, questionId });
          await this.log(taskId, `resposta HITL recebida — retomando iteração`);
          return answer;
        } catch (err) {
          this.realtime.broadcast({ type: 'agent.answered', taskId, questionId });
          throw err;
        }
      },
    });

    if (phase === 'validation') {
      await this.setExecState(taskId, 'validating');
      const outcome = await this.validation.validate({
        storyId,
        strategy: profile.validation,
        affectedFlows: context.affectedFlows,
      });

      await this.appendIteration(taskId, {
        phase,
        agentId,
        detail: runResult.detail,
        summary: runResult.summary,
        dodTouched: [],
        handoff: {
          state: outcome.passed ? 'done' : 'blocked',
          nextStep: outcome.passed ? '' : 'Corrigir o problema encontrado (ver task derivada).',
          files: context.files,
          dodIds: [],
        },
      });

      if (outcome.passed) {
        await this.setExecState(taskId, 'done');
        await this.log(taskId, 'validação final concluída — task Done');
        await this.onTaskDone(taskId);
      } else {
        // Só ocorre com validação real; no mock nunca acontece.
        const problem = outcome.problems[0] ?? {
          title: 'falha na validação',
          description: `A validação de ${taskId} detectou comportamento incorreto.`,
        };
        await this.createDerivedTask(taskId, problem);
      }
      return true;
    }

    // Iteração normal (reproduce / analysis / implementation).
    let touched: string[] = [];
    if (phase === 'implementation') {
      const pend = await this.prisma.dodItem.findFirst({
        where: { cardId: taskId, done: false },
        orderBy: { position: 'asc' },
      });
      if (pend) {
        await this.prisma.dodItem.update({ where: { id: pend.id }, data: { done: true } });
        this.realtime.broadcast({ type: 'dod.checked', cardId: taskId, itemId: pend.id, done: true });
        touched = [pend.id];
      }
    }

    const handoffState = runResult.done ? 'done' : execStateAfterPhase(phase);
    await this.appendIteration(taskId, {
      phase,
      agentId,
      detail: runResult.detail,
      summary: runResult.summary,
      dodTouched: touched,
      handoff: {
        state: handoffState,
        nextStep: runResult.nextStep,
        files: context.files,
        dodIds: [],
      },
    });
    await this.setExecState(taskId, execStateAfterPhase(phase));
    return true;
  }

  /**
   * Quando uma task fecha: remove a dependência resolvida das origens e as
   * re-valida se estavam em `blocked-dep` — artifact `onTaskDone` (1053–1067).
   */
  private async onTaskDone(taskId: string): Promise<void> {
    const origins = await this.prisma.taskDependency.findMany({
      where: { dependsOnId: taskId },
      select: { dependentId: true },
    });
    for (const { dependentId } of origins) {
      await this.prisma.taskDependency.deleteMany({
        where: { dependentId, dependsOnId: taskId },
      });
      const origin = await this.loadTask(dependentId);
      if (!origin) continue;
      const byId = await this.loadSiblingsById(dependentId);
      if (pendingDeps(origin, byId).length === 0 && origin.execState === 'blocked-dep') {
        await this.log(dependentId, `dependência ${taskId} resolvida → re-validando`);
        await this.setExecState(dependentId, 'validating');
      }
    }
  }

  /**
   * Cria uma task-bug derivada de uma falha de validação e liga a origem por
   * dependência REVERSA — artifact `createDerivedTask` (925–946). Em transação.
   * Implementado para a AI real; no mock a validação sempre passa.
   */
  async createDerivedTask(
    originId: string,
    problem: { title: string; description: string },
  ): Promise<string> {
    const origin = await this.prisma.card.findUnique({
      where: { id: originId },
      include: { assignees: true },
    });
    if (!origin) throw new Error('origem inexistente');

    const derivedId = await this.prisma.$transaction(async (tx) => {
      const board = await tx.board.findUnique({ where: { id: origin.boardId } });
      if (!board) throw new Error('board inexistente');
      const seq = board.seq + 1;
      await tx.board.update({ where: { id: board.id }, data: { seq } });

      const firstTaskCol = await tx.column.findFirst({
        where: { boardId: origin.boardId, isTaskColumn: true },
        orderBy: { position: 'asc' },
      });
      const bugLabel = await tx.label.findFirst({
        where: { boardId: origin.boardId, name: { equals: 'bug', mode: 'insensitive' } },
      });

      const derived = await tx.card.create({
        data: {
          boardId: origin.boardId,
          type: 'task',
          key: `TK-${seq}`,
          title: `Corrigir: ${problem.title}`,
          description: problem.description,
          parentId: origin.parentId,
          taskColumnId: firstTaskCol?.id ?? null,
          loopType: 'bug',
          execState: 'idle',
          derivedFromId: originId,
          position: 0,
          dodItems: {
            create: [
              { text: 'Problema reproduzido', position: 0 },
              { text: 'Correção aplicada', position: 1 },
              { text: 'Validação passou', position: 2 },
            ],
          },
          ...(bugLabel ? { labels: { create: [{ labelId: bugLabel.id }] } } : {}),
          ...(origin.assignees.length
            ? { assignees: { create: origin.assignees.map((a) => ({ assigneeId: a.assigneeId })) } }
            : {}),
          activities: { create: [{ text: `derivada da validação de ${origin.key}` }] },
        },
      });

      // Dependência reversa: a ORIGEM passa a depender da derivada.
      await tx.taskDependency.create({
        data: { dependentId: originId, dependsOnId: derived.id },
      });
      await tx.card.update({ where: { id: originId }, data: { execState: 'blocked_dep' } });
      return derived.id;
    });

    await this.log(originId, `bug encontrado na validação → criada task derivada; aguardando correção`);
    this.realtime.broadcast({ type: 'task.state.changed', taskId: originId, execState: 'blocked-dep' });
    this.realtime.broadcast({ type: 'task.derived', originTaskId: originId, derivedTaskId: derivedId });
    return derivedId;
  }

  // ── Serial por story ──────────────────────────────────────────────────────

  /**
   * Avança 1 passo da story: prioriza uma origem em re-validação, senão pega a
   * próxima task pronta (serial) — artifact `stepStory` (1069–1078).
   */
  async stepStory(storyId: string): Promise<boolean> {
    // Não sobrepor iterações na mesma story: se já há uma em execução (inclusive
    // parada em awaiting-input aguardando HITL), pular este passo. Evita
    // substituir a pergunta pendente. Ver ADR-0018.
    if (this.inFlight.has(storyId)) return false;
    this.inFlight.add(storyId);
    try {
      return await this.stepStoryInner(storyId);
    } finally {
      this.inFlight.delete(storyId);
    }
  }

  private async stepStoryInner(storyId: string): Promise<boolean> {
    const tasks = await this.loadStoryTasks(storyId);
    if (tasks.length === 0) return false;
    const byId = new Map(tasks.map((t) => [t.id, t]));

    const revalidating = tasks.find(
      (t) =>
        t.execState === 'validating' &&
        pendingDeps(t, byId).length === 0 &&
        dodAllDone(t) &&
        t.phases.includes('validation'),
    );
    if (revalidating) {
      await this.runIteration(revalidating.id);
      return true;
    }

    const next = pickNextTask(tasks, byId);
    if (next) {
      await this.runIteration(next.id);
      return true;
    }
    return false;
  }

  // ── Auto-play ───────────────────────────────────────────────────────────────

  /**
   * Inicia o auto-play de uma story: um `setInterval` (cadência configurável)
   * que chama `stepStory` até esgotar as tasks pendentes — artifact
   * `startAuto`/`stopAuto` (1082–1091), agora server-side.
   */
  startAuto(storyId: string): void {
    if (this.autoTimers.has(storyId)) return; // idempotência
    this.stopRequested.delete(storyId);
    this.realtime.broadcast({ type: 'auto.started', storyId });

    const tick = async () => {
      if (this.stopRequested.get(storyId) === 'graceful') {
        this.finishAuto(storyId, 'graceful');
        return;
      }
      try {
        const did = await this.stepStory(storyId);
        const tasks = await this.loadStoryTasks(storyId);
        if (!did && !storyHasPendingTasks(tasks)) {
          this.finishAuto(storyId, 'graceful');
        }
      } catch (err) {
        this.logger.error(`auto-play tick falhou (story=${storyId}): ${String(err)}`);
      }
    };

    const handle = setInterval(() => void tick(), this.config.agent.autoStepIntervalMs);
    this.autoTimers.set(storyId, handle);
    void tick(); // primeiro passo imediato
  }

  /** Passo manual único (botão "Rodar 1 iteração"). */
  async stepOnce(storyId: string): Promise<boolean> {
    if (!this.sessions.get(storyId)) {
      await this.onStoryEnterInProgress(storyId);
      return true;
    }
    return this.stepStory(storyId);
  }

  private finishAuto(storyId: string, mode: StopMode): void {
    const handle = this.autoTimers.get(storyId);
    if (handle) {
      clearInterval(handle);
      this.autoTimers.delete(storyId);
    }
    this.stopRequested.delete(storyId);
    this.realtime.broadcast({ type: 'auto.stopped', storyId, mode });
    // b6: story concluída/parada — limpa o worktree isolado.
    void this.workspaces.cleanupWorktree(storyId).catch(() => undefined);
  }

  isAutoRunning(storyId: string): boolean {
    return this.autoTimers.has(storyId);
  }

  // ── Watchdog & stop ─────────────────────────────────────────────────────────

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
    // Salvaguarda #3: só age em sessões mortas; nunca duplica iteração running.
    if (session.state === 'dead') {
      this.logger.warn(`Watchdog: sessão morta para story=${storyId} — limpando`);
      this.sessions.remove(storyId);
      this.clearWatchdog(storyId);
      void this.workspaces.cleanupWorktree(storyId).catch(() => undefined);
    }
  }

  /** Para o loop de uma story (graceful: termina o passo atual; hard: aborta). */
  async stop(storyId: string, mode: StopMode): Promise<void> {
    this.stopRequested.set(storyId, mode);
    if (mode === 'hard') {
      this.sessions.abort(storyId); // salvaguarda #4: AbortSignal
      this.finishAuto(storyId, 'hard');
      this.clearWatchdog(storyId);
      this.sessions.remove(storyId);
      void this.workspaces.cleanupWorktree(storyId).catch(() => undefined);
    }
    // graceful: o próximo tick do auto-play detecta e encerra.
  }

  private clearWatchdog(storyId: string): void {
    const handle = this.watchdogs.get(storyId);
    if (handle) {
      clearInterval(handle);
      this.watchdogs.delete(storyId);
    }
  }

  /** Estado do loop de uma story, para o endpoint GET. */
  loopState(storyId: string): { isAutoRunning: boolean; session: string | null } {
    const session = this.sessions.get(storyId);
    return { isAutoRunning: this.isAutoRunning(storyId), session: session?.state ?? null };
  }

  /**
   * HITL: entrega a resposta do humano à pergunta pendente da story, retomando
   * a iteração pausada (a resposta é escrita no stdin do subprocesso pelo
   * runner via a Promise de `onQuestion`). Retorna false se não havia pergunta.
   */
  answerQuestion(storyId: string, questionId: string, answer: string): boolean {
    return this.sessions.resolveQuestion(storyId, questionId, answer);
  }

  // ── Mutações persistidas + emissão ────────────────────────────────────────

  private async setExecState(taskId: string, state: ExecState): Promise<void> {
    const current = await this.prisma.card.findUnique({
      where: { id: taskId },
      select: { execState: true },
    });
    if (fromPrismaExecState(current?.execState) === state) return;
    await this.prisma.card.update({
      where: { id: taskId },
      data: { execState: toPrismaExecState(state) },
    });
    this.realtime.broadcast({ type: 'task.state.changed', taskId, execState: state });
  }

  private async appendIteration(
    taskId: string,
    it: {
      phase: LoopTask['phases'][number];
      agentId: string | null;
      detail: string;
      summary: string;
      dodTouched: string[];
      handoff: { state: string; nextStep: string; files: string[]; dodIds: string[] };
    },
  ): Promise<void> {
    const row = await this.prisma.$transaction(async (tx) => {
      const count = await tx.iteration.count({ where: { cardId: taskId } });
      return tx.iteration.create({
        data: {
          cardId: taskId,
          index: count + 1,
          agentId: it.agentId,
          phase: it.phase,
          detail: it.detail,
          summary: it.summary,
          dodTouched: it.dodTouched,
          handoffState: it.handoff.state,
          handoffNextStep: it.handoff.nextStep,
          handoffFiles: it.handoff.files,
          handoffDodIds: it.handoff.dodIds,
        },
      });
    });
    await this.log(taskId, `iteração #${row.index} (${it.phase})`);
    this.realtime.broadcast({
      type: 'iteration.appended',
      taskId,
      iteration: mapIteration(row as PrismaIterationRow),
    });
  }

  private async log(cardId: string, text: string): Promise<void> {
    await this.prisma.activity.create({ data: { cardId, text } });
  }

  // ── Loaders ─────────────────────────────────────────────────────────────────

  private async loadTask(taskId: string): Promise<LoopTask | null> {
    const card = await this.prisma.card.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        type: true,
        execState: true,
        createdAt: true,
        dependsOn: { select: { dependsOnId: true } },
        iterations: { select: { phase: true } },
        dodItems: { select: { done: true } },
      },
    });
    if (!card) return null;
    return this.toLoopTask(card);
  }

  private async loadStoryTasks(storyId: string): Promise<LoopTask[]> {
    const cards = await this.prisma.card.findMany({
      where: { parentId: storyId, type: 'task' },
      select: {
        id: true,
        type: true,
        execState: true,
        createdAt: true,
        dependsOn: { select: { dependsOnId: true } },
        iterations: { select: { phase: true } },
        dodItems: { select: { done: true } },
      },
    });
    return cards.map((c) => this.toLoopTask(c));
  }

  /** Carrega as tasks irmãs (mesma story) indexadas por id, para resolver deps. */
  private async loadSiblingsById(taskId: string): Promise<Map<string, LoopTask>> {
    const self = await this.prisma.card.findUnique({
      where: { id: taskId },
      select: { parentId: true },
    });
    if (!self?.parentId) return new Map();
    const tasks = await this.loadStoryTasks(self.parentId);
    return new Map(tasks.map((t) => [t.id, t]));
  }

  private toLoopTask(card: {
    id: string;
    type: string;
    execState: string | null;
    createdAt: Date;
    dependsOn: { dependsOnId: string }[];
    iterations: { phase: string }[];
    dodItems: { done: boolean }[];
  }): LoopTask {
    return {
      id: card.id,
      type: card.type,
      execState: fromPrismaExecState(card.execState),
      createdAt: card.createdAt.getTime(),
      dependsOn: card.dependsOn.map((d) => d.dependsOnId),
      phases: card.iterations.map((i) => i.phase as LoopTask['phases'][number]),
      dodDone: card.dodItems.map((d) => d.done),
    };
  }

  /** Monta o contexto de domínio para o runner a partir da story pai. */
  private async buildContext(
    taskId: string,
    taskTitle: string,
  ): Promise<{
    taskTitle: string;
    project: string;
    notes: string;
    flowNames: string[];
    files: string[];
    storyId: string | null;
    affectedFlows: AffectedFlow[];
  }> {
    const task = await this.prisma.card.findUnique({
      where: { id: taskId },
      select: { parentId: true },
    });
    const story = task?.parentId
      ? await this.prisma.card.findUnique({
          where: { id: task.parentId },
          select: { aiProject: true, aiNotes: true, affectedFlows: true },
        })
      : null;
    const flows = (story?.affectedFlows ?? []) as AffectedFlow[];
    return {
      taskTitle,
      project: story?.aiProject ?? '',
      notes: story?.aiNotes ?? '',
      flowNames: flows.map((f) => f.name),
      files: flows.flatMap((f) => f.files),
      storyId: task?.parentId ?? null,
      affectedFlows: flows,
    };
  }

  /**
   * Constrói o prompt/handoff entregue ao runner a partir do contexto de
   * domínio e da fase. A CLI real recebe isto via stdin (ou arg); o mock ignora
   * e usa `context`. Mantido simples nesta fatia — o diário completo já é
   * persistido em `Iteration` e pode ser incorporado em evolução futura.
   */
  private buildPrompt(
    phase: LoopTask['phases'][number],
    context: Awaited<ReturnType<Orchestrator['buildContext']>>,
  ): string {
    const lines = [
      `# Fase: ${phase}`,
      `## Task: ${context.taskTitle}`,
    ];
    if (context.project) lines.push(`## Projeto: ${context.project}`);
    if (context.notes) lines.push(`## Notas: ${context.notes}`);
    if (context.flowNames.length > 0) {
      lines.push(`## Fluxos afetados: ${context.flowNames.join(', ')}`);
    }
    if (context.files.length > 0) {
      lines.push(`## Arquivos: ${context.files.join(', ')}`);
    }
    return lines.join('\n');
  }
}
