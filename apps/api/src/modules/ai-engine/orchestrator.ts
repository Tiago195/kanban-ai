import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StopMode } from '@kanban-ai/shared';
import type { ExecState, AffectedFlow } from '@kanban-ai/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/db/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { WorkspaceService, TargetProjectError } from './workspaces/workspace.service';
import { AGENT_RUNNER, type AgentRunner } from './runners/agent-runner.interface';
import { ValidationRunner } from './validators/validation.runner';
import { resolveLoopProfile, type LoopProfileDef } from './loop-profiles/loop-profiles';
import { mapIteration, type PrismaIterationRow } from '../cards/iteration.mapper';
import { deriveEpicStatus, type ColumnLike } from '../cards/cards.epic-status';
import {
  allTasksDone,
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
      select: {
        title: true,
        loopType: true,
        model: true,
        parentId: true,
        boardId: true,
        assignees: { select: { assigneeId: true } },
      },
    });
    const profile = resolveLoopProfile(raw?.loopType);
    const phase = nextPhaseFor(task, profile);
    const agentId = raw?.assignees[0]?.assigneeId ?? null;
    const context = await this.buildContext(taskId, raw?.title ?? '(task)');
    const storyId = context.storyId ?? taskId;

    // Modelo de AI resolvido em cascata: task → parents → board.defaultModel →
    // default global. Injetado no spawn via env COPILOT_MODEL pelo runner.
    const resolvedModel = await this.resolveCardModel(
      raw?.model ?? null,
      raw?.parentId ?? null,
      raw?.boardId ?? null,
    );

    // b6: contexto do runner (só os campos do AgentRunContext; os demais são
    // usados apenas para montar o prompt da CLI real).
    const runnerContext = {
      taskTitle: context.taskTitle,
      project: context.project,
      notes: context.notes,
      flowNames: context.flowNames,
      files: context.files,
    };

    // #8: worktree ISOLADO no repo-alvo (aiProject). Se o projeto-alvo não
    // estiver definido/for inválido, RECUSAMOS rodar — o agent nunca pode
    // trabalhar no repo do kanban-ai. A task fica em blocked-dep com log claro.
    let cwd = '';
    try {
      cwd = await this.workspaces.ensureWorktree(storyId, context.project);
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof TargetProjectError) {
        await this.log(
          taskId,
          `iteração recusada — projeto-alvo inválido/ausente: ${msg}. ` +
            'Defina o repositório-alvo (aiProject) da story para o agent poder trabalhar isolado.',
        );
        await this.setExecState(taskId, 'blocked-dep');
        return false;
      }
      // Qualquer outra falha ao preparar o worktree (ex.: erro do git) também
      // impede o agent de trabalhar isolado. NUNCA seguimos com cwd vazio — isso
      // rodaria o agent no diretório da API (apps/api) e causaria "Permission
      // denied" ao tocar no projeto-alvo. Recusamos e deixamos a task bloqueada.
      this.logger.warn(`Falha ao preparar worktree para story=${storyId}: ${msg}`);
      await this.log(
        taskId,
        `iteração recusada — falha ao preparar workspace isolado: ${msg}. ` +
          'O agent não pode rodar sem um worktree do repositório-alvo.',
      );
      await this.setExecState(taskId, 'blocked-dep');
      return false;
    }

    // b6: sinal de cancelamento cooperativo (stop hard) vindo da sessão.
    const signal = this.sessions.get(storyId)?.abort.signal;

    // #6: captura a última troca HITL (pergunta + resposta) desta iteração para
    // reinjetar no lastro da PRÓXIMA iteração (modelo one-shot: a CLI já
    // encerrou; a resposta humana vira contexto do próximo prompt).
    let hitlExchange: { prompt: string; answer: string } | null = null;

    const runResult = await this.runner.run({
      cwd,
      model: resolvedModel,
      phase,
      prompt: this.buildPrompt(phase, profile, context),
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
          hitlExchange = { prompt: question.prompt, answer };
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
    // É a AI (CLI) quem decide quais itens de DOD concluiu. Respeitamos
    // `runResult.dodTouched`, validando que os ids pertencem a ESTA task e ainda
    // não estavam marcados. O mock devolve [] aqui — nesse caso caímos no
    // fallback determinístico (marca o próximo item pendente) só na fase de
    // implementação, preservando o comportamento dev/test do mock.
    let touched: string[] = [];
    const reported = (runResult.dodTouched ?? []).filter(Boolean);
    if (reported.length > 0) {
      const validIds = new Set(context.dodItems.filter((d) => !d.done).map((d) => d.id));
      const toMark = reported.filter((id) => validIds.has(id));
      for (const id of toMark) {
        await this.prisma.dodItem.update({ where: { id }, data: { done: true } });
        this.realtime.broadcast({ type: 'dod.checked', cardId: taskId, itemId: id, done: true });
      }
      touched = toMark;
    } else if (this.runner.id === 'mock' && phase === 'implementation') {
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

    // A AI registra os fluxos afetados (ela sabe onde mexeu). Persistimos na
    // STORY pai (merge por nome) para alimentar a validação final.
    if (runResult.affectedFlows && runResult.affectedFlows.length > 0 && context.storyId) {
      await this.persistAffectedFlows(context.storyId, runResult.affectedFlows);
    }

    const handoffState = runResult.done ? 'done' : execStateAfterPhase(phase);
    // #6: se houve HITL nesta iteração, anexa a pergunta+resposta ao nextStep
    // para reinjeção no lastro da próxima iteração (modelo one-shot).
    const nextStep = hitlExchange
      ? [
          runResult.nextStep,
          `Decisão humana (HITL): pergunta "${(hitlExchange as { prompt: string }).prompt}" → resposta "${(hitlExchange as { answer: string }).answer}". Continue a partir dela.`,
        ]
          .filter(Boolean)
          .join(' ')
      : runResult.nextStep;
    await this.appendIteration(taskId, {
      phase,
      agentId,
      detail: runResult.detail,
      summary: runResult.summary,
      dodTouched: touched,
      handoff: {
        state: handoffState,
        nextStep,
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
          // #4/#5: auto-play esgotado com todas as tasks concluídas →
          // promove a story a Done e encadeia a próxima story do épico.
          if (tasks.length > 0 && allTasksDone(tasks)) {
            await this.promoteStory(storyId);
          }
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

  /**
   * #4: promove uma story para a coluna "Done" do board de stories quando todas
   * as suas tasks concluíram. Idempotente (não re-promove se já está em Done) e
   * NÃO reacorda o motor. Ao final, encadeia a próxima story do épico (#5).
   */
  private async promoteStory(storyId: string): Promise<void> {
    try {
      const story = await this.prisma.card.findUnique({
        where: { id: storyId },
        select: { id: true, type: true, boardId: true, boardColumnId: true, parentId: true },
      });
      if (!story || story.type !== 'story') return;

      const doneCol = await this.prisma.column.findFirst({
        where: { boardId: story.boardId, isTaskColumn: false, title: 'Done' },
        select: { id: true },
      });
      if (!doneCol) return;
      // Idempotência: só promove uma vez.
      if (story.boardColumnId === doneCol.id) return;

      const fromColumnId = story.boardColumnId;
      const position = await this.prisma.card.count({
        where: { boardColumnId: doneCol.id, NOT: { id: storyId } },
      });
      await this.prisma.card.update({
        where: { id: storyId },
        data: { boardColumnId: doneCol.id, position, everInProgress: true },
      });
      this.realtime.broadcast({
        type: 'card.moved',
        cardId: storyId,
        parentId: story.parentId ?? null,
        fromColumnId,
        toColumnId: doneCol.id,
        isTaskBoard: false,
      });
      await this.log(storyId, 'Story concluída — todas as tasks done. Promovida para Done.');

      // #10b: registrar resumo da story no épico pai (lastro cross-story).
      if (story.parentId) {
        await this.summarizeStoryToEpic(storyId, story.parentId);
        await this.emitEpicStatus(story.parentId);
        // #5: encadear a próxima story do épico (respeitando gate HITL).
        await this.advanceEpic(story.parentId, storyId);
      }
    } catch (err) {
      this.logger.warn(`Falha ao promover story ${storyId}: ${(err as Error).message}`);
    }
  }

  /**
   * #10b: ao concluir uma story, compila um resumo (título + tasks concluídas +
   * fluxos afetados + próximos passos das iterações) e cria um Comment no épico
   * pai. Isso forma o lastro cross-story que alimenta o prompt das próximas
   * sessões nano.
   */
  private async summarizeStoryToEpic(storyId: string, epicId: string): Promise<void> {
    try {
      const story = await this.prisma.card.findUnique({
        where: { id: storyId },
        select: {
          key: true,
          title: true,
          affectedFlows: { select: { name: true } },
          children: {
            where: { type: 'task' },
            select: {
              key: true,
              title: true,
              execState: true,
              iterations: {
                orderBy: { index: 'desc' },
                take: 1,
                select: { summary: true, handoffNextStep: true },
              },
            },
          },
        },
      });
      if (!story) return;

      const doneTasks = story.children.filter((t) => t.execState === 'done');
      const lines: string[] = [];
      lines.push(`✅ Story concluída: ${story.key} — ${story.title}`);
      if (doneTasks.length) {
        lines.push('');
        lines.push('Tasks concluídas:');
        for (const t of doneTasks) {
          const last = t.iterations[0];
          const detail = last?.summary?.trim() || last?.handoffNextStep?.trim() || '';
          lines.push(`- ${t.key} ${t.title}${detail ? ` — ${detail}` : ''}`);
        }
      }
      if (story.affectedFlows.length) {
        lines.push('');
        lines.push(`Fluxos afetados: ${story.affectedFlows.map((f) => f.name).join(', ')}`);
      }

      await this.prisma.comment.create({
        data: { cardId: epicId, authorId: 'ai', text: lines.join('\n') },
      });
      this.realtime.broadcast({ type: 'comment.created', cardId: epicId, parentId: null });
      await this.log(epicId, `Resumo da story ${story.key} registrado no épico.`);
    } catch (err) {
      this.logger.warn(
        `Falha ao resumir story ${storyId} no épico ${epicId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * #5: ao concluir uma story de um épico, move a próxima story não-concluída
   * para "In Progress" (o que dispara o loop via move → onStoryEnterInProgress).
   * Gate HITL: não encadeia se qualquer story do épico tem pergunta pendente ou
   * está aguardando input humano.
   */
  private async advanceEpic(epicId: string, finishedStoryId: string): Promise<void> {
    try {
      const stories = await this.prisma.card.findMany({
        where: { parentId: epicId, type: 'story' },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          boardId: true,
          boardColumnId: true,
          position: true,
          execState: true,
        },
      });
      if (stories.length === 0) return;

      // Gate HITL: nenhuma story pode estar aguardando input humano.
      for (const s of stories) {
        if (this.sessions.getPending(s.id)) {
          await this.log(
            epicId,
            'Encadeamento pausado — há uma story do épico aguardando resposta humana (HITL).',
          );
          return;
        }
      }

      const boardId = stories[0].boardId;
      const cols = await this.prisma.column.findMany({
        where: { boardId, isTaskColumn: false },
        select: { id: true, title: true },
      });
      const byId = new Map(cols.map((c) => [c.id, c.title.trim().toLowerCase()]));
      const inProgress = cols.find((c) => c.title.trim().toLowerCase() === 'in progress');
      if (!inProgress) return;

      // Próxima story ainda não em Done e não já em In Progress.
      const next = stories.find((s) => {
        if (s.id === finishedStoryId) return false;
        const title = s.boardColumnId ? byId.get(s.boardColumnId) : undefined;
        return title !== 'done' && title !== 'in progress';
      });
      if (!next) {
        await this.log(epicId, 'Épico sem próxima story pendente para encadear.');
        return;
      }

      const fromColumnId = next.boardColumnId;
      const position = await this.prisma.card.count({
        where: { boardColumnId: inProgress.id, NOT: { id: next.id } },
      });
      await this.prisma.card.update({
        where: { id: next.id },
        data: { boardColumnId: inProgress.id, position, everInProgress: true },
      });
      this.realtime.broadcast({
        type: 'card.moved',
        cardId: next.id,
        parentId: epicId,
        fromColumnId,
        toColumnId: inProgress.id,
        isTaskBoard: false,
      });
      this.realtime.broadcast({ type: 'story.entered_in_progress', storyId: next.id });
      await this.emitEpicStatus(epicId);
      await this.log(epicId, `Encadeando próxima story do épico: ${next.id}.`);
      // Dispara o loop da próxima story.
      await this.onStoryEnterInProgress(next.id);
    } catch (err) {
      this.logger.warn(`Falha ao encadear épico ${epicId}: ${(err as Error).message}`);
    }
  }

  /** Recomputa e emite o status derivado de um épico (espelha CardsService). */
  private async emitEpicStatus(epicId: string): Promise<void> {
    try {
      const epic = await this.prisma.card.findUnique({
        where: { id: epicId },
        select: { id: true, type: true, boardId: true },
      });
      if (!epic || epic.type !== 'epic') return;
      const [stories, columns] = await Promise.all([
        this.prisma.card.findMany({
          where: { parentId: epicId, type: 'story' },
          select: { everInProgress: true, boardColumnId: true },
        }),
        this.prisma.column.findMany({
          where: { boardId: epic.boardId },
          select: { id: true, title: true },
        }),
      ]);
      const columnsById = new Map<string, ColumnLike>(columns.map((c) => [c.id, c]));
      const derived = deriveEpicStatus(stories, columnsById);
      this.realtime.broadcast({
        type: 'epic.status.derived',
        epicId,
        status: derived.status,
        done: derived.done,
        total: derived.total,
      });
    } catch {
      /* não crítico */
    }
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
    // #1/#3: espelhar o execState na coluna do mini-kanban da task.
    await this.moveTaskToColumnFor(taskId, state);
  }

  /**
   * #1/#3: mantém a coluna do mini-kanban da task em espelho ao seu execState.
   * Mapa: analyzing|implementing|validating|blocked-dep → "In Progress";
   * done → "Done"; idle → "To Do". Atualiza `taskColumnId` e emite `card.moved`
   * para a UI reagir sem F5.
   */
  private async moveTaskToColumnFor(taskId: string, state: ExecState): Promise<void> {
    const targetTitle =
      state === 'done'
        ? 'Done'
        : state === 'idle'
          ? 'To Do'
          : 'In Progress';
    try {
      const task = await this.prisma.card.findUnique({
        where: { id: taskId },
        select: { boardId: true, parentId: true, taskColumnId: true },
      });
      if (!task) return;
      const column = await this.prisma.column.findFirst({
        where: { boardId: task.boardId, isTaskColumn: true, title: targetTitle },
        select: { id: true },
      });
      if (!column || column.id === task.taskColumnId) return;
      await this.prisma.card.update({
        where: { id: taskId },
        data: { taskColumnId: column.id },
      });
      this.realtime.broadcast({
        type: 'card.moved',
        cardId: taskId,
        parentId: task.parentId ?? null,
        fromColumnId: task.taskColumnId ?? null,
        toColumnId: column.id,
        isTaskBoard: true,
      });
    } catch (err) {
      this.logger.warn(
        `Falha ao espelhar coluna da task ${taskId} (${state}): ${(err as Error).message}`,
      );
    }
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
  /**
   * Persiste na STORY os fluxos afetados que a AI reportou, fazendo merge por
   * `name` (case-insensitive): fluxo novo é criado; existente tem seus arquivos
   * unidos (dedup) e a nota atualizada quando não-vazia. Emite `flow.changed`
   * para o board atualizar sem F5. É a AI a fonte desses dados.
   */
  private async persistAffectedFlows(
    storyId: string,
    flows: { name: string; files: string[]; note?: string }[],
  ): Promise<void> {
    const existing = await this.prisma.affectedFlow.findMany({ where: { cardId: storyId } });
    const byName = new Map(existing.map((f) => [f.name.trim().toLowerCase(), f]));
    let changed = false;

    for (const flow of flows) {
      const name = flow.name.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const prev = byName.get(key);
      const incomingFiles = (flow.files ?? []).map((x) => String(x)).filter(Boolean);
      if (prev) {
        const mergedFiles = Array.from(new Set([...prev.files, ...incomingFiles]));
        const note = flow.note && flow.note.trim() ? flow.note.trim() : prev.note;
        const filesChanged = mergedFiles.length !== prev.files.length;
        if (filesChanged || note !== prev.note) {
          await this.prisma.affectedFlow.update({
            where: { id: prev.id },
            data: { files: mergedFiles, note },
          });
          changed = true;
        }
      } else {
        await this.prisma.affectedFlow.create({
          data: { cardId: storyId, name, files: incomingFiles, note: flow.note?.trim() ?? '' },
        });
        changed = true;
      }
    }

    if (changed) {
      const all = await this.prisma.affectedFlow.findMany({ where: { cardId: storyId } });
      this.realtime.broadcast({ type: 'flow.changed', cardId: storyId, flows: all as never });
      await this.log(storyId, `AI registrou fluxos afetados (${flows.map((f) => f.name).join(', ')})`);
    }
  }

  /**
   * Resolve o modelo de AI de um card via herança em cascata:
   * `own ?? parent.model (recursivo) ?? board.defaultModel ?? config default`.
   */
  private async resolveCardModel(
    ownModel: string | null,
    parentId: string | null,
    boardId: string | null,
  ): Promise<string> {
    if (ownModel) return ownModel;

    let currentParentId = parentId;
    const seen = new Set<string>();
    while (currentParentId && !seen.has(currentParentId)) {
      seen.add(currentParentId);
      const parent = await this.prisma.card.findUnique({
        where: { id: currentParentId },
        select: { model: true, parentId: true },
      });
      if (!parent) break;
      if (parent.model) return parent.model;
      currentParentId = parent.parentId;
    }

    if (boardId) {
      const board = await this.prisma.board.findUnique({
        where: { id: boardId },
        select: { defaultModel: true },
      });
      if (board?.defaultModel) return board.defaultModel;
    }

    return this.config.agent.defaultModel;
  }

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
    /** DOD da task (id + texto + done) — a AI marca os ids que concluiu. */
    dodItems: { id: string; text: string; done: boolean }[];
    /** Handoff da iteração anterior — para a AI não recomeçar do zero. */
    prevHandoff: { detail: string; summary: string; nextStep: string } | null;
    /** #10c: lastro das tasks irmãs já concluídas (mesma story). */
    siblingHandoffs: { key: string; title: string; summary: string; nextStep: string }[];
    /** #10c: lastro do épico — resumos das stories anteriores (comments). */
    epicNotes: string[];
  }> {
    const task = await this.prisma.card.findUnique({
      where: { id: taskId },
      select: { parentId: true },
    });
    const story = task?.parentId
      ? await this.prisma.card.findUnique({
          where: { id: task.parentId },
          select: { aiProject: true, aiNotes: true, affectedFlows: true, parentId: true },
        })
      : null;
    // #10a: propagação epic→story. Se a story não tem aiProject/aiNotes
    // próprios, herda do épico pai.
    const epic = story?.parentId
      ? await this.prisma.card.findUnique({
          where: { id: story.parentId },
          select: { aiProject: true, aiNotes: true },
        })
      : null;
    const project = story?.aiProject || epic?.aiProject || '';
    const notes = story?.aiNotes || epic?.aiNotes || '';
    const flows = (story?.affectedFlows ?? []) as AffectedFlow[];

    const dodItems = await this.prisma.dodItem.findMany({
      where: { cardId: taskId },
      orderBy: { position: 'asc' },
      select: { id: true, text: true, done: true },
    });

    const lastIt = await this.prisma.iteration.findFirst({
      where: { cardId: taskId },
      orderBy: { index: 'desc' },
      select: { detail: true, summary: true, handoffNextStep: true },
    });

    // #10c: lastro cross-task — o que as tasks IRMÃS já concluídas fizeram.
    const siblingHandoffs: {
      key: string;
      title: string;
      summary: string;
      nextStep: string;
    }[] = [];
    if (task?.parentId) {
      const siblings = await this.prisma.card.findMany({
        where: { parentId: task.parentId, type: 'task', NOT: { id: taskId } },
        select: {
          key: true,
          title: true,
          execState: true,
          iterations: {
            orderBy: { index: 'desc' },
            take: 1,
            select: { summary: true, handoffNextStep: true },
          },
        },
      });
      for (const s of siblings) {
        if (s.execState !== 'done') continue;
        const last = s.iterations[0];
        if (!last) continue;
        siblingHandoffs.push({
          key: s.key,
          title: s.title,
          summary: last.summary ?? '',
          nextStep: last.handoffNextStep ?? '',
        });
      }
    }

    // #10c: lastro cross-story — comments de resumo acumulados no épico.
    const epicNotes: string[] = [];
    if (story?.parentId) {
      const comments = await this.prisma.comment.findMany({
        where: { cardId: story.parentId },
        orderBy: { ts: 'asc' },
        select: { text: true },
      });
      for (const c of comments) epicNotes.push(c.text);
    }

    return {
      taskTitle,
      project,
      notes,
      flowNames: flows.map((f) => f.name),
      files: flows.flatMap((f) => f.files),
      storyId: task?.parentId ?? null,
      affectedFlows: flows,
      dodItems,
      prevHandoff: lastIt
        ? {
            detail: lastIt.detail ?? '',
            summary: lastIt.summary ?? '',
            nextStep: lastIt.handoffNextStep ?? '',
          }
        : null,
      siblingHandoffs,
      epicNotes,
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
    profile: LoopProfileDef,
    context: Awaited<ReturnType<Orchestrator['buildContext']>>,
  ): string {
    const lines: string[] = [];

    lines.push('# Você é um agent autônomo de desenvolvimento no kanban-ai.');
    lines.push(
      'Trabalhe de forma incremental e ENCADEADA: você é uma iteração de um loop. ' +
        'Outras iterações virão depois e lerão o que você registrar. Foque em avançar ' +
        'a task, não em terminar tudo de uma vez. NÃO se perca: siga o profile e o handoff abaixo.',
    );

    // Profile + fase (a AI precisa saber a estratégia e em que fase está).
    lines.push('');
    lines.push(`## Loop profile: ${profile.name} (${profile.id})`);
    lines.push(`- Estratégia: ${profile.description}`);
    lines.push(`- Fases do profile: ${profile.phases.join(' → ')}`);
    lines.push(`- Estratégia de validação final: ${profile.validation}`);
    lines.push(`- **Fase DESTA iteração: ${phase}**`);

    // Task + contexto de domínio.
    lines.push('');
    lines.push(`## Task: ${context.taskTitle}`);
    if (context.project) lines.push(`- Projeto-alvo (repo): ${context.project}`);
    if (context.notes) lines.push(`- Notas / efeitos colaterais: ${context.notes}`);

    // #7/#8: escopo e projeto-alvo — a AI NÃO pode sair do repo-alvo.
    lines.push('');
    lines.push('## Escopo e projeto-alvo (LEIA COM ATENÇÃO)');
    if (context.project) {
      lines.push(
        `- Você está trabalhando NO PROJETO-ALVO: \`${context.project}\`. O diretório atual ` +
          'já é uma branch/worktree isolada desse repositório. Faça TODAS as mudanças aqui.',
      );
    } else {
      lines.push(
        '- ⚠️ Projeto-alvo NÃO definido. Não crie arquivos fora do diretório atual e ' +
          'não invente estrutura. Se faltar contexto, faça UMA pergunta objetiva.',
      );
    }
    lines.push(
      '- NUNCA crie features, arquivos ou pastas no repositório do próprio kanban-ai ' +
        '(este é a ferramenta, não o produto). Entregue estritamente o que a task pede, no projeto-alvo.',
    );

    // DOD real — o ÚNICO checklist do v1. É a AI quem marca os ids concluídos.
    lines.push('');
    lines.push('## Definition of Done (DOD) — único checklist. Marque VOCÊ os ids concluídos:');
    if (context.dodItems.length === 0) {
      lines.push('- (nenhum item de DOD cadastrado)');
    } else {
      for (const d of context.dodItems) {
        lines.push(`- [${d.done ? 'x' : ' '}] id=${d.id} :: ${d.text}`);
      }
    }

    // Fluxos afetados já conhecidos (para acumular, não substituir cegamente).
    lines.push('');
    lines.push('## Fluxos afetados já registrados (acrescente/atualize com o que VOCÊ tocar):');
    if (context.affectedFlows.length === 0) {
      lines.push('- (nenhum ainda — VOCÊ deve registrar os fluxos que tocar)');
    } else {
      for (const f of context.affectedFlows) {
        lines.push(`- ${f.name} :: arquivos=[${f.files.join(', ')}] :: ${f.note ?? ''}`);
      }
    }

    // Handoff da iteração anterior (para não recomeçar do zero).
    lines.push('');
    if (context.prevHandoff) {
      lines.push('## Handoff da iteração ANTERIOR (continue daqui):');
      if (context.prevHandoff.summary) lines.push(`- Resumo: ${context.prevHandoff.summary}`);
      if (context.prevHandoff.nextStep) lines.push(`- Próximo passo definido: ${context.prevHandoff.nextStep}`);
      if (context.prevHandoff.detail) {
        lines.push('- Detalhe completo da iteração anterior:');
        lines.push(context.prevHandoff.detail);
      }
    } else {
      lines.push('## Primeira iteração desta task.');
      lines.push(`- Primeiro passo do profile: ${profile.firstStep}`);
    }

    // #10c: lastro das tasks IRMÃS já concluídas (mesma story).
    if (context.siblingHandoffs.length) {
      lines.push('');
      lines.push('## Lastro — o que as tasks IRMÃS desta story já fizeram:');
      for (const s of context.siblingHandoffs) {
        const parts = [s.summary, s.nextStep ? `próximo: ${s.nextStep}` : '']
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${s.key} ${s.title}${parts ? ` :: ${parts}` : ''}`);
      }
      lines.push('Aproveite esse trabalho; não refaça o que já foi entregue.');
    }

    // #10c: lastro do ÉPICO — resumos das stories anteriores.
    if (context.epicNotes.length) {
      lines.push('');
      lines.push('## Lastro — contexto do épico (stories anteriores):');
      for (const note of context.epicNotes) {
        lines.push(note);
        lines.push('');
      }
    }

    // #9: granularidade nano — 1 item de DOD por iteração.
    lines.push('');
    lines.push('## Granularidade (IMPORTANTE — sessões nano)');
    lines.push(
      '- Resolva APENAS **1 item do DOD** por iteração. Pegue o PRIMEIRO item pendente ' +
        'listado acima, faça só ele, e emita `dodTouched` com NO MÁXIMO 1 id.',
    );
    lines.push(
      '- NÃO adiante outros itens. As próximas iterações continuam o resto ' +
        '(o loop encadeia sessões pequenas até o DOD acabar).',
    );

    // Contrato de SAÍDA — obrigatório. É assim que a AI reporta progresso.
    lines.push('');
    lines.push('## OBRIGATÓRIO — formato da sua resposta');
    lines.push(
      'Faça o trabalho da fase atual (leia/edite arquivos no diretório atual conforme necessário). ' +
        'Ao TERMINAR esta iteração, emita — como ÚLTIMA coisa da sua resposta — um bloco EXATAMENTE assim:',
    );
    lines.push('');
    lines.push('<<<KANBAN_RESULT>>>');
    lines.push('{');
    lines.push('  "summary": "<1 linha do que você fez nesta iteração>",');
    lines.push('  "dodTouched": ["<id de DOD que VOCÊ concluiu>"],');
    lines.push('  "affectedFlows": [{ "name": "<fluxo>", "files": ["<path>"], "note": "<o que muda>" }],');
    lines.push('  "nextStep": "<o que a PRÓXIMA iteração deve fazer; vazio se acabou>",');
    lines.push('  "done": false');
    lines.push('}');
    lines.push('<<<END_KANBAN_RESULT>>>');
    lines.push('');
    lines.push('Regras do bloco:');
    lines.push('- `dodTouched`: use os ids EXATOS listados no DOD acima. NO MÁXIMO 1 id por iteração (regra nano).');
    lines.push('- `affectedFlows`: registre onde você mexeu (arquivos + o efeito). VOCÊ é a fonte disso.');
    lines.push('- `done`: `true` só quando o trabalho de código da task terminou e o DOD está todo marcado.');
    lines.push('- `nextStep`: seja específico — a próxima iteração começa a partir dele.');

    // #6: canal ESTRUTURADO de pergunta (HITL). Substitui a instrução vaga.
    lines.push('');
    lines.push('## Quando precisar de decisão humana (HITL)');
    lines.push(
      'Se você precisar de uma decisão do humano para continuar, NÃO emita `KANBAN_RESULT` ' +
        'nesta resposta. Em vez disso, emita — como ÚLTIMA coisa — um bloco EXATAMENTE assim:',
    );
    lines.push('');
    lines.push('<<<KANBAN_QUESTION>>>');
    lines.push('{ "prompt": "<pergunta objetiva>", "options": ["<opção A>", "<opção B>"] }');
    lines.push('<<<END_KANBAN_QUESTION>>>');
    lines.push('');
    lines.push('Regras da pergunta:');
    lines.push('- Faça UMA pergunta objetiva por vez. `options` é opcional (omita para resposta livre).');
    lines.push('- Se emitir KANBAN_QUESTION, NÃO emita KANBAN_RESULT nem `done` — a task fica aguardando resposta.');
    lines.push('- A resposta do humano chegará no handoff da próxima iteração.');

    return lines.join('\n');
  }
}
