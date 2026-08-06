import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StopMode } from '@kanban-ai/shared';
import type { ExecState, AffectedFlow, LoopMetrics } from '@kanban-ai/shared';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
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
 * #8: métricas agregadas do loop de uma story. Retornadas por
 * `Orchestrator.computeStoryMetrics` e expostas via
 * `GET /cards/:id/loop/metrics`.
 *
 * O tipo agora é o contrato COMPARTILHADO (`@kanban-ai/shared`) para o web
 * consumir type-safe; re-exportado aqui para não quebrar imports existentes.
 */
export type { LoopMetrics } from '@kanban-ai/shared';

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
    const iterationStartedAt = Date.now();
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
    // Agent responsável (assignee): carrega modelo e instruções ("AGENTS.md" do
    // agent) para especializar esta iteração. Um agent = um modelo + um prompt.
    const agent = agentId
      ? await this.prisma.assignee.findUnique({
          where: { id: agentId },
          select: { model: true, instructions: true },
        })
      : null;
    const context = await this.buildContext(taskId, raw?.title ?? '(task)');
    const storyId = context.storyId ?? taskId;

    // Modelo de AI resolvido em cascata: task → parents → agent responsável →
    // board.defaultModel → default global. Injetado no spawn via env
    // COPILOT_MODEL pelo runner.
    const resolvedModel = await this.resolveCardModel(
      raw?.model ?? null,
      raw?.parentId ?? null,
      raw?.boardId ?? null,
      agent?.model ?? null,
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

    // Buffer de consolidação do transcript (espelha agentChatStore no front):
    // chunks consecutivos do mesmo `kind` viram UMA AgentMessage, para não
    // gravar uma linha por token. Faz flush ao trocar de kind, ao surgir uma
    // pergunta HITL e ao terminar a iteração.
    let chunkBuffer: { kind: 'thought' | 'output'; text: string } | null = null;
    const flushChunkBuffer = async (): Promise<void> => {
      if (!chunkBuffer || chunkBuffer.text.length === 0) {
        chunkBuffer = null;
        return;
      }
      const buffered = chunkBuffer;
      chunkBuffer = null;
      await this.prisma.agentMessage.create({
        data: {
          cardId: taskId,
          role: 'ai',
          kind: buffered.kind,
          phase,
          text: buffered.text,
        },
      });
    };

    const runResult = await this.runner.run({
      cwd,
      model: resolvedModel,
      phase,
      // cliSessionId = taskId (UUID). Dá memória conversacional entre iterações
      // one-shot e torna o HITL resiliente a restart: o turno que retoma após a
      // resposta humana resume a MESMA sessão do Copilot. Ver ADR-0022.
      cliSessionId: taskId,
      prompt: this.buildPrompt(phase, profile, context, agent?.instructions ?? ''),
      context: runnerContext,
      signal,
      // b6: repassa cada chunk de streaming para o WS (buffer reativo no front)
      // e acumula no buffer de consolidação para persistir o transcript.
      onChunk: (chunk) => {
        this.realtime.broadcast({
          type: 'agent.chunk',
          taskId,
          storyId,
          kind: chunk.kind,
          delta: chunk.delta,
        });
        // Acumula no buffer; ao trocar de kind, faz flush do anterior (fire-and
        // -forget: a ordem é preservada porque cada create é curto e o flush
        // final aguarda a persistência antes de encerrar a iteração).
        if (chunkBuffer && chunkBuffer.kind !== chunk.kind) {
          void flushChunkBuffer();
        }
        if (!chunkBuffer) {
          chunkBuffer = { kind: chunk.kind, text: chunk.delta };
        } else {
          chunkBuffer.text += chunk.delta;
        }
      },
      // b6: HITL — emite agent.question, entra em awaiting-input e aguarda resposta.
      onQuestion: async (question) => {
        const questionId = question.id || randomUUID();
        // Flush do raciocínio acumulado antes da pergunta, para o transcript
        // manter a ordem: pensamento → pergunta → resposta.
        await flushChunkBuffer();
        this.realtime.broadcast({
          type: 'agent.question',
          taskId,
          storyId,
          questionId,
          prompt: question.prompt,
          options: question.options,
        });
        // Persiste a PERGUNTA (role=ai) amarrada por questionId, com as
        // opções de resposta rápida (para reidratar os chips após F5).
        await this.prisma.agentMessage.create({
          data: {
            cardId: taskId,
            role: 'ai',
            text: question.prompt,
            questionId,
            options: question.options ?? undefined,
          },
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
          // Persiste a RESPOSTA do humano (role=user) com o mesmo questionId.
          await this.prisma.agentMessage.create({
            data: { cardId: taskId, role: 'user', text: answer, questionId },
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

    // Flush do transcript remanescente ao fim da execução do runner.
    await flushChunkBuffer();

    // Diff/Replay Viewer: captura o diff do worktree ANTES da validação/derivação,
    // refletindo exatamente o que o agent produziu nesta iteração. Reutilizado
    // em ambos os call sites de appendIteration abaixo.
    const iterationDiff = await this.captureDiff(cwd);

    // DOD nasce na ANÁLISE. Se a task ainda não tem checklist, criamos os
    // DodItems a partir do que a AI propôs (`runResult.proposedDod`). Se a AI
    // não propôs nada (ex.: mock), aplicamos um fallback determinístico para
    // que a task nunca prossiga sem DOD — sem DOD o gate de validação nunca
    // dispara. Só criamos uma vez; após criado, `context.dodItems` reflete a
    // realidade nas próximas iterações.
    if (context.dodItems.length === 0) {
      const created = await this.ensureDodExists(taskId, phase, runResult.proposedDod);
      if (created.length > 0) {
        // Atualiza o contexto em memória para que o restante desta iteração
        // (marcação de DOD) já enxergue os itens recém-criados.
        context.dodItems = created.map((d) => ({ id: d.id, text: d.text, done: d.done }));
      }
    }

    if (phase === 'validation') {
      await this.setExecState(taskId, 'validating');
      const outcome = await this.validation.validate({
        storyId,
        strategy: profile.validation,
        affectedFlows: context.affectedFlows,
        cwd,
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
        evidence: runResult.evidence,
        diff: iterationDiff,
        durationMs: Date.now() - iterationStartedAt,
        outcome: outcome.passed ? 'ok' : 'derived',
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

        // "Needs human": conta quantas iterações de validação desta task já
        // falharam (inclui a recém-anexada acima, com handoffState='blocked').
        // Ao atingir o threshold, em vez de derivar de novo (risco de loop
        // infinito de derivações), marcamos a task com `needsHuman`, paramos o
        // auto-play da story de forma graceful e emitimos um evento WS.
        const validationFailures = await this.prisma.iteration.count({
          where: { cardId: taskId, phase: 'validation', handoffState: 'blocked' },
        });
        if (validationFailures >= this.config.agent.maxValidationFailures) {
          await this.prisma.card.update({
            where: { id: taskId },
            data: { needsHuman: true, needsHumanReason: problem.title },
          });
          // Para o auto-play da story sem abortar hard (graceful): preserva o
          // estado no Postgres e deixa o próximo tick encerrar limpo.
          await this.stop(storyId, 'graceful');
          this.realtime.broadcast({
            type: 'card.needs_human',
            taskId,
            storyId,
            reason: problem.title,
          });
          await this.log(
            taskId,
            `validação falhou ${validationFailures}x (limite ${this.config.agent.maxValidationFailures}) — marcada como "precisa de humano"; auto-play parado`,
          );
        } else {
          await this.createDerivedTask(taskId, problem);
        }
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
      const reportedValid = reported.filter((id) => validIds.has(id));
      // Regra nano (#4): NO MÁXIMO 1 item de DOD por iteração. Se a AI reportar
      // mais de um id válido, marcamos apenas o de MENOR `position` (a ordem
      // canônica do DOD, não a ordem que a AI mandou) e ignoramos o excedente.
      const orderByPosition = context.dodItems.map((d) => d.id);
      const toMark = reportedValid
        .slice()
        .sort((a, b) => orderByPosition.indexOf(a) - orderByPosition.indexOf(b))
        .slice(0, 1);
      const ignored = reportedValid.filter((id) => !toMark.includes(id));
      for (const id of toMark) {
        await this.prisma.dodItem.update({ where: { id }, data: { done: true } });
        this.realtime.broadcast({ type: 'dod.checked', cardId: taskId, itemId: id, done: true });
      }
      if (ignored.length > 0) {
        await this.log(
          taskId,
          `AI reportou ${reportedValid.length} itens de DOD; regra nano permite 1 por iteração — ` +
            `marcado ${toMark[0]}, ignorados [${ignored.join(', ')}] (próximas iterações continuam).`,
        );
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
      evidence: runResult.evidence,
      diff: iterationDiff,
      durationMs: Date.now() - iterationStartedAt,
      outcome: hitlExchange ? 'awaiting-input' : 'ok',
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
    // Gate HITL (autoritativo): se a story tem uma pergunta pendente aguardando
    // resposta humana, NENHUMA iteração pode começar — senão a AI seria
    // reinvocada em loop (gastando tokens/dinheiro) e substituiria a pergunta
    // pendente. Independe do `inFlight` (que é best-effort na memória do processo).
    if (this.sessions.getPending(storyId)) {
      return false;
    }

    const tasks = await this.loadStoryTasks(storyId);
    if (tasks.length === 0) return false;
    const byId = new Map(tasks.map((t) => [t.id, t]));

    const revalidating = tasks.find(
      (t) =>
        t.execState === 'validating' &&
        !t.needsHuman &&
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
   * #4: promove uma story quando todas as suas tasks concluíram. Vai para a
   * coluna "Review" (revisão humana antes de Done) quando ela existir; caso
   * contrário, cai de volta para "Done". Idempotente (não re-promove se já
   * está na coluna-alvo) e NÃO reacorda o motor. Ao final, encadeia a próxima
   * story do épico (#5).
   */
  private async promoteStory(storyId: string): Promise<void> {
    try {
      const story = await this.prisma.card.findUnique({
        where: { id: storyId },
        select: { id: true, type: true, boardId: true, boardColumnId: true, parentId: true },
      });
      if (!story || story.type !== 'story') return;

      // Fluxo feliz vai para revisão humana (Review) antes de Done. Se o board
      // não tiver a coluna Review, cai de volta para Done.
      const targetCol =
        (await this.prisma.column.findFirst({
          where: { boardId: story.boardId, isTaskColumn: false, title: 'Review' },
          select: { id: true, title: true },
        })) ??
        (await this.prisma.column.findFirst({
          where: { boardId: story.boardId, isTaskColumn: false, title: 'Done' },
          select: { id: true, title: true },
        }));
      if (!targetCol) return;
      // Idempotência: só promove uma vez.
      if (story.boardColumnId === targetCol.id) return;

      const fromColumnId = story.boardColumnId;
      const position = await this.prisma.card.count({
        where: { boardColumnId: targetCol.id, NOT: { id: storyId } },
      });
      await this.prisma.card.update({
        where: { id: storyId },
        data: { boardColumnId: targetCol.id, position, everInProgress: true },
      });
      this.realtime.broadcast({
        type: 'card.moved',
        cardId: storyId,
        parentId: story.parentId ?? null,
        fromColumnId,
        toColumnId: targetCol.id,
        isTaskBoard: false,
      });
      await this.log(
        storyId,
        `Story concluída — todas as tasks done. Promovida para ${targetCol.title}.`,
      );

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
   * #8: métricas de qualidade do loop de uma story, agregadas sobre as
   * iterações de todas as tasks-filhas. Alimenta o endpoint
   * `GET /cards/:id/loop/metrics` e serve de base para medir se as demais
   * melhorias (#1/#3/#6) tornam a AI mais eficiente.
   */
  async computeStoryMetrics(storyId: string): Promise<LoopMetrics> {
    const tasks = await this.prisma.card.findMany({
      where: { parentId: storyId, type: 'task' },
      select: { id: true, execState: true, key: true, title: true },
    });
    const taskIds = tasks.map((t) => t.id);

    const iterations = taskIds.length
      ? await this.prisma.iteration.findMany({
          where: { cardId: { in: taskIds } },
          select: {
            cardId: true,
            phase: true,
            durationMs: true,
            inputTokens: true,
            outputTokens: true,
            outcome: true,
          },
        })
      : [];

    // Tasks derivadas: geradas quando a validação falha (createDerivedTask).
    // Contabilizamos as que possuem dependência apontando para outra task da
    // mesma story (heurística barata) OU cujo outcome de validação foi derived.
    const derivedIterations = iterations.filter((it) => it.outcome === 'derived').length;
    const okIterations = iterations.filter((it) => it.outcome === 'ok').length;

    const durations = iterations
      .map((it) => it.durationMs)
      .filter((d): d is number => typeof d === 'number');
    const avgDurationMs = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    const totalInputTokens = iterations.reduce((a, it) => a + (it.inputTokens ?? 0), 0);
    const totalOutputTokens = iterations.reduce((a, it) => a + (it.outputTokens ?? 0), 0);

    const perTask = tasks.map((t) => {
      const its = iterations.filter((it) => it.cardId === t.id);
      return {
        taskId: t.id,
        key: t.key,
        title: t.title,
        execState: t.execState ?? 'idle',
        iterations: its.length,
      };
    });

    return {
      storyId,
      taskCount: tasks.length,
      iterationCount: iterations.length,
      avgIterationsPerTask: tasks.length
        ? Number((iterations.length / tasks.length).toFixed(2))
        : 0,
      derivedTaskRate: iterations.length
        ? Number((derivedIterations / iterations.length).toFixed(2))
        : 0,
      okIterationRate: iterations.length
        ? Number((okIterations / iterations.length).toFixed(2))
        : 0,
      avgDurationMs,
      totalInputTokens,
      totalOutputTokens,
      perTask,
    };
  }

  /**
   * HITL: entrega a resposta do humano à pergunta pendente, retomando o
   * trabalho da task. Resiliente a restart da API (ver ADR-0022):
   *
   * - **Caminho rápido:** existe uma Promise viva de `waitForAnswer` (mesmo
   *   processo, sem restart) → resolve como antes (o runner escreve no stdin e a
   *   iteração pausada continua).
   * - **Caminho de resiliência:** sem promise viva (houve restart — o `Map` de
   *   sessões e o child process do Copilot morreram) → busca a AI question no
   *   banco por `questionId`, confirma que ainda não há resposta do usuário para
   *   ela, persiste a resposta e re-dispara `runIteration(taskId)`. Como o
   *   runner injeta `--session-id=taskId`, o Copilot **resume** a sessão
   *   persistida (a pergunta inclusa) e continua o trabalho.
   *
   * Retorna false apenas se a pergunta nem existe (→ 404 no controller).
   */
  async answerQuestion(
    storyId: string,
    questionId: string,
    answer: string,
  ): Promise<boolean> {
    // Caminho rápido: promise viva no mesmo processo.
    if (this.sessions.resolveQuestion(storyId, questionId, answer)) {
      return true;
    }

    // Caminho de resiliência: sem promise viva (restart). A pergunta foi
    // persistida (role=ai, questionId) amarrada ao cardId=taskId.
    const question = await this.prisma.agentMessage.findFirst({
      where: { role: 'ai', questionId },
      orderBy: { ts: 'desc' },
      select: { cardId: true },
    });
    if (!question) return false; // pergunta nem existe → 404

    const taskId = question.cardId;

    // Idempotência: se já existe uma resposta do usuário para este questionId,
    // não re-processa (evita re-disparar iteração e duplicar a resposta).
    const already = await this.prisma.agentMessage.findFirst({
      where: { role: 'user', questionId },
      select: { id: true },
    });
    if (already) return true;

    // Persiste a RESPOSTA do humano (role=user) com o mesmo questionId.
    await this.prisma.agentMessage.create({
      data: { cardId: taskId, role: 'user', text: answer, questionId },
    });
    this.realtime.broadcast({ type: 'agent.answered', taskId, questionId });
    await this.log(
      taskId,
      'resposta HITL recebida após restart — retomando iteração (resume via --session-id)',
    );

    // Re-dispara a iteração da task. O Copilot resume a sessão persistida
    // (--session-id=taskId), que já contém a pergunta; o prompt reconstruído
    // (histórico + protocolo) reforça o contexto. Fire-and-forget: o endpoint
    // não bloqueia até o próximo turno terminar.
    void this.runIteration(taskId).catch((err) => {
      this.logger.error(
        `runIteration(${taskId}) após resposta HITL falhou: ${String(err)}`,
      );
    });
    return true;
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
      /** #6: evidência de verificação do próprio trabalho. */
      evidence?: string;
      /** Diff/Replay: unified diff do worktree ao fim da iteração. */
      diff?: string;
      /** #8: telemetria de qualidade (opcional). */
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      outcome?: string;
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
          evidence: it.evidence ?? '',
          diff: it.diff ?? '',
          durationMs: it.durationMs ?? null,
          inputTokens: it.inputTokens ?? null,
          outputTokens: it.outputTokens ?? null,
          outcome: it.outcome ?? null,
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

  /**
   * Diff/Replay Viewer: captura o unified diff do worktree isolado ao fim de
   * uma iteração, para o front navegar iteração a iteração vendo o que mudou.
   *
   * IMPORTANTE: este `git` é do ORQUESTRADOR (código do engine) inspecionando o
   * resultado no worktree — NÃO é o agent rodando git (isso é proibido pelo
   * prompt). Roda `git add -A -N` para que arquivos novos apareçam no diff, e
   * então `git diff HEAD` (staged + unstaged) contra o commit base do worktree.
   * Trunca em ~100KB para não estourar payload/DB. Qualquer erro (cwd inválido,
   * não é repo git, timeout) é tratado silenciosamente retornando ''.
   */
  private async captureDiff(cwd: string): Promise<string> {
    if (!cwd) return '';
    const MAX_DIFF_BYTES = 100 * 1024;
    const run = (args: string[]): Promise<string> =>
      new Promise<string>((resolve) => {
        execFile(
          'git',
          args,
          { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 20 * 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              resolve('');
              return;
            }
            resolve(stdout ?? '');
          },
        );
      });
    try {
      // Registra intenção de adicionar arquivos novos (não altera conteúdo) para
      // que apareçam no diff; ignoramos falha (repo vazio, etc.).
      await run(['add', '-A', '-N']);
      let diff = await run(['diff', 'HEAD']);
      if (!diff) diff = await run(['diff']);
      if (diff.length > MAX_DIFF_BYTES) {
        diff = diff.slice(0, MAX_DIFF_BYTES) + '\n… [diff truncado]';
      }
      return diff;
    } catch (err) {
      this.logger.warn(`Falha ao capturar diff em ${cwd}: ${(err as Error).message}`);
      return '';
    }
  }

  private async log(cardId: string, text: string): Promise<void> {
    await this.prisma.activity.create({ data: { cardId, text } });
  }

  /**
   * Garante que a task tenha um DOD (Definition of Done). O DOD nasce na fase
   * de ANÁLISE do loop:
   *
   * - Se a AI propôs itens (`proposedDod`), criamos um `DodItem` por string, na
   *   ordem, começando em `position: 0`.
   * - Se a AI não propôs nada mas estamos na fase de análise (ex.: mock runner),
   *   aplicamos um DOD mínimo determinístico para que a task nunca prossiga sem
   *   checklist — sem DOD o gate de validação nunca dispara.
   *
   * Só cria quando a task realmente não tem itens. Retorna os itens criados
   * (vazio se nada foi criado) e emite o evento WS `dod.created`.
   */
  private async ensureDodExists(
    taskId: string,
    phase: string,
    proposedDod: string[] | undefined,
  ): Promise<{ id: string; text: string; done: boolean }[]> {
    // Idempotência: se já existir DOD (corrida entre iterações), não recria.
    const existing = await this.prisma.dodItem.count({ where: { cardId: taskId } });
    if (existing > 0) return [];

    let texts = (proposedDod ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 20);

    // Fallback determinístico: só na análise, e só se a AI não propôs nada.
    if (texts.length === 0) {
      if (phase !== 'analysis') return [];
      texts = [
        'Implementação atende ao que foi descrito na task',
        'Código compila (build) sem erros',
        'Verificação executada e evidenciada antes de concluir',
      ];
    }

    // Dedup preservando ordem.
    const seen = new Set<string>();
    texts = texts.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));

    await this.prisma.dodItem.createMany({
      data: texts.map((text, position) => ({ cardId: taskId, text, position, done: false })),
    });
    const created = await this.prisma.dodItem.findMany({
      where: { cardId: taskId },
      orderBy: { position: 'asc' },
      select: { id: true, text: true, done: true },
    });

    await this.log(
      taskId,
      `DOD definido na fase de ${phase} — ${created.length} ${created.length === 1 ? 'item' : 'itens'}`,
    );
    this.realtime.broadcast({ type: 'dod.created', cardId: taskId, count: created.length });
    return created;
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
        needsHuman: true,
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
        needsHuman: true,
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
    needsHuman: boolean;
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
      needsHuman: card.needsHuman,
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
    agentModel: string | null = null,
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

    // Agent responsável define seu próprio modelo quando card/parents não fixam um.
    if (agentModel) return agentModel;

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
    /**
     * #3: histórico COMPLETO das iterações anteriores desta task (ordem asc),
     * para a AI não repetir erros de tentativas passadas. A última entra com
     * `detail` completo; as demais são resumidas em `buildPrompt`.
     */
    iterationHistory: {
      index: number;
      phase: string;
      summary: string;
      detail: string;
      nextStep: string;
      failedValidation: boolean;
    }[];
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

    // #3: histórico completo das iterações desta task (ordem crescente).
    const historyRows = await this.prisma.iteration.findMany({
      where: { cardId: taskId },
      orderBy: { index: 'asc' },
      select: {
        index: true,
        phase: true,
        summary: true,
        detail: true,
        handoffNextStep: true,
        handoffState: true,
      },
    });
    const iterationHistory = historyRows.map((it) => ({
      index: it.index,
      phase: String(it.phase),
      summary: it.summary ?? '',
      detail: it.detail ?? '',
      nextStep: it.handoffNextStep ?? '',
      failedValidation: it.phase === 'validation' && it.handoffState === 'blocked',
    }));

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
      iterationHistory,
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
    agentInstructions = '',
  ): string {
    const lines: string[] = [];

    lines.push('# Você é um agent autônomo de desenvolvimento no kanban-ai.');
    lines.push(
      'Trabalhe de forma incremental e ENCADEADA: você é uma iteração de um loop. ' +
        'Outras iterações virão depois e lerão o que você registrar. Foque em avançar ' +
        'a task, não em terminar tudo de uma vez. NÃO se perca: siga o profile e o handoff abaixo.',
    );

    // Instruções do agent responsável ("AGENTS.md" do agent). Quando definidas,
    // especializam o comportamento desta iteração (persona, foco, regras).
    if (agentInstructions.trim()) {
      lines.push('');
      lines.push('## Instruções do agent responsável (siga com prioridade):');
      lines.push(agentInstructions.trim());
    }

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

    // Proibição de operações git. O worktree/branch é gerenciado EXCLUSIVAMENTE
    // pelo loop engine. Se o agent commitar ou trocar de branch, o worktree que
    // o gate de validação inspeciona fica dessincronizado do trabalho real, a
    // verificação de arquivos falha e uma task de correção é derivada em loop.
    lines.push('');
    lines.push('## ❌ PROIBIDO — operações de git (NÃO NEGOCIÁVEL)');
    lines.push(
      '- Você **NÃO PODE** rodar `git commit`, `git add`, `git branch`, `git checkout`, ' +
        '`git switch`, `git merge`, `git rebase`, `git reset`, `git stash`, `git push`, ' +
        '`git worktree` ou QUALQUER comando git que altere o estado do repositório.',
    );
    lines.push(
      '- **Apenas EDITE os arquivos** no diretório atual (leia/escreva/crie arquivos normalmente). ' +
        'Deixe as mudanças no working tree, NÃO commitadas.',
    );
    lines.push(
      '- O worktree e a branch são criados e gerenciados pelo loop engine. Se você commitar ' +
        'ou criar/trocar branch, o gate de validação passa a inspecionar um snapshot ' +
        'dessincronizado do seu trabalho real — os arquivos que você declara em `affectedFlows` ' +
        'aparecem como "inexistentes" e o sistema deriva tasks de correção duplicadas em loop infinito.',
    );
    lines.push(
      '- Comandos git de LEITURA (`git status`, `git diff`, `git log`) são permitidos apenas ' +
        'para inspeção — nunca comandos que mudem estado.',
    );

    // DOD real — o ÚNICO checklist do v1. É a AI quem marca os ids concluídos.
    lines.push('');
    lines.push('## Definition of Done (DOD) — único checklist. Marque VOCÊ os ids concluídos:');
    if (context.dodItems.length === 0) {
      lines.push('- (nenhum item de DOD cadastrado)');
      if (phase === 'analysis') {
        lines.push('');
        lines.push(
          '⚠️ Esta task ainda NÃO tem DOD. Como estamos na fase de ANÁLISE, é VOCÊ quem ' +
            'deve DEFINIR o Definition of Done: emita no `KANBAN_RESULT` o campo ' +
            '`proposedDod` — uma lista de strings curtas e objetivas (3 a 7 itens), cada uma ' +
            'um critério verificável de conclusão desta task. Não invente ids; apenas ' +
            'proponha os textos. O sistema criará os itens e nas próximas iterações você os ' +
            'marcará por id via `dodTouched`.',
        );
      }
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

    // #3: histórico COMPLETO das iterações anteriores desta task, para a AI não
    // repetir erros de tentativas passadas. A última iteração entra com o
    // `detail` completo; as anteriores são resumidas para não estourar o prompt.
    lines.push('');
    const history = context.iterationHistory;
    if (history.length > 0) {
      lines.push('## Histórico desta task — TODAS as iterações anteriores (continue daqui, NÃO repita erros):');
      const lastIndex = history.length - 1;
      history.forEach((it, i) => {
        const flag = it.failedValidation ? '⚠️ FALHOU na validação — ' : '';
        lines.push(`- #${it.index} [${it.phase}]: ${flag}${it.summary || '(sem resumo)'}`);
        if (it.nextStep) lines.push(`  ↳ próximo passo definido: ${it.nextStep}`);
        // Só a última iteração traz o detalhe completo (contexto imediato).
        if (i === lastIndex && it.detail) {
          lines.push('  ↳ detalhe completo da iteração mais recente:');
          lines.push(it.detail);
        }
      });
      const failures = history.filter((it) => it.failedValidation).length;
      if (failures > 0) {
        lines.push(
          `Atenção: ${failures} iteração(ões) já FALHARAM na validação. Entenda o que deu errado ` +
            'antes de tentar de novo — não repita a mesma abordagem.',
        );
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
    if (context.dodItems.length === 0 && phase === 'analysis') {
      lines.push('  "proposedDod": ["<critério de conclusão 1>", "<critério 2>", "..."],');
    }
    lines.push('  "dodTouched": ["<id de DOD que VOCÊ concluiu>"],');
    lines.push('  "affectedFlows": [{ "name": "<fluxo>", "files": ["<path>"], "note": "<o que muda>" }],');
    lines.push('  "nextStep": "<o que a PRÓXIMA iteração deve fazer; vazio se acabou>",');
    lines.push('  "evidence": "<como você verificou seu trabalho; ex.: \\"npm test: 12 passed, build ok\\">",');
    lines.push('  "done": false');
    lines.push('}');
    lines.push('<<<END_KANBAN_RESULT>>>');
    lines.push('');
    lines.push('Regras do bloco:');
    if (context.dodItems.length === 0 && phase === 'analysis') {
      lines.push('- `proposedDod`: como a task ainda não tem DOD, proponha aqui os critérios de conclusão (3 a 7 strings). O sistema cria os itens; NÃO use `dodTouched` nesta iteração.');
    }
    lines.push('- `dodTouched`: use os ids EXATOS listados no DOD acima. NO MÁXIMO 1 id por iteração (regra nano). Se você reportar mais de 1, apenas o primeiro (na ordem do DOD) será marcado; o restante é ignorado.');
    lines.push('- `affectedFlows`: registre onde você mexeu (arquivos + o efeito). VOCÊ é a fonte disso. Os arquivos são verificados contra o filesystem real — não liste arquivos que não existem.');
    lines.push('- `done`: `true` só quando o trabalho de código da task terminou e o DOD está todo marcado.');
    lines.push('- `nextStep`: seja específico — a próxima iteração começa a partir dele.');
    lines.push('- `evidence`: obrigatório quando `done: true` — resuma a verificação que você fez (ver seção abaixo).');

    // #6: exigir que a AI verifique o próprio trabalho ANTES de marcar done.
    lines.push('');
    lines.push('## ANTES de marcar `done` — verifique seu trabalho');
    lines.push(
      'Você NÃO deve emitir `done: true` sem antes verificar empiricamente que o código ' +
        'funciona. Um gate de validação vai rodar os checks do projeto no seu diretório de ' +
        'trabalho; se falharem, uma task de correção é derivada e o seu `done` é revertido. ' +
        'Antecipe-se:',
    );
    lines.push('- Rode os checks relevantes do projeto NO DIRETÓRIO ATUAL antes de concluir — ex.: `npm test`, `npm run build`, `npm run lint` (use os scripts que existirem no `package.json`).');
    lines.push('- Só marque `done: true` depois que esses checks passarem.');
    lines.push('- Preencha `evidence` com o resultado concreto da verificação (ex.: "npm test: 12 passed; build ok").');
    lines.push('- Se o projeto NÃO tiver como verificar (sem testes/scripts), diga isso explicitamente em `evidence` (ex.: "sem suíte de testes no projeto — verificação manual da lógica").');

    // #6: canal ESTRUTURADO de pergunta (HITL). Substitui a instrução vaga.
    lines.push('');
    lines.push('## Quando precisar de decisão humana (HITL)');
    lines.push(
      'Se você precisar de uma decisão do humano para continuar, NÃO emita `KANBAN_RESULT` ' +
        'nesta resposta. Em vez disso, emita — como ÚLTIMA coisa — um bloco EXATAMENTE assim:',
    );
    lines.push('');
    lines.push('<<<KANBAN_QUESTION>>>');
    lines.push('{ "prompt": "<pergunta objetiva>", "options": ["<opção curta A>", "<opção curta B>", "<opção curta C>"] }');
    lines.push('<<<END_KANBAN_QUESTION>>>');
    lines.push('');
    lines.push('Regras da pergunta:');
    lines.push('- Faça UMA pergunta objetiva por vez.');
    lines.push(
      '- SEMPRE que a pergunta admitir alternativas, forneça de 2 a 4 `options` curtas e ' +
        'acionáveis (é assim que o humano responde com um clique). Só omita `options` quando ' +
        'a resposta for genuinamente aberta (ex.: um nome, um texto livre).',
    );
    lines.push(
      '- Mesmo com `options`, o humano ainda pode escrever uma resposta livre — então as ' +
        'opções são atalhos, não uma lista fechada.',
    );
    lines.push('- Se emitir KANBAN_QUESTION, NÃO emita KANBAN_RESULT nem `done` — a task fica aguardando resposta.');
    lines.push('- A resposta do humano chegará no handoff da próxima iteração.');

    return lines.join('\n');
  }
}
