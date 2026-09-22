import { Inject, Injectable, Logger, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { StopMode } from '@kanban-ai/shared';
import type { ExecState, AffectedFlow, LoopMetrics, WakeupReason, BlockKind, BlockedDescriptor } from '@kanban-ai/shared';
import { isVerifiableEvidence, minimumArtifactSatisfied } from '@kanban-ai/shared';
import type { ResultClass, CommitOutcome, StructuredEvidence } from '@kanban-ai/shared';
import { CONTINUABLE_LIVENESS } from '@kanban-ai/shared';
import type { CompletionMetadata, RunLivenessState } from '@kanban-ai/shared';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { closeSync, openSync, statSync, utimesSync } from 'node:fs';
import { PrismaService } from '../../shared/db/prisma.service';
import { Prisma } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import {
  GUARDED_ACTIONS,
  runGuarded,
  GuardedActionDeniedError,
  type GuardedActionContext,
} from './guarded-actions';
import { RealtimeService } from '../../realtime/realtime.service';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { WorkspaceService, TargetProjectError } from './workspaces/workspace.service';
import { ProjectWorkspaceService } from '../projects/project-workspace.service';
import { ProjectGraphService, collectChangedFiles } from '../projects/project-graph.service';
import {
  ProjectGraphQueryService,
  GRAPHIFY_PROJECTS_HOME,
} from '../projects/project-graph-query.service';
import { ProjectHiveService } from '../projects/project-hive.service';
import { AGENT_RUNNER, type AgentRunner, type AgentRunResult } from './runners/agent-runner.interface';
import { ValidationRunner } from './validators/validation.runner';
import { resolveLoopProfile, type LoopProfileDef } from './loop-profiles/loop-profiles';
import { mapIteration, type PrismaIterationRow } from '../cards/iteration.mapper';
import { deriveEpicStatus, type ColumnLike } from '../cards/cards.epic-status';
import {
  HIVE_MEMORY_SUBDIR,
  fileNodeId,
  memoryDocFilename,
  serializeMemoryDoc,
  type MemoryOutcome,
} from '../../shared/neuron-format';
import { WakeupQueueService } from './wakeup-queue.service';
import { decideStuck } from './stuck-sla';
import { detectNoCommentStreak } from './no-comment-streak';
import { ReviewActionService } from '../review/review-action.service';
import {
  resolveDispatchAdapter,
  resolveDispatchModel,
  recoveryGuardLines,
} from './recovery-lane';
import { AgentAdapterRegistry } from './runners/agent-adapter.registry';
import { AGENT_ADAPTER_KINDS } from '../../shared/config/config';
import type { AgentAdapterKind } from '@kanban-ai/shared';
import {
  allTasksDone,
  dodAllDone,
  evidenceToString,
  execStateAfterPhase,
  fromPrismaExecState,
  isThrashing,
  nextPhaseFor,
  pendingDeps,
  pickNextTask,
  storyHasPendingTasks,
  toPrismaExecState,
  type LoopTask,
  type ThrashSample,
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
/**
 * US-F2.5 — teto de neurônios cujo CORPO é anexado ao recall por grafo.
 * Paridade com o limite 5 do recall LIKE antigo, mas a seleção é por
 * relevância de travessia/aresta `describes` — não por recência de indexação.
 */
const GRAPH_RECALL_MAX_NEURONS = 5;

/**
 * US-F5.3 — teto de tokens do vocabulário selecionados por consulta ("Step 0 —
 * Constrained query expansion" do query.md do graphify: "select up to 12
 * tokens from this exact list").
 */
const GRAPH_QUERY_MAX_TOKENS = 12;

/** US-F5.3 — remove diacríticos preservando a CAIXA (o split de camelCase precisa dela). */
function deaccent(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * US-F5.3 — tokenização da receita do Step 0 do query.md: palavras unicode,
 * split de camelCase/PascalCase, minúsculo, comprimento 3..30. Acentos são
 * removidos ANTES ("conversão" → "conversao") para a pergunta em português e
 * os labels casarem na mesma forma; como o mesmo tokenizador roda nos DOIS
 * lados, o token emitido é sempre derivado de um label real do grafo.
 * ponytail: um label ACENTUADO emitiria token sem acento que o matcher
 * literal do binário não casa — labels aqui são identificadores ASCII de
 * código; se um dia doer, emita a forma original do label.
 */
function graphVocabTokens(text: string): string[] {
  const out: string[] = [];
  for (const chunk of deaccent(text).match(/[^\W\d_]+/gu) ?? []) {
    const parts = chunk.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+/g) ?? [chunk];
    for (const p of parts) {
      if (p.length >= 3 && p.length <= 30) out.push(p.toLowerCase());
    }
  }
  return out;
}

/** US-F2.6 — teto de arquivos da iteração que entram no `files:` do neurônio. */
const LEARNING_FILES_MAX = 10;

/**
 * US-F2.6 — corte da lista de arquivos tocados pela iteração antes de entrar
 * no frontmatter `files:` do neurônio (canal da aresta `describes`, F2.4).
 * Uma iteração pode tocar dezenas de arquivos; sem corte o neurônio
 * "descreveria" o repo inteiro e viraria hub de ruído no recall (F2.5).
 * Filtra o que não descreve nada (lockfiles e a própria colmeia materializada
 * em `.hive/`) e corta em `LEARNING_FILES_MAX`, na ordem do `git diff`
 * (determinística, ordenada por path). Pura; exportada para as specs.
 */
export function cutLearningFiles(files: string[]): string[] {
  return files
    .filter(
      (f) =>
        !f.startsWith('.hive/') &&
        !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f),
    )
    .slice(0, LEARNING_FILES_MAX);
}

/**
 * US-F5.2 — sinais que o loop JÁ TEM ao fim de uma iteração, para derivar o
 * `outcome` do memory doc (o agent não sabe se o que aprendeu deu certo; o
 * loop sabe). Duas formas, uma por call site:
 *  - `iteration`  — fases reproduce/analysis/implementation (bloco de
 *    learnings do fluxo normal): `canFinish` = a task pôde concluir (done
 *    crível: DOD todo fechado ou diff real); `phantomClaim` = o guard
 *    anti-progresso-fantasma REJEITOU a reivindicação da iteração
 *    (affectedFlows sem diff — "fluxo inválido") e exigiu nova rodada.
 *  - `validation` — fase de validação: `passed` = gate de done satisfeito
 *    (`effectivePassed`, task fecha Done); `escalated` = o loop desistiu de
 *    derivar e escalou a humano (sem saída).
 */
export type LearningSignal =
  | { kind: 'iteration'; canFinish: boolean; phantomClaim: boolean }
  | { kind: 'validation'; passed: boolean; escalated: boolean };

/**
 * US-F5.2 — mapeia o sinal real do loop para o vocabulário de outcome do
 * graphify (`useful` = +1, `dead_end`/`corrected` = −1 no `graphify reflect`):
 *  - `useful`    — a iteração fechou com o DOD satisfeito / a validação
 *    passou e a task pôde concluir;
 *  - `corrected` — o loop exigiu nova rodada: validação reprovou (task
 *    derivada de correção / dedup de derivação) ou a reivindicação da
 *    iteração era fantasma (fluxo declarado sem diff);
 *  - `dead_end`  — a validação reprovou E o loop escalou a humano sem saída
 *    (cap de falhas/profundidade/derivações);
 *  - `undefined` — iteração intermediária SEM sinal conclusivo: o doc sai sem
 *    `outcome` (bucket `unmarked` do reflect, peso 0). Melhor ausência de
 *    sinal do que rótulo chutado — um outcome errado envenena o overlay.
 * Pura; exportada para as specs.
 */
export function deriveLearningOutcome(signal: LearningSignal): MemoryOutcome | undefined {
  if (signal.kind === 'validation') {
    if (signal.passed) return 'useful';
    return signal.escalated ? 'dead_end' : 'corrected';
  }
  if (signal.canFinish) return 'useful';
  return signal.phantomClaim ? 'corrected' : undefined;
}

/**
 * US-F2.7 — profundidade da travessia do blast radius (`POST /affected`).
 * MEDIDO no grafo real do kanban-ai (3484 nós / 6295 arestas): por seed,
 * depth 1→2 quase dobra os hits (validation.runner 16→29; config.ts 71→109;
 * realtime 45→67) e os hits extras são dependentes INDIRETOS — arquivos cuja
 * ligação com a mudança passa por um arquivo que NÃO mudou; os specs deles
 * raramente exercitam o diff. Depth 1 = importadores/chamadores diretos, que
 * é exatamente o que a validação por fluxo consegue exercitar.
 */
const AFFECTED_FLOW_DEPTH = 1;

/**
 * US-F2.7 — teto de arquivos no fluxo derivado. Iterações reais medidas dão
 * 1–19 arquivos em depth 1 (o pior caso é seed em hub, ex.: orchestrator.ts);
 * o ranking por nº de hits mantém os dependentes mais acoplados e o teto 10
 * (paridade com LEARNING_FILES_MAX) segura o hub sem virar ruído — 167 hits
 * num fluxo não ajudam a validação a exercitar nada.
 */
const AFFECTED_FLOW_MAX_FILES = 10;

/** US-F2.7 — nome estável do fluxo derivado (merge por nome acumula entre iterações). */
export const AFFECTED_FLOW_DERIVED_NAME = 'blast radius (grafo)';

/**
 * US-F2.7 — o CORTE do blast radius: agrega hits por ARQUIVO (a validação por
 * fluxo opera em arquivos, não em nós) e ranqueia por proximidade (depth asc),
 * acoplamento (nº de hits desc — quantos nós do arquivo dependem da mudança)
 * e path (desempate determinístico). Exclui o que não é "afetado":
 *  - os próprios arquivos tocados (são a mudança, não o raio);
 *  - `.hive/` (neurônios são "aprendizado relacionado", não código afetado —
 *    mesma razão pela qual `describes` fica FORA das relações da travessia);
 *  - hits sem arquivo (nós externos/sintéticos).
 * Pura; exportada para as specs. O teto é aplicado pelo chamador DEPOIS do
 * filtro de existência no worktree.
 */
export function rankAffectedFiles(
  changed: readonly string[],
  hits: readonly { file: string | null; depth: number }[],
): { file: string; hits: number; depth: number }[] {
  const changedSet = new Set(changed);
  const agg = new Map<string, { file: string; hits: number; depth: number }>();
  for (const h of hits) {
    if (!h.file || changedSet.has(h.file) || h.file.startsWith('.hive/')) continue;
    const cur = agg.get(h.file);
    if (cur) {
      cur.hits += 1;
      cur.depth = Math.min(cur.depth, h.depth);
    } else {
      agg.set(h.file, { file: h.file, hits: 1, depth: h.depth });
    }
  }
  return [...agg.values()].sort(
    (a, b) => a.depth - b.depth || b.hits - a.hits || a.file.localeCompare(b.file),
  );
}

@Injectable()
export class Orchestrator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Orchestrator.name);
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();
  private readonly autoTimers = new Map<string, NodeJS.Timeout>();
  private readonly stopRequested = new Map<string, StopMode>();
  // Guarda contra iterações concorrentes na MESMA story: enquanto uma iteração
  // está em execução (inclusive parada em awaiting-input à espera de HITL), o
  // auto-play não deve iniciar outra — senão a pergunta pendente seria
  // substituída. Ver ADR-0018.
  private readonly inFlight = new Set<string>();
  /** US-ROB4: tick global de recuperação de claims vencidos (SEM Redis). */
  private claimSweepTimer: NodeJS.Timeout | null = null;
  /** US-OBS2-4: tick global do scan de no-comment streak (SEM Redis). */
  private streakScanTimer: NodeJS.Timeout | null = null;
  /** US-SCHED1: tick global de monitors deferred (time-gated wakeup). */
  private monitorTickTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AgentSessionManager,
    private readonly validation: ValidationRunner,
    private readonly workspaces: WorkspaceService,
    private readonly realtime: RealtimeService,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // US-COLAB3 — wakeup queue durável (opcional para não quebrar as specs que
    // instanciam o Orchestrator com os 10 params anteriores). Usado apenas
    // quando `config.agent.wakeupQueueEnabled` está ON, sempre com try/catch
    // defensivo: uma falha na fila NUNCA pode derrubar o loop.
    private readonly wakeupQueue?: WakeupQueueService,
    // US-PROJ4 — resolução do repo-alvo via Project (clone gerenciado). Opcional
    // e por último para não quebrar as specs que instanciam o Orchestrator
    // posicionalmente sem Project. Quando ausente (ou o Board não tem
    // `projectId`), a resolução cai no fallback legado `aiProject`.
    private readonly projectWorkspace?: ProjectWorkspaceService,
    // US-OBS2-4 — registro rate-limitado/snooze-aware de review actions
    // (no-comment streak). Opcional/por último para não quebrar as specs que
    // instanciam o Orchestrator posicionalmente; o scan é no-op quando ausente.
    @Optional() private readonly reviewActions?: ReviewActionService,
    // US-F1.5 — rebuild incremental do grafo (graphify) ao fim da iteração.
    // `@Optional() x?: T` (NUNCA `x: T | null = null` — armadilha de DI
    // documentada em projects/AGENTS.md); no-op quando ausente ou com a env
    // GRAPHIFY_INCREMENTAL_REBUILD desligada (default).
    @Optional() private readonly projectGraph?: ProjectGraphService,
    // US-F3.10 — cascata de adapter: o runner passa a ser resolvido POR CARD a
    // partir do adapter efetivo (task → story → epic → board.defaultAdapter →
    // global). `@Optional() x?: T` (armadilha de DI, projects/AGENTS.md); quando
    // ausente (specs que instanciam posicionalmente), o dispatch cai no runner
    // do token `AGENT_RUNNER` (o global do boot) — comportamento pré-F3.10.
    @Optional() private readonly adapterRegistry?: AgentAdapterRegistry,
    // US-F2.5 — recall de memória por TRAVESSIA DE GRAFO (leitura via MCP do
    // sidecar graphify). `@Optional() x?: T` (armadilha de DI, projects/
    // AGENTS.md); no-op quando ausente ou com GRAPHIFY_MEMORY_RECALL desligada
    // — desde a US-F2.3 a iteração então roda SEM memória (o LIKE morreu).
    @Optional() private readonly graphQuery?: ProjectGraphQueryService,
    // US-F2.3 — a colmeia vive no clone (`<clone>/.hive/**.md`, fonte da
    // verdade desde a deleção do git da memória): `persistLearning` escreve e
    // `appendNeuronBodies` lê via este serviço. `@Optional() x?: T` (armadilha
    // de DI, projects/AGENTS.md); ausente nas specs posicionais → a escrita de
    // learning vira perda VISÍVEL (Activity), nunca exceção.
    @Optional() private readonly projectHive?: ProjectHiveService,
  ) {}

  /** US-COLAB3 — a fila só age quando o flag está ON e o serviço foi injetado. */
  private get wakeupEnabled(): boolean {
    return this.config.agent.wakeupQueueEnabled && !!this.wakeupQueue;
  }

  /**
   * US-COLAB3 — enfileira (coalescendo) um wakeup durável para a story. Resolve
   * o epicId para a serialização por epic. Totalmente defensivo e no-op quando o
   * flag está OFF: nunca lança, nunca bloqueia o gatilho legado.
   */
  async enqueueWakeup(storyId: string, reason: WakeupReason): Promise<void> {
    if (!this.wakeupEnabled) return;
    try {
      const epicId = await this.resolveStoryEpic(storyId);
      await this.wakeupQueue!.enqueue({ storyId, reason, epicId });
    } catch (err) {
      this.logger.warn(
        `wakeupQueue.enqueue falhou (story=${storyId}, reason=${reason}): ${(err as Error).message}`,
      );
    }
  }

  /** Salvaguarda #1: reconciliação no boot. */
  async onModuleInit(): Promise<void> {
    // US-ROB4: TTL do lease DEVE ser > intervalo do watchdog, senão o watchdog
    // recuperaria sessões vivas antes do heartbeat renovar.
    if (
      this.config.agent.claimEnabled &&
      this.config.agent.claimTtlMs <= this.config.agent.watchdogIntervalMs
    ) {
      this.logger.warn(
        `AGENT_CLAIM_TTL_MS (${this.config.agent.claimTtlMs}ms) <= ` +
          `AGENT_WATCHDOG_INTERVAL_MS (${this.config.agent.watchdogIntervalMs}ms): ` +
          'o lease pode vencer antes do heartbeat renovar. Aumente o TTL.',
      );
    }
    await this.reconcileOnBoot();
    this.startClaimSweep(); // US-ROB4: recuperação periódica de claims vencidos
    this.startNoCommentStreakScan(); // US-OBS2-4: scan periódico de anomalia
    this.startMonitorTick(); // US-SCHED1: tick de monitors deferred
  }

  onModuleDestroy(): void {
    if (this.claimSweepTimer) {
      clearInterval(this.claimSweepTimer);
      this.claimSweepTimer = null;
    }
    if (this.streakScanTimer) {
      clearInterval(this.streakScanTimer);
      this.streakScanTimer = null;
    }
    if (this.monitorTickTimer) {
      clearInterval(this.monitorTickTimer);
      this.monitorTickTimer = null;
    }
  }

  /**
   * US-ROB4 — tick GLOBAL de recuperação de claims vencidos (espelha
   * `MemorySchedulerService.sweepLocks`): puro `setInterval` com `unref()` e
   * `try/catch` por job (nunca derruba o processo). Recupera stories cujo
   * watchdog por-story já não existe (ex.: sessão perdida num restart).
   */
  private startClaimSweep(): void {
    if (!this.config.agent.claimEnabled || this.claimSweepTimer) return;
    const handle = setInterval(() => {
      void this.recoverStaleClaims().catch((err) =>
        this.logger.warn(`claimSweep: ${(err as Error).message}`),
      );
    }, this.config.agent.watchdogIntervalMs);
    handle.unref?.();
    this.claimSweepTimer = handle;
  }

  /**
   * US-OBS2-4 — tick GLOBAL do scan de "no-comment streak". Espelha
   * `startClaimSweep` (puro `setInterval` com `unref()` + `try/catch`, cadência =
   * `watchdogIntervalMs`, SEM Redis — invariante 7), mas roda SEMPRE (independe
   * de `claimEnabled`) e SÓ quando a detecção está ligada
   * (`noCommentStreakThreshold > 0`) e o `ReviewActionService` foi injetado.
   * NÃO move/cancela stories — apenas sinaliza uma REVIEW ACTION visível.
   */
  private startNoCommentStreakScan(): void {
    if (this.streakScanTimer) return;
    if (!this.reviewActions) return;
    if (this.config.agent.noCommentStreakThreshold <= 0) return;
    const handle = setInterval(() => {
      void this.scanNoCommentStreaks().catch((err) =>
        this.logger.warn(`noCommentStreakScan: ${(err as Error).message}`),
      );
    }, this.config.agent.watchdogIntervalMs);
    handle.unref?.();
    this.streakScanTimer = handle;
  }

  /**
   * US-OBS2-4 — varre as stories em "In Progress" e, para cada uma, roda o
   * detector PURO `detectNoCommentStreak` sobre as iterações das tasks da story.
   * Se o streak for anômalo, registra uma REVIEW ACTION (rate-limitada e
   * snooze-aware via `ReviewActionService.record`) e emite `review.action_flagged`.
   *
   * NÃO duplica watchdog (stuck-sla) nem anti-thrash — é observabilidade pura.
   * NÃO move/cancela/transiciona a story. Best-effort: uma falha por story nunca
   * derruba o scan das demais.
   */
  private async scanNoCommentStreaks(nowMs = Date.now()): Promise<void> {
    if (!this.reviewActions) return;
    const threshold = this.config.agent.noCommentStreakThreshold;
    if (threshold <= 0) return;

    let stories: Array<{ id: string }> = [];
    try {
      stories = await this.prisma.card.findMany({
        where: {
          type: 'story',
          boardColumn: { is: { title: { equals: 'In Progress', mode: 'insensitive' } } },
        },
        select: { id: true },
      });
    } catch (err) {
      this.logger.warn(`scanNoCommentStreaks: leitura de stories falhou: ${(err as Error).message}`);
      return;
    }

    for (const story of stories) {
      try {
        await this.scanStoryNoCommentStreak(story.id, threshold, nowMs);
      } catch (err) {
        this.logger.warn(
          `scanNoCommentStreaks: story=${story.id} falhou (segue): ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * US-OBS2-4 — roda o detector para UMA story. As iterações vivem por TASK
   * (`Iteration.cardId` sempre uma task); reunimos as iterações das tasks-filhas
   * da story em ORDEM CRONOLÓGICA e derivamos o sinal "voltado ao humano" de cada
   * uma: `summary`/`handoffNextStep` não-vazios OU escalação (`handoffState`
   * bloqueado/`done` NÃO conta como no-comment porque carrega intenção; a
   * escalação `blocked` é tratada como sinal ao humano). A story marcada
   * `needsHuman` em qualquer task recente também reseta o streak dessa task.
   */
  private async scanStoryNoCommentStreak(
    storyId: string,
    threshold: number,
    nowMs: number,
  ): Promise<void> {
    const tasks = await this.prisma.card.findMany({
      where: { parentId: storyId, type: 'task' },
      select: { id: true },
    });
    if (tasks.length === 0) return;

    // Consideramos a task mais ATIVA (com iteração mais recente). Um streak de
    // "escuro" é sobre a task que o agent está de fato iterando.
    const taskIds = tasks.map((t) => t.id);
    const rows = await this.prisma.iteration.findMany({
      where: { cardId: { in: taskIds } },
      orderBy: { ts: 'asc' },
      select: {
        cardId: true,
        summary: true,
        handoffNextStep: true,
        handoffState: true,
      },
    });
    if (rows.length === 0) return;

    // Agrupa por task e escolhe a task com a iteração mais recente.
    const byTask = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byTask.get(r.cardId);
      if (arr) arr.push(r);
      else byTask.set(r.cardId, [r]);
    }
    const activeTaskId = rows[rows.length - 1].cardId;
    const activeIterations = byTask.get(activeTaskId) ?? [];

    // Deriva os sinais para o detector puro. `handoffState === 'blocked'` é uma
    // escalação voltada ao humano (reseta o streak).
    const signals = activeIterations.map((it) => ({
      summary: it.summary,
      handoffNextStep: it.handoffNextStep,
      needsHuman: (it.handoffState ?? '').trim().toLowerCase() === 'blocked',
    }));

    const result = detectNoCommentStreak(signals, { threshold });
    if (!result.anomalous) return;

    const flagged = await this.reviewActions!.record(
      {
        cardId: storyId,
        kind: 'no_comment_streak',
        detail: { streak: result.streak, threshold, storyId, taskId: activeTaskId },
      },
      nowMs,
    );
    if (flagged) {
      this.logger.log(
        `no-comment streak sinalizado: story=${storyId} task=${activeTaskId} streak=${result.streak} (>= ${threshold})`,
      );
    }
  }

  /**
   * US-SCHED1 — tick GLOBAL de monitors deferred (time-gated wakeup). Espelha
   * `startClaimSweep`/`startNoCommentStreakScan`: puro `setInterval` com
   * `unref()` + `try/catch` por job, cadência = `watchdogIntervalMs`, SEM Redis
   * (invariante 7). Gated por `wakeupEnabled` (no-op quando fila desligada ou
   * ausente).
   */
  private startMonitorTick(): void {
    if (this.monitorTickTimer) return;
    if (!this.wakeupEnabled) return;
    const handle = setInterval(() => {
      void this.fireDueMonitors().catch((err) =>
        this.logger.warn(`monitorTick: ${(err as Error).message}`),
      );
    }, this.config.agent.watchdogIntervalMs);
    handle.unref?.();
    this.monitorTickTimer = handle;
  }

  /**
   * US-SCHED1 — varre a fila de wakeup em busca de monitors cujo `scheduledFor`
   * já passou (time-gated: `now >= scheduledFor`). Para cada um, dispara o wake
   * via `onStoryEnterInProgress` (mecanismo canônico) e limpa o monitor (one-
   * shot). Defensivo: uma falha por monitor nunca derruba o tick das demais.
   */
  private async fireDueMonitors(now = new Date()): Promise<void> {
    if (!this.wakeupQueue) return;
    let due: Array<{ storyId: string; reason: WakeupReason; epicId: string | null }> = [];
    try {
      due = await this.wakeupQueue.listDue(now);
    } catch (err) {
      this.logger.warn(`fireDueMonitors: leitura de due falhou: ${(err as Error).message}`);
      return;
    }
    const monitors = due.filter((item) => item.reason === 'monitor_due');
    for (const mon of monitors) {
      try {
        this.logger.log(`monitor_due disparando wake: story=${mon.storyId}`);
        // Dispara o wake via mecanismo canônico (respeita serialização/concorrência).
        await this.onStoryEnterInProgress(mon.storyId);
        // One-shot: limpa o monitor após disparo (o agent pode re-armar se ainda
        // estiver esperando).
        await this.wakeupQueue.clearMonitor(mon.storyId);
      } catch (err) {
        this.logger.warn(`fireDueMonitors story=${mon.storyId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * US-SCHED1 — arma um monitor deferred (time-gated wake) para uma story. O
   * agent PARK (espera um evento externo) e acorda automaticamente no
   * `scheduledFor`. One-shot: dispara UMA vez e auto-clear; o agent pode re-
   * armar se ainda estiver esperando. Defensivo: no-op se a fila está ausente.
   */
  async setMonitor(
    storyId: string,
    opts: {
      scheduledFor: Date;
      notes?: string;
      timeoutAt?: Date;
      maxAttempts?: number;
    },
  ): Promise<void> {
    if (!this.wakeupQueue) {
      this.logger.warn(`setMonitor: fila ausente, monitor ignorado (story=${storyId})`);
      return;
    }
    const epicId = await this.resolveStoryEpic(storyId);
    try {
      await this.wakeupQueue.enqueueDeferred({
        storyId,
        epicId,
        scheduledFor: opts.scheduledFor,
        notes: opts.notes,
        timeoutAt: opts.timeoutAt,
        maxAttempts: opts.maxAttempts,
      });
      this.logger.log(
        `monitor armado: story=${storyId} scheduledFor=${opts.scheduledFor.toISOString()}`,
      );
    } catch (err) {
      this.logger.warn(`setMonitor story=${storyId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * US-SCHED1 — limpa/cancela o monitor pendente de uma story (one-shot clear).
   * Útil quando o agent decide que não precisa mais esperar. Defensivo: no-op se
   * a fila está ausente.
   */
  async clearMonitor(storyId: string): Promise<void> {
    if (!this.wakeupQueue) {
      this.logger.warn(`clearMonitor: fila ausente, clear ignorado (story=${storyId})`);
      return;
    }
    try {
      await this.wakeupQueue.clearMonitor(storyId);
      this.logger.log(`monitor cleared: story=${storyId}`);
    } catch (err) {
      this.logger.warn(`clearMonitor story=${storyId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Ao subir, varre stories em coluna "In Progress" no Postgres e recria o
   * auto-play. O estado de verdade é o banco, não a memória.
   */
  async reconcileOnBoot(): Promise<void> {
    // US-ROB4 — recovery no boot: libera claims vencidos antes de reconciliar
    // (unifica recovery boot + runtime). No-op se claimEnabled=false.
    await this.recoverStaleClaims();

    // US-COLAB3 — recovery da wakeup queue: reabre itens `claimed` órfãos (a
    // sessão in-process morreu com a API) devolvendo-os para `pending`, para que
    // sejam reprocessados abaixo. Defensivo e no-op quando o flag está OFF.
    if (this.wakeupEnabled) {
      try {
        const reopened = await this.wakeupQueue!.recoverOnBoot();
        if (reopened.length) {
          this.logger.log(
            `reconcileOnBoot() — wakeup queue: ${reopened.length} item(ns) claimed órfão(s) reabertos`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `reconcileOnBoot() — wakeupQueue.recoverOnBoot falhou (segue): ${(err as Error).message}`,
        );
      }
    }

    // US-ROB2 — leitura DURÁVEL: antes de re-escanear as colunas, lê a tabela
    // AgentRuntimeState para (a) saber quais sessões existiam antes do restart e
    // (b) marcar como `stalled` as que perderam o processo (base do recovery por
    // lease — US-ROB4). Totalmente defensivo: falha aqui NÃO impede o re-scan.
    let persistedByStory = new Map<string, { livenessState: string }>();
    if (this.config.agent.runtimePersistEnabled) {
      try {
        const rows = await this.prisma.agentRuntimeState.findMany({
          where: { livenessState: { in: ['starting', 'alive', 'stalled'] } },
          select: { storyId: true, livenessState: true },
        });
        persistedByStory = new Map(rows.map((r) => [r.storyId, { livenessState: r.livenessState }]));
        if (rows.length) {
          this.logger.log(
            `reconcileOnBoot() — ${rows.length} sessão(ões) durável(is) encontrada(s) no boot`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `reconcileOnBoot() — leitura durável falhou (segue com re-scan): ${(err as Error).message}`,
        );
      }
    }

    const stories = await this.prisma.card.findMany({
      where: {
        type: 'story',
        boardColumn: { is: { title: { equals: 'In Progress', mode: 'insensitive' } } },
      },
      select: { id: true },
    });

    // US-ROB2 — stories que tinham sessão durável mas NÃO estão mais In Progress
    // (perderam o processo/coluna): marca como `stalled` para o watchdog/lease.
    const activeIds = new Set(stories.map((s) => s.id));
    for (const [storyId, row] of persistedByStory) {
      if (!activeIds.has(storyId) && row.livenessState !== 'stalled') {
        try {
          await this.prisma.agentRuntimeState.update({
            where: { sessionId: storyId },
            data: { livenessState: 'stalled' },
          });
          this.logger.warn(
            `reconcileOnBoot() — sessão durável story=${storyId} sem story ativa; marcada stalled`,
          );
        } catch {
          /* defensivo: ignora — não pode derrubar o boot */
        }
      }
    }

    if (stories.length === 0) {
      this.logger.log('reconcileOnBoot() — nenhuma story ativa');
      return;
    }
    for (const story of stories) {
      this.logger.log(`reconcileOnBoot() — retomando loop da story=${story.id}`);
      // US-COLAB3: enfileira (coalesce) um wakeup `reconcile` para a story em
      // In Progress achada no board, convergindo fila + board no boot.
      await this.enqueueWakeup(story.id, 'reconcile');
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

    // SERIALIZAÇÃO por EPIC: o loop engine trabalha uma story por epic de cada
    // vez (stories do MESMO epic são serializadas). Stories de épicos DIFERENTES
    // rodam concorrentes, respeitando apenas o limite global de sessões. Quando
    // `serializeByRepo` está ligado (worktree isolado ainda é stub — ADR-0019),
    // reforçamos com o guard-rail legado de "uma story por repo-alvo físico".
    const conflictStoryId = await this.findConflictingActiveStory(storyId);
    if (conflictStoryId) {
      this.logger.warn(
        `Serialização: story=${storyId} conflita com story=${conflictStoryId} ` +
          '(já ativa no mesmo epic/repo-alvo). Adiando até a outra concluir.',
      );
      await this.log(
        storyId,
        `aguardando serialização — outra story (${conflictStoryId}) já está ativa no mesmo ` +
          'epic (ou repositório-alvo). Esta story iniciará quando a anterior sair de In Progress.',
      );
      return;
    }

    const session = this.sessions.start(storyId);
    void this.claimStory(storyId); // US-ROB4: adquire o lease da execução
    // US-COLAB3: reivindica o wakeup durável desta story (se houver na fila).
    // Defensivo/no-op quando o flag está OFF. A fila coalesce, então mesmo que o
    // gatilho não tenha enfileirado (ex.: reconcile), o claim é idempotente.
    if (this.wakeupEnabled) {
      void this.wakeupQueue!
        .claim(storyId)
        .catch((err) =>
          this.logger.warn(`wakeupQueue.claim falhou (story=${storyId}): ${(err as Error).message}`),
        );
    }
    this.realtime.broadcast({
      type: 'agent.session.state_changed',
      storyId,
      sessionId: session.sessionId,
      state: session.state,
    });

    this.startWatchdog(storyId);
    await this.log(storyId, 'história em In Progress — motor de AI acordado');

    // BUG-08 / IMP-01: uma story SEM tasks filhas faria o auto-play encerrar
    // graceful e silencioso (stepStory retorna false com tasks.length===0),
    // dando a impressão de que "nada aconteceu". Em vez disso, damos feedback
    // explícito: marcamos a story como `needsHuman` e emitimos `card.needs_human`
    // para a UI exibir o badge "Precisa de você" com um motivo acionável.
    // Encerramos limpo, sem gastar tokens numa iteração impossível.
    const tasks = await this.loadStoryTasks(storyId);
    if (tasks.length === 0) {
      const reason =
        'Story sem tasks: o loop engine não tem o que executar. ' +
        'Adicione ao menos uma task (nas colunas Backlog/To Do) e mova a story ' +
        'para In Progress novamente.';
      await this.prisma.card.update({
        where: { id: storyId },
        data: { needsHuman: true, needsHumanReason: reason },
      });
      this.realtime.broadcast({
        type: 'card.needs_human',
        taskId: storyId,
        storyId,
        reason,
      });
      await this.log(storyId, reason);
      this.finishAuto(storyId, 'graceful');
      return;
    }

    // US-A5 (EP-A/ADR-0027) / US-F2.9 — preparação do repo-alvo + arranque do
    // auto-play (a semeadura de neurônios que vivia aqui morreu na US-F2.9).
    //
    // IMPORTANTE (fix boot-hang): a cauda resolve o repo-alvo via
    // `resolveStoryTargetRepo`, que para Boards com Project dispara
    // `ensureCloned` — um `git clone` que pode ser LENTO (repo grande) ou até
    // travar (auth/rede). Se aguardássemos isso aqui, e como `onStoryEnterInProgress`
    // é AWAITED por `reconcileOnBoot` (que por sua vez é awaited no
    // `onModuleInit`), o clone BLOQUEARIA o boot inteiro do Nest — o servidor
    // HTTP nunca começaria a ouvir e `GET /health` recusaria conexão até o clone
    // terminar. Por isso a cauda lenta (clone + `startAuto`) roda
    // em BACKGROUND: a sessão/watchdog já foram criados de forma síncrona acima,
    // então o estado observável (registry, WS) fica consistente imediatamente e o
    // loop arranca assim que o clone concluir.
    void this.bootstrapAndStartAuto(storyId);
  }

  /**
   * Cauda NÃO-BLOQUEANTE de `onStoryEnterInProgress`: garante o clone do
   * repo-alvo e então arranca o auto-play. Roda em background porque
   * `resolveStoryTargetRepo` pode fazer um `git clone` lento; ver a nota em
   * `onStoryEnterInProgress`.
   *
   * US-F2.9 — a SEMEADURA de 1 neurônio vazio por módulo (US-213,
   * `bootstrapFromRepo`) saiu daqui: com o recall por grafo (cutover na
   * US-F2.10), o grafo do código já dá o mapa do repo ao agent — colmeia
   * nascer vazia deixou de ser "começar cego". O neurônio nasce LAZY na
   * primeira escrita real de learning (memory doc canônico da US-F5.1 em
   * `persistLearning`); semear boilerplate só materializava páginas-ruído em
   * `.hive/` → grafo → prompt do recall.
   */
  private async bootstrapAndStartAuto(storyId: string): Promise<void> {
    try {
      // O resolve FICA mesmo sem bootstrap: é ele que dispara `ensureCloned`
      // (clone gerenciado do Project) antes do startAuto — o motivo original
      // desta cauda rodar em background.
      await this.resolveStoryTargetRepo(storyId);
    } catch (err) {
      this.logger.warn(
        `Falha ao preparar o repo-alvo para story=${storyId}: ${(err as Error).message}`,
      );
    }

    // Guard de corrida (fix boot-hang): como esta cauda roda em background, a
    // story pode ter SAÍDO de In Progress (stop/leave) enquanto o clone/bootstrap
    // estava em andamento. Nesse caso a sessão já foi removida — NÃO reabrir o
    // auto-play (senão vaza um timer e ressuscita uma sessão fantasma).
    if (!this.sessions.get(storyId)) {
      this.logger.debug(
        `bootstrapAndStartAuto: sessão de story=${storyId} sumiu durante o bootstrap; auto-play não iniciado`,
      );
      return;
    }
    this.startAuto(storyId);
  }

  /**
   * Disparado quando uma story SAI de "In Progress" (arrastada para Done,
   * Review, To Do, Backlog, etc.). BUG-A8: sem este hook simétrico ao
   * `onStoryEnterInProgress`, a sessão em memória permanecia no registry mesmo
   * após a story sair de In Progress (o `finishAuto` só era chamado pelo próprio
   * loop ao concluir todas as tasks ou pelo watchdog). Uma story concluída e
   * movida para Done — ou qualquer saída manual — deixava a sessão "fantasma"
   * viva, e `findConflictingActiveStory` bloqueava indefinidamente qualquer
   * outra story do mesmo epic (ou repo-alvo) até reiniciar a API.
   *
   * Agora liberamos o slot explicitamente: `finishAuto` para o auto-play,
   * remove a sessão, limpa o watchdog e destrava (via `resumeDeferredForStory`)
   * a próxima story pendente do mesmo epic/repo-alvo. Idempotente: se não houver
   * sessão/timer, é no-op.
   */
  onStoryLeaveInProgress(storyId: string): void {
    const hasSession = !!this.sessions.get(storyId);
    const hasTimer = this.autoTimers.has(storyId);
    if (!hasSession && !hasTimer) return; // nada a liberar
    this.finishAuto(storyId, 'graceful');
  }

  /**
   * Retorna o id de uma story JÁ ativa (sessão em execução) que conflita com a
   * `storyId` dada, ou `null` se não houver conflito. Conflito = mesma story do
   * MESMO epic (serialização por epic). Quando `config.agent.serializeByRepo`
   * está ligado, também conflita se compartilhar o MESMO repo-alvo físico
   * (guard-rail legado para o cenário sem worktree isolado — ADR-0019).
   * Stories de épicos diferentes só concorrem pelo limite global de sessões.
   */
  private async findConflictingActiveStory(storyId: string): Promise<string | null> {
    const epicId = await this.resolveStoryEpic(storyId);
    const target = this.config.agent.serializeByRepo
      ? await this.resolveStoryProject(storyId)
      : null;
    if (!epicId && !target) return null;
    for (const activeId of this.sessions.activeStoryIds()) {
      if (activeId === storyId) continue;
      if (epicId) {
        const otherEpic = await this.resolveStoryEpic(activeId);
        if (otherEpic && otherEpic === epicId) return activeId;
      }
      if (target) {
        const otherTarget = await this.resolveStoryProject(activeId);
        if (otherTarget && otherTarget === target) return activeId;
      }
    }
    return null;
  }

  /**
   * Resolve o id do epic (card pai) de uma story — a âncora de serialização.
   * Retorna null se a story não tiver `parentId` (story órfã, sem epic).
   */
  private async resolveStoryEpic(storyId: string): Promise<string | null> {
    const story = await this.prisma.card.findUnique({
      where: { id: storyId },
      select: { parentId: true },
    });
    return story?.parentId ?? null;
  }

  /**
   * US-PROJ4 — resolve o `projectId` do Board da story. O repo-alvo é
   * propriedade do QUADRO (raiz da cascata, como `defaultModel`), então a origem
   * é o Board da story (`Card.boardId` → `Board.projectId`), não o Card. Retorna
   * `null` quando o Board não tem Project associado (fallback legado `aiProject`).
   */
  private async resolveStoryProjectId(storyId: string): Promise<string | null> {
    const story = await this.prisma.card.findUnique({
      where: { id: storyId },
      select: { boardId: true },
    });
    if (!story?.boardId) return null;
    const board = await this.prisma.board.findUnique({
      where: { id: story.boardId },
      select: { projectId: true },
    });
    return board?.projectId ?? null;
  }

  /**
   * US-PROJ4 — resolve o caminho absoluto do repo-alvo de uma story para o
   * `cwd` do agent e o `repoPath` da memória.
   *
   * NOVO caminho (Project): se o Board da story tem `projectId` e o
   * `ProjectWorkspaceService` está disponível, GARANTE o clone gerenciado
   * (`ensureCloned` — clona se ainda não existe) e usa o `localPath` retornado.
   * **Ordenação crítica:** `ensureCloned` roda ANTES de `resolveWorkdir`, senão o
   * worktree falharia por path inexistente.
   *
   * FALLBACK legado (`aiProject`): sem `projectId` (ou sem o serviço injetado),
   * mantém a resolução por path da story→epic, idêntica ao comportamento de hoje.
   *
   * Retorna `null` quando nada resolve (nem Project nem `aiProject`).
   */
  private async resolveStoryTargetRepo(storyId: string): Promise<string | null> {
    const projectId = await this.resolveStoryProjectId(storyId);
    if (projectId && this.projectWorkspace) {
      // Clone gerenciado: ENGINE faz git (invariante 8 — o agent nunca faz git).
      // ensureCloned coalesce chamadas concorrentes por projectId (invariante 7).
      const localPath = await this.projectWorkspace.ensureCloned(projectId);
      return this.workspaces.resolveTargetRepo(localPath);
    }
    return this.resolveLegacyAiProject(storyId);
  }

  /**
   * US-F2.6 → US-F2.3 (EP-F2) — persiste UM learning na colmeia do CLONE, sem
   * descarte silencioso.
   *
   * O substrato mudou na US-F2.3 (deleção do git da memória, emenda da
   * US-F2.10 no ADR-0027): o neurônio é um arquivo simples em
   * `<clone>/.hive/<learning.path>` e a escrita é o `mutateHiveFile` do
   * `ProjectHiveService` — read-modify-write SÍNCRONO (sem lost-update
   * in-process, ver doc daquele serviço) com rename atômico. O aparato antigo
   * (CAS por baseCommit, ramo efêmero, merge 3-way, retry de
   * `MemoryWriteConflictError`) protegia escritores CONCORRENTES EXTERNOS,
   * que deixaram de existir com o control plane (decisão do dono, F2.8 §2.1):
   * a API é a única escritora, serializada pelo próprio loop.
   *
   * US-F5.1 (EP-F5) — o formato mudou para o memory doc CANÔNICO do graphify
   * (`save_query_result`/`parse_memory_doc`): cada learning vira UM doc em
   * `<clone>/.hive/memory/` (plano — o `reflect` faz glob não-recursivo), com
   * `question` = título da task (o que se estava tentando fazer), `answer` =
   * resumo do agent e `source_nodes` = IDs DE NÓ dos arquivos tocados
   * (receita `fileNodeId`, a mesma do `_file_node_id` do graphify). A antiga
   * aresta sintética `describes` morreu junto (não existe no vocabulário do
   * graphify): a ligação neurônio→código agora é `source_nodes`, agregada
   * nativamente pelo `graphify reflect` (chamada dele é a US-F5.2).
   * `learning.path` reportado pela IA deixou de determinar o local do arquivo
   * (o nome nasce de `memoryDocFilename`, interno e seguro).
   *
   * O que fica da US-F2.6 (o ponto da história era a VISIBILIDADE):
   *  - perda DEFINITIVA (Board sem Project, clone ausente ou I/O falhou)
   *    vira **Activity no card** — o operador vê o resumo perdido
   *    e pode regravar; NUNCA lança (memória jamais derruba o loop);
   *  - sucesso agenda o rebuild incremental do grafo com o `.hive/…` escrito
   *    (o substituto do `syncHive` da US-F2.4: quem escreve avisa o grafo).
   *
   * Board legado sem Project: com o git da memória deletado não existe mais
   * colmeia global — o learning é registrado como perda visível no card
   * (mesmo canal), com o resumo completo. Perda consciente: o recall desses
   * boards também não existe mais (o grafo exige Project).
   */
  private async persistLearning(
    taskId: string,
    learning: { path: string; summary: string; scope?: string },
    projectId: string | null,
    files: string[],
    // US-F5.2 — o sinal REAL do loop (ver `deriveLearningOutcome`): `useful`
    // quando a iteração fechou/validou, `corrected` quando o loop exigiu nova
    // rodada, `dead_end` quando escalou sem saída. `undefined` = sem sinal
    // conclusivo → o doc sai SEM `outcome` (bucket `unmarked` do reflect,
    // peso 0) — ausência é melhor que rótulo invertido.
    outcome: MemoryOutcome | undefined,
  ): Promise<boolean> {
    let reason = 'erro desconhecido';
    try {
      if (projectId && this.projectHive) {
        // question = o que se estava tentando fazer — título da task, na
        // prática (contrato do memory doc, US-F5.1). Fallback: o id.
        const card = await this.prisma.card
          .findUnique({ where: { id: taskId }, select: { title: true } })
          .catch(() => null);
        const now = new Date();
        const doc = serializeMemoryDoc({
          type: 'learning',
          date: now.toISOString(),
          question: card?.title ?? taskId,
          // `scope` (módulo, quando a IA o reporta) vai no corpo — o reflect
          // só agrega o frontmatter, mas o corpo round-tripa no grafo.
          answer: learning.scope
            ? `${learning.summary.trim()}\n\n(módulo: ${learning.scope})`
            : learning.summary.trim(),
          contributor: 'kanban-ai',
          outcome,
          // Ancoragem em ARQUIVO (id sem símbolo): não sabemos o símbolo aqui.
          sourceNodes: files.map((f) => fileNodeId(f)),
        });
        const rel = `${HIVE_MEMORY_SUBDIR}/${memoryDocFilename(learning.summary, now)}`;
        const written = this.projectHive.mutateHiveFile(projectId, rel, () => doc);
        if (written) {
          // O grafo é reconstruído a partir do arquivo escrito — canal do
          // recall (F2.5). Best-effort: agendamento nunca bloqueia nem lança.
          if (this.projectGraph?.incrementalEnabled) {
            void this.projectGraph.scheduleRebuild(projectId, [written]);
          }
          return true;
        }
        reason = `clone do Project ${projectId} indisponível`;
      } else {
        reason = projectId
          ? 'escrita na colmeia indisponível (ProjectHiveService ausente)'
          : 'Board sem Project — a colmeia vive no clone do Project (US-F2.3)';
      }
    } catch (err) {
      reason = (err as Error)?.message ?? String(err);
    }
    // Perda definitiva: visível no card, não só no log. O próprio registro é
    // best-effort (Activity falhar não pode derrubar o loop).
    this.logger.warn(`US-F2.6: learning PERDIDO (task ${taskId}): ${reason}`);
    await this.log(
      taskId,
      `aprendizado PERDIDO — a memória não aceitou a escrita ` +
        `(${reason}). O agent reportou: ` +
        `"${learning.summary.slice(0, 200)}". Se for durável, regrave manualmente na memória.`,
    ).catch((err) =>
      this.logger.warn(`US-F2.6: falha ao registrar a perda no card: ${(err as Error).message}`),
    );
    return false;
  }

  /**
   * US-F5.2 — persiste os learnings de UMA iteração (um doc por learning,
   * todos com o MESMO `outcome` — o sinal é da iteração, não do learning) e,
   * se ao menos um doc aterrissou, dispara o `graphify reflect` do Project em
   * fire-and-forget: LESSONS.md e o overlay `.graphify_learning.json` são
   * derivados dos memory docs, então quem escreve avisa (mesmo espírito do
   * `scheduleRebuild` da F1.5). Best-effort ABSOLUTO: nada aqui lança nem
   * entra no caminho crítico do loop (postura estabelecida em
   * `persistLearning` — memória jamais derruba o loop).
   */
  private async persistIterationLearnings(
    taskId: string,
    storyId: string,
    cwd: string,
    diffBaseline: string | null,
    learnings: { path: string; summary: string; scope?: string }[],
    outcome: MemoryOutcome | undefined,
  ): Promise<void> {
    const projectId = await this.resolveStoryProjectId(storyId).catch(() => null);
    const files = cutLearningFiles(
      await collectChangedFiles(cwd, diffBaseline).catch(() => []),
    );
    let wrote = false;
    for (const learning of learnings) {
      if (await this.persistLearning(taskId, learning, projectId, files, outcome)) {
        wrote = true;
      }
    }
    if (wrote && projectId && this.projectGraph) {
      // Promise.resolve().then(...) blinda também contra throw SÍNCRONO do
      // serviço (o `reflect` real é throwless, mas a postura é defensiva).
      void Promise.resolve()
        .then(() => this.projectGraph?.reflect(projectId))
        .catch((err) =>
          this.logger.warn(
            `US-F5.2: disparo do reflect falhou (project=${projectId}): ${(err as Error).message}`,
          ),
        );
    }
  }

  /**
   * US-F2.5 (EP-F2) — recall de memória por TRAVESSIA DE GRAFO (graphify).
   *
   * Substitui o casamento literal `LIKE '%título flows%'` (que o oráculo da
   * US-F2.1 provou quase nunca casar) por uma consulta ao grafo do Project: o
   * `query_graph` TOKENIZA a pergunta e semeia a travessia por termo — título,
   * nomes de flows e ARQUIVOS afetados viram seeds independentes (não uma
   * frase). Os arquivos são os seeds mais fortes: a aresta `describes`
   * (US-F2.4) liga o nó do arquivo de código ao neurônio que o descreve, então
   * a BFS alcança a memória relevante em 1 hop a partir do código que a task
   * vai tocar. O `token_budget` (default do `ProjectGraphQueryService`, 2000
   * tokens ≈ 2× o corte cego de 4000 chars do recall antigo) substitui o
   * truncamento sem marcador.
   *
   * US-F5.3 — a pergunta NÃO vai mais crua: passa pelo "Step 0 — Constrained
   * query expansion" do query.md (só tokens que existem no vocabulário dos
   * labels do grafo, teto de 12; arquivos afetados seguem como seeds fortes;
   * interseção vazia sem arquivos = memória vazia EXPLÍCITA com
   * `noVocabMatch`, nunca busca fabricada). O resultado é ordenado/anotado
   * pelo overlay do reflect (US-F5.2) quando ele existe.
   *
   * Retornos:
   *  - `null`     → recall por grafo NÃO se aplica (env `GRAPHIFY_MEMORY_RECALL`
   *    off, serviço ausente, task sem story ou Board legado sem Project) — o
   *    chamador usa o caminho LIKE antigo, intacto (strangler-fig; cutover na
   *    US-F2.10);
   *  - `ok:true`  → texto da travessia (vazio = memória VAZIA de verdade);
   *  - `ok:false` → memória FALHOU (grafo `building`/`failed`/inexistente ou
   *    sidecar fora). DELIBERADAMENTE sem fallback para o LIKE: mascarar a
   *    falha era exatamente o defeito do recall antigo — aqui ela vira log
   *    distinto E aviso explícito no prompt (`buildPrompt`).
   *
   * NUNCA lança — memória jamais derruba o loop (mesma postura do caminho
   * antigo, mas sem silêncio).
   */
  private async recallFromGraph(
    storyId: string | null,
    taskTitle: string,
    flows: AffectedFlow[],
  ): Promise<
    { ok: true; text: string; noVocabMatch?: true } | { ok: false; error: string } | null
  > {
    if (!this.config.graphify?.memoryRecallEnabled || !this.graphQuery || !storyId) return null;
    try {
      const projectId = await this.resolveStoryProjectId(storyId);
      if (!projectId) return null; // Board legado sem Project → não há grafo
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { graphState: true, graphBuiltAt: true },
      });
      const graphState = String(project?.graphState ?? 'inexistente');
      if (graphState !== 'ready') {
        // "Memória falhou" ≠ "memória vazia": log E prompt distinguem.
        this.logger.warn(
          `US-F2.5: recall por grafo indisponível para project=${projectId} (graphState=${graphState})`,
        );
        return { ok: false, error: `grafo do projeto indisponível (graphState=${graphState})` };
      }
      // US-F5.3 — "Step 0 — Constrained query expansion" (query.md do
      // graphify): o matcher do binário é substring case-folded, SEM stemming,
      // sinônimo ou tradução — e aqui o caso NORMAL é título em português
      // ("Validar separador vazio") contra labels em inglês
      // (`arrayMoveImmutable()`). Mandar a pergunta crua vira ruído. A
      // expansão seleciona só tokens que EXISTEM no vocabulário dos labels
      // (interseção determinística — não há LLM neste ponto; a seleção
      // "semântica" que a skill descreve é a porta de um agente, a nossa porta
      // honesta é interseção + normalização). Caminhos de arquivo continuam
      // como seeds fortes (o canal que já funcionava), em minúsculo (o matcher
      // case-folda de qualquer forma).
      const filePaths = [...new Set(flows.flatMap((f) => f.files))]
        .filter(Boolean)
        .map((p) => p.toLowerCase());
      const vocab = await this.graphVocabulary(projectId, project?.graphBuiltAt ?? null);
      let question: string;
      let noVocabMatch = false;
      if (vocab) {
        const candidates = graphVocabTokens([taskTitle, ...flows.map((f) => f.name)].join(' '));
        const selected: string[] = [];
        for (const c of candidates) {
          if (vocab.has(c) && !selected.includes(c)) selected.push(c);
          if (selected.length >= GRAPH_QUERY_MAX_TOKENS) break;
        }
        // Auditabilidade exigida pelo query.md ("print the selection
        // explicitly … so the expansion is auditable").
        this.logger.log(
          `US-F5.3: expansão de consulta (project=${projectId}, vocab=${vocab.size} tokens): ` +
            `selecionados [${selected.join(', ')}] de candidatos [${candidates.join(', ')}]`,
        );
        noVocabMatch = selected.length === 0 && candidates.length > 0;
        question = [...selected, ...filePaths].join(' ').trim();
        if (noVocabMatch && filePaths.length === 0) {
          // Hard constraint do Step 0: "if NO vocab tokens match … output an
          // empty list and tell the user the corpus has no relevant
          // vocabulary; do not fabricate a search". Sem arquivos para semear,
          // NÃO consultamos — memória vazia EXPLÍCITA, distinta de "não há
          // memória" (o buildPrompt avisa a IA da não-interseção).
          return { ok: true, text: '', noVocabMatch: true };
        }
      } else {
        // Vocabulário indisponível (projeção/serviço fora) — degrada para a
        // pergunta crua pré-F5.3: pior recall é melhor que nenhum, e os
        // arquivos continuam carregando a consulta.
        question = [taskTitle, ...flows.map((f) => f.name), ...filePaths]
          .filter(Boolean)
          .join(' ')
          .trim();
      }
      if (!question) {
        // Sem NENHUM sinal da task não há o que perguntar. O modo antigo aqui
        // devolvia "os 5 indexados mais recentemente" (arbitrários, oráculo
        // F2.1); memória vazia explícita é estritamente melhor.
        return { ok: true, text: '' };
      }
      const res = await this.graphQuery.queryGraph(projectId, { question, mode: 'bfs' });
      if (!res.ok) {
        this.logger.warn(`US-F2.5: query_graph falhou para project=${projectId}: ${res.error}`);
        return res;
      }
      // Neurônios tocados pela travessia lexical (nós com src=.hive/…).
      const hivePaths = new Set<string>();
      for (const m of res.text.matchAll(/src=(\.hive\/[^\s\]]+)/g)) {
        if (hivePaths.size >= GRAPH_RECALL_MAX_NEURONS) break;
        hivePaths.add(m[1]);
      }
      // A aresta `describes` (US-F2.4) é neurônio→código, e a BFS do
      // query_graph é DIRECIONADA: a partir do arquivo ela não chega ao
      // neurônio (verificado empiricamente). Buscamos os vizinhos REVERSOS
      // dos arquivos afetados explicitamente — é o canal que recupera memória
      // porque a task toca o arquivo, mesmo sem NENHUMA palavra em comum.
      for (const file of [...new Set(flows.flatMap((f) => f.files))].slice(0, 5)) {
        if (hivePaths.size >= GRAPH_RECALL_MAX_NEURONS) break;
        const nb = await this.graphQuery.getNeighbors(projectId, {
          label: file,
          relationFilter: 'describes',
        });
        if (!nb.ok) continue; // arquivo fora do grafo — segue o baile
        for (const m of nb.text.matchAll(/<--\s+(\S+)\s+\[describes\]/g)) {
          if (hivePaths.size >= GRAPH_RECALL_MAX_NEURONS) break;
          const node = await this.graphQuery.getNode(projectId, m[1]);
          const src = node.ok ? /Source:\s+(\.hive\/\S+)/.exec(node.text)?.[1] : undefined;
          if (src) hivePaths.add(src);
        }
      }
      // A travessia devolve o MAPA (nós/arestas), não o corpo dos neurônios.
      // O grafo SELECIONA a memória; o conteúdo vem da fonte da verdade (bare
      // repo) — anexado abaixo do mapa, com corte MARCADO (o recall antigo
      // cortava em 4000 chars sem nenhum aviso à IA).
      // US-F5.3 — antes de anexar, ordena/anota pelo overlay do reflect
      // (US-F5.2), quando o sidecar anotou `learning=` nos nós.
      const ranked = this.rankByLearningOverlay(res.text);
      return { ok: true, text: this.appendNeuronBodies(projectId, ranked, hivePaths) };
    } catch (err) {
      const error = (err as Error)?.message ?? String(err);
      this.logger.warn(`US-F2.5: recall por grafo falhou: ${error}`);
      return { ok: false, error };
    }
  }

  /**
   * US-F2.5 → US-F2.3 — anexa ao texto da travessia o CORPO dos neurônios
   * selecionados pelo grafo (paths `.hive/<rel>`), lidos DIRETO da colmeia do
   * clone (`ProjectHiveService.readHiveFile` — a fonte da verdade desde a
   * deleção do git da memória). Até 5 neurônios (paridade com o limite do
   * recall antigo — mas escolhidos por RELEVÂNCIA de travessia/aresta
   * `describes`, não por recência de indexação); corte por neurônio com
   * marcador explícito. Falha de leitura de um neurônio é pulada: o mapa da
   * travessia ainda o nomeia para a IA ler do worktree se precisar.
   */
  private appendNeuronBodies(
    projectId: string,
    traversal: string,
    hivePaths: ReadonlySet<string>,
  ): string {
    const MAX_CHARS = 4000;
    let text = traversal;
    for (const hivePath of hivePaths) {
      const rel = hivePath.slice('.hive/'.length);
      const raw = this.projectHive?.readHiveFile(projectId, rel)?.content ?? null;
      if (raw === null) continue;
      const body =
        raw.length > MAX_CHARS
          ? `${raw.slice(0, MAX_CHARS)}\n[… truncado — leia ${hivePath} completo se precisar]`
          : raw;
      text += `\n\n### neurônio: ${hivePath}\n${body.trim()}`;
    }
    return text;
  }

  /**
   * US-F5.3 — cache do vocabulário por Project. Chave de invalidação:
   * `graphBuiltAt` (o vocabulário só muda quando o grafo é reconstruído).
   * ponytail: Map sem teto — o processo atende poucos Projects; LRU se doer.
   */
  private readonly graphVocabCache = new Map<string, { builtAt: string; vocab: Set<string> }>();

  /**
   * US-F5.3 — vocabulário REAL dos labels do grafo do Project (Step 0 do
   * query.md). Fonte: a projeção da US-F4.1 (`ProjectGraphService.projection`,
   * modo overview, limit 500 = teto do wrapper), REUSADA em vez de rota nova
   * no sidecar: ela já devolve `label` de todos os nós dos grafos reais
   * (52/84 nós) e, num grafo maior que 500, os 500 nós mais conectados são
   * exatamente o vocabulário que vale semear (hubs primeiro). Tokens já
   * normalizados (minúsculo, sem acento, split de camelCase, 3..30 chars).
   * `null` = vocabulário indisponível (serviço ausente/projeção falhou) — o
   * chamador degrada para a pergunta crua pré-F5.3. Throwless.
   */
  private async graphVocabulary(
    projectId: string,
    builtAt: Date | null,
  ): Promise<Set<string> | null> {
    if (!this.projectGraph) return null;
    const key = builtAt?.toISOString() ?? 'sem-builtAt';
    const cached = this.graphVocabCache.get(projectId);
    if (cached && cached.builtAt === key) return cached.vocab;
    try {
      const proj = await this.projectGraph.projection(projectId, { limit: 500 });
      if (!proj.ok) return null;
      const vocab = new Set<string>();
      for (const n of proj.nodes) for (const t of graphVocabTokens(n.label)) vocab.add(t);
      this.graphVocabCache.set(projectId, { builtAt: key, vocab });
      return vocab;
    } catch (err) {
      this.logger.warn(
        `US-F5.3: vocabulário do grafo indisponível (project=${projectId}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * US-F5.3 — ranking pelo overlay do reflect (US-F5.2). O serve do graphify
   * anexa `learning=preferred|tentative|contested[:stale]` às linhas NODE
   * quando `.graphify_learning.json` existe ao lado do graph.json. Aqui só
   * REORDENAMOS o bloco contíguo de NODEs (preferred sobe, contested desce,
   * ordem relativa estável — os EDGEs ficam onde estão) e anexamos uma
   * legenda para a IA. `dead_end` não entra no overlay na versão atual do
   * graphify (fica query-scoped no reflect), mas a legenda/ranking já o
   * tratam caso apareça. Sem NENHUMA anotação (overlay ausente — o caso
   * normal até a frota rodar reflect) o texto sai byte-idêntico: degradação
   * silenciosa.
   */
  private rankByLearningOverlay(traversal: string): string {
    if (!traversal.includes(' learning=')) return traversal;
    const lines = traversal.split('\n');
    const rank = (l: string): number => {
      const status = /\slearning=([a-z_]+)/.exec(l)?.[1];
      if (status === 'preferred') return 0;
      if (status === 'contested') return 2;
      if (status === 'dead_end') return 3;
      return 1; // sem anotação ou tentative — mantém o meio
    };
    const first = lines.findIndex((l) => l.startsWith('NODE '));
    if (first >= 0) {
      let last = first;
      while (last + 1 < lines.length && lines[last + 1].startsWith('NODE ')) last++;
      const block = lines
        .slice(first, last + 1)
        .map((l, i) => [rank(l), i, l] as const)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .map(([, , l]) => l);
      lines.splice(first, block.length, ...block);
    }
    lines.push(
      '',
      'Aprendizado do projeto (reflect — US-F5.2/US-F5.3): nós `learning=preferred` já provaram ' +
        'valor em iterações passadas — comece por eles; `learning=contested` têm sinais ' +
        'conflitantes — confirme antes de confiar; `learning=dead_end` já foi tentado e não levou ' +
        'a nada — não re-derive.',
    );
    return lines.join('\n');
  }

  /**
   * Resolve o caminho absoluto do repo-alvo (aiProject) LEGADO de uma story,
   * herdando do épico pai quando a story não tem aiProject próprio (mesma regra
   * do buildContext). Retorna null se não houver aiProject.
   */
  private async resolveLegacyAiProject(storyId: string): Promise<string | null> {
    const story = await this.prisma.card.findUnique({
      where: { id: storyId },
      select: { aiProject: true, parentId: true },
    });
    let raw = story?.aiProject ?? '';
    if (!raw && story?.parentId) {
      const epic = await this.prisma.card.findUnique({
        where: { id: story.parentId },
        select: { aiProject: true },
      });
      raw = epic?.aiProject ?? '';
    }
    return this.workspaces.resolveTargetRepo(raw);
  }

  /**
   * US-PROJ4 — chave de SERIALIZAÇÃO do repo-alvo (guard `serializeByRepo`).
   * Quando o Board tem `projectId`, a chave é o `projectId` (estável, não muda
   * com o path físico do clone). Sem `projectId`, cai na chave legada = path
   * físico do `aiProject`. Não dispara `ensureCloned` (é só comparação de
   * conflito, in-process, sem Redis — invariante 7).
   */
  private async resolveStoryProject(storyId: string): Promise<string | null> {
    const projectId = await this.resolveStoryProjectId(storyId);
    if (projectId) return `project:${projectId}`;
    return this.resolveLegacyAiProject(storyId);
  }

  // ── Loop core ───────────────────────────────────────────────────────────────

  /**
   * Roda UMA iteração de uma task (núcleo do loop) — artifact `runIteration`
   * (linhas ~993–1051). Persiste a `Iteration` em transação, atualiza execState
   * e DOD, e emite os eventos WS. Retorna true se rodou algo.
   */
  async runIteration(
    taskId: string,
    opts: { recovery?: boolean } = {},
  ): Promise<boolean> {
    const recovery = opts.recovery === true;
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
        adapter: true, // US-F3.10 — adapter por card (cascata)
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

    void this.renewClaim(storyId); // US-ROB4: heartbeat do lease por iteração
    this.touchHeartbeat(storyId); // US-HARD1: batida do heartbeat adaptativo

    // Gate de custo (#1) + anti-thrash (#3): ANTES de gastar uma nova iteração
    // (worktree + spawn), verifica se a task já estourou o orçamento de tempo/
    // tokens ou se a AI está travada repetindo a mesma coisa. Em ambos os casos
    // marca `needsHuman`, para o auto-play graceful e emite `card.needs_human` —
    // reaproveitando o caminho de resgate já existente. Guardado por config.
    if (await this.enforceLoopGuards(taskId, storyId)) {
      return false;
    }

    // Modelo de AI resolvido em cascata: task → parents → agent responsável →
    // board.defaultModel → default global. Injetado no spawn via env
    // COPILOT_MODEL pelo runner.
    const resolvedModel = await this.resolveCardModel(
      raw?.model ?? null,
      raw?.parentId ?? null,
      raw?.boardId ?? null,
      agent?.model ?? null,
    );
    // US-OBS2-5: lane de recuperação status-only usa o modelo BARATO (quando
    // configurado); trabalho normal SEMPRE usa o modelo normal resolvido acima.
    const dispatchModel = resolveDispatchModel(
      resolvedModel,
      this.config.agent.cheapModelId,
      recovery,
    );

    // US-F3.10 — adapter resolvido em cascata: task → parents →
    // board.defaultAdapter → global (config.agentAdapter, que já embute
    // AGENT_ADAPTER → default do processo). Na RECOVERY a lane vence e usa o
    // adapter GLOBAL (ver resolveDispatchAdapter: o cheapModelId vive no
    // namespace do adapter global; recuperação nunca fica mais cara). O runner
    // passa a ser POR CARD; sem registry (specs posicionais), cai no runner do
    // token AGENT_RUNNER — comportamento pré-F3.10.
    const resolvedAdapter = await this.resolveCardAdapter(
      raw?.adapter ?? null,
      raw?.parentId ?? null,
      raw?.boardId ?? null,
    );
    const dispatchAdapter = resolveDispatchAdapter(
      resolvedAdapter,
      this.config.agentAdapter,
      recovery,
    );
    const runner = this.adapterRegistry
      ? this.adapterRegistry.resolve(dispatchAdapter)
      : this.runner;

    // b6: contexto do runner (só os campos do AgentRunContext; os demais são
    // usados apenas para montar o prompt da CLI real).
    const runnerContext = {
      taskTitle: context.taskTitle,
      project: context.project,
      notes: context.notes,
      flowNames: context.flowNames,
      files: context.files,
    };

    // Diretório de trabalho do agent = o PRÓPRIO repo-alvo. O agent coda direto
    // na branch já aberta, sem worktree isolado nem branch/commit — deixando as
    // mudanças no working tree do projeto. A colisão entre stories concorrentes
    // é resolvida por SERIALIZAÇÃO em onStoryEnterInProgress (uma story In
    // Progress por EPIC; opcionalmente também por repo-alvo físico via
    // AGENT_SERIALIZE_BY_REPO).
    //
    // US-PROJ4 — a ORIGEM do repo-alvo é resolvida por `resolveStoryTargetRepo`:
    // quando o Board tem `projectId`, o path é o `localPath` do clone gerenciado
    // (garantido por `ensureCloned` ANTES de `resolveWorkdir` — senão o worktree
    // falharia por path inexistente); senão, é o `aiProject` legado. Se o
    // projeto-alvo não estiver definido/for inválido, RECUSAMOS rodar — o agent
    // nunca pode trabalhar no repo do kanban-ai. A task fica em blocked-dep.
    let cwd = '';
    try {
      const targetRepo = await this.resolveStoryTargetRepo(storyId);
      cwd = await this.workspaces.resolveWorkdir(storyId, targetRepo);
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof TargetProjectError) {
        await this.log(
          taskId,
          `iteração recusada — projeto-alvo inválido/ausente: ${msg}. ` +
            'Defina o repositório-alvo (aiProject) da story para o agent poder trabalhar.',
        );
        await this.setExecState(taskId, 'blocked-dep');
        return false;
      }
      // Qualquer outra falha ao resolver o workdir (ex.: erro do git) também
      // impede o agent de trabalhar. NUNCA seguimos com cwd vazio — isso rodaria
      // o agent no diretório da API (apps/api). Recusamos e bloqueamos a task.
      this.logger.warn(`Falha ao resolver workdir para story=${storyId}: ${msg}`);
      await this.log(
        taskId,
        `iteração recusada — falha ao resolver o diretório de trabalho: ${msg}. ` +
          'O agent não pode rodar sem o repositório-alvo válido.',
      );
      await this.setExecState(taskId, 'blocked-dep');
      return false;
    }

    // Diff/Replay Viewer: snapshot do working tree ANTES do agent rodar, para
    // que o diff desta iteração reflita SÓ o delta produzido nesta iteração (e
    // não o acumulado do worktree contra o último commit). Ver captureDiff().
    const diffBaseline = await this.captureTreeBaseline(cwd);

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

    const runResult = await runner.run({
      cwd,
      model: dispatchModel,
      phase,
      // cliSessionId = taskId (UUID). Dá memória conversacional entre iterações
      // one-shot e torna o HITL resiliente a restart: o turno que retoma após a
      // resposta humana resume a MESMA sessão do Copilot. Ver ADR-0022.
      cliSessionId: taskId,
      prompt: this.buildPrompt(
        phase,
        profile,
        context,
        agent?.instructions ?? '',
        cwd,
        recovery,
        // US-F3.5 — runner com outputSchema não recebe instruções de marcador.
        runner.structuredOutput === true,
      ),
      // US-F3.5 — mesma condição do buildPrompt para pedir proposedDod (R3):
      // o runner com schema inclui o campo SÓ na análise de task sem DOD.
      proposeDod: context.dodItems.length === 0 && phase === 'analysis',
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
    // refletindo exatamente o que o agent produziu nesta iteração. O baseline
    // (snapshot do início) garante que seja o DELTA desta iteração, não o
    // acumulado. Reutilizado em ambos os call sites de appendIteration abaixo.
    const iterationDiff = await this.captureDiff(cwd, diffBaseline);

    // US-F1.5 — a iteração mexeu no repo-alvo? Dispara o rebuild INCREMENTAL do
    // grafo do Project em fire-and-forget (mesmo espírito best-effort da escrita
    // de learnings abaixo): coalescing por Project, contador de force periódico
    // e extração de arquivos vivem no ProjectGraphService; NADA disso entra no
    // caminho crítico da iteração — falha/lentidão/sidecar fora viram warn e o
    // loop segue. Desligado por default (GRAPHIFY_INCREMENTAL_REBUILD).
    if (this.projectGraph?.incrementalEnabled && iterationDiff.trim().length > 0) {
      void this.resolveStoryProjectId(storyId)
        .then((projectId) =>
          projectId
            ? this.projectGraph?.rebuildFromIteration(projectId, cwd, diffBaseline)
            : undefined,
        )
        .catch((err) =>
          this.logger.warn(
            `US-F1.5: disparo do rebuild incremental do grafo falhou: ${(err as Error).message}`,
          ),
        );
    }

    // US-ROB2 — acumula tokens da iteração no estado durável da story (por
    // session, chaveado por storyId). Defensivo: só quando há tokens; o próprio
    // addTokens é best-effort (persistência guardada por flag + try/catch).
    if (runResult.inputTokens || runResult.outputTokens) {
      await this.sessions.addTokens(storyId, {
        input: runResult.inputTokens ?? 0,
        output: runResult.outputTokens ?? 0,
      });
    }


    // não autenticado, crash da CLI). Esta "iteração" NÃO é trabalho da AI —
    // não pode virar `done` (fecharia a task por engano) nem iteração `ok`
    // silenciosa (o loop iteraria até o cap, mascarando a causa raiz). Fail-fast:
    // registramos a iteração como falha explícita, escalamos a humano com o
    // motivo real e PARAMOS o loop.
    if (runResult.fatalError) {
      const reason = `Erro fatal de execução do agente: ${runResult.fatalError}`;
      await this.appendIteration(taskId, {
        phase,
        agentId,
        detail: runResult.detail,
        summary: runResult.summary || 'erro fatal de execução',
        dodTouched: [],
        handoff: {
          state: 'blocked',
          nextStep: 'Resolver o erro de infraestrutura/execução e reprocessar.',
          files: context.files,
          dodIds: [],
        },
        evidence: evidenceToString(runResult.evidence),
        diff: iterationDiff,
        durationMs: Date.now() - iterationStartedAt,
        inputTokens: runResult.inputTokens,
        outputTokens: runResult.outputTokens,
        outcome: 'error',
      });
      await this.log(taskId, reason);
      await this.escalateToHuman(taskId, storyId, reason, reason);
      return false;
    }

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

      // Gate de `done` mais forte (#4): mesmo com a validação empírica passando,
      // se `AGENT_REQUIRE_STRUCTURED_EVIDENCE` estiver ligado e a AI não anexou
      // evidência ESTRUTURADA e verificável (ao menos um check `passed:true`),
      // NÃO fechamos a task — tratamos como problema (deriva/needs-human como
      // uma falha de validação normal). Isso impede que uma string livre
      // ("acho que passou") feche a task.
      let effectivePassed = outcome.passed;
      const evidenceProblems = outcome.problems.slice();
      if (
        outcome.passed &&
        this.config.agent.requireStructuredEvidence &&
        !isVerifiableEvidence(runResult.evidence)
      ) {
        effectivePassed = false;
        evidenceProblems.push({
          title: 'evidência de conclusão não verificável',
          description:
            'A validação empírica passou, mas AGENT_REQUIRE_STRUCTURED_EVIDENCE está ' +
            'ligado e a AI não anexou evidência estruturada verificável (checks com ' +
            'passed:true). Rode os checks (test/lint/build) e reporte o resultado no ' +
            'campo `evidence` estruturado antes de concluir.',
        });
        await this.log(
          taskId,
          'gate de done: validação passou mas evidência não é verificável — task NÃO fechada (evidence estruturada exigida).',
        );
      }

      // US-ROB1 — Gate de completude por CLASSE de resultado. Complementa o
      // gate de evidência acima: mesmo com a validação empírica passando, se a
      // conclusão não trouxer o artefato MÍNIMO da sua classe (diff, teste
      // verde ou arquivo de fluxo), NÃO fechamos — roteamos pelo mesmo caminho
      // de derivação/escala. Off por default (AGENT_REQUIRE_MIN_ARTIFACT).
      if (effectivePassed && this.config.agent.requireMinArtifact) {
        const hasFlows = (context.affectedFlows?.length ?? 0) > 0;
        const hasDiff = iterationDiff.trim().length > 0;
        // Deriva a classe dos sinais que o orquestrador já tem em escopo:
        //  - código editado nesta iteração → code-change;
        //  - fluxos declarados sem código novo → flow-artifact (o entregável
        //    são os próprios arquivos de fluxo);
        //  - caso contrário (ex.: strategy regression-only) → test-green.
        const resultClass: ResultClass = hasDiff
          ? 'code-change'
          : hasFlows
            ? 'flow-artifact'
            : 'test-green';
        // Reusa o sinal do ValidationRunner: ele já checou a existência dos
        // arquivos de affectedFlows (verifyFlowFiles). Como este bloco só roda
        // com `outcome.passed`, os arquivos declarados existem no worktree —
        // NÃO duplicamos I/O de filesystem aqui.
        const flowFilesPresent = outcome.passed;
        const artifactProblem = minimumArtifactSatisfied({
          resultClass,
          evidence: runResult.evidence,
          diff: iterationDiff,
          flowFilesPresent,
        });
        if (artifactProblem) {
          effectivePassed = false;
          evidenceProblems.push(artifactProblem);
          await this.log(
            taskId,
            `gate de done: artefato mínimo da classe "${resultClass}" ausente (${artifactProblem.title}) — task NÃO fechada.`,
          );
        }
      }

      await this.appendIteration(taskId, {
        phase,
        agentId,
        detail: runResult.detail,
        summary: runResult.summary,
        dodTouched: [],
        handoff: {
          state: effectivePassed ? 'done' : 'blocked',
          nextStep: effectivePassed
            ? ''
            : 'Corrigir o problema encontrado (ver task derivada).',
          files: context.files,
          dodIds: [],
        },
        evidence: evidenceToString(runResult.evidence),
        diff: iterationDiff,
        durationMs: Date.now() - iterationStartedAt,
        inputTokens: runResult.inputTokens,
        outputTokens: runResult.outputTokens,
        outcome: effectivePassed ? 'ok' : 'derived',
      });

      // US-F5.2 — o loop desistiu e escalou a humano nesta iteração de
      // validação? Alimenta o `outcome` dos learnings (dead_end) abaixo.
      let validationEscalated = false;
      if (effectivePassed) {
        await this.setExecState(taskId, 'done');
        await this.log(taskId, 'validação final concluída — task Done');
        // US-CTX2 (EP-CTX/ADR-0040) — grava o HANDOFF ESTRUTURADO da task ao
        // fechá-la, para as tasks dependentes (irmãs/blockers) herdarem
        // changed_files/verification etc. sem começar cegas. Best-effort:
        // NUNCA derruba o loop (a task já está `done`).
        await this.writeCompletionMetadata(taskId, context, runResult).catch((err) =>
          this.logger.warn(
            `writeCompletionMetadata falhou para ${taskId}: ${(err as Error).message}`,
          ),
        );
        // US-OBS3 (ADR-0037) — auto-commit/PR OPCIONAL, gated. Só age com opt-in
        // ligado, evidência verificável e worktree ISOLADO (ADR-0035). Default
        // off = zero commit (comportamento idêntico ao de hoje). Best-effort:
        // nunca derruba o loop.
        await this.maybeAutoCommit(storyId, taskId, runResult.evidence).catch((err) =>
          this.logger.warn(
            `auto-commit falhou para ${taskId}: ${(err as Error).message}`,
          ),
        );
        await this.onTaskDone(taskId);
      } else {
        // Só ocorre com validação real ou gate de evidence; no mock (com o gate
        // desligado) nunca acontece.
        const problem = evidenceProblems[0] ?? {
          title: 'falha na validação',
          description: `A validação de ${taskId} detectou comportamento incorreto.`,
        };

        // "Needs human": conta quantas iterações de validação desta task já
        // falharam (inclui a recém-anexada acima, com handoffState='blocked').
        // Ao atingir o threshold, em vez de derivar de novo (risco de loop
        // infinito de derivações), marcamos a task com `needsHuman`, paramos o
        // auto-play da story de forma graceful e emitimos um evento WS.
        //
        // "Perdão" pós-intervenção: só contamos as falhas POSTERIORES à última
        // resposta humana (role=user). Assim, após o humano destravar uma task
        // escalada, o cap de falhas recomeça — evitando re-escalar de imediato.
        const lastAnswerForFailures = await this.prisma.agentMessage.findFirst({
          where: { cardId: taskId, role: 'user' },
          orderBy: { ts: 'desc' },
          select: { ts: true },
        });
        const validationFailures = await this.prisma.iteration.count({
          where: {
            cardId: taskId,
            phase: 'validation',
            handoffState: 'blocked',
            ...(lastAnswerForFailures ? { ts: { gt: lastAnswerForFailures.ts } } : {}),
          },
        });
        // Cap de profundidade de derivação (#2): se a task de origem já está
        // fundo demais na cadeia de derivações, parar de derivar e escalar —
        // senão o engine pode derivar bugs em cadeia infinita.
        const originCard = await this.prisma.card.findUnique({
          where: { id: taskId },
          select: { derivedDepth: true, parentId: true },
        });
        const depth = originCard?.derivedDepth ?? 0;
        const decision = this.decideValidationFailureAction(depth, validationFailures);
        if (decision.action === 'escalate') {
          // O cap de falhas de validação usa `problem.title` como reason (o
          // problema concreto); o cap de profundidade tem reason próprio.
          const reason = decision.reasonKind === 'depth' ? decision.reason : problem.title;
          validationEscalated = true;
          await this.escalateToHuman(taskId, storyId, reason, decision.log);
        } else {
          // Dedup + cap AGREGADO por problema (fecha o loop de derivações
          // paralelas): antes de derivar, conta quantas tasks de correção
          // ABERTAS para o MESMO problema já existem como irmãs (mesmo
          // `parentId`/story). Se já há ≥1, NÃO cria outra (dedup); se o total
          // atingir o cap agregado, escala para humano em vez de multiplicar
          // cadeias. Assim o loop não escapa do guard-rail iniciando cadeias
          // novas (onde `derivedDepth` reinicia baixo).
          const openDerived = await this.countOpenDerivedForProblem(
            originCard?.parentId ?? null,
            problem.title,
          );
          const maxPerProblem = this.config.agent.maxDerivedPerProblem;
          if (maxPerProblem > 0 && openDerived >= maxPerProblem) {
            const reason = `derivações repetidas para o mesmo problema atingiram o limite (${openDerived} ≥ ${maxPerProblem}): ${problem.title}`;
            validationEscalated = true;
            await this.escalateToHuman(
              taskId,
              storyId,
              problem.title,
              `cap agregado de derivação: ${reason} — task marcada como "precisa de humano"; auto-play parado`,
            );
          } else if (openDerived > 0) {
            // Ja existe uma correcao aberta identica: nao duplicar. Apenas
            // registra e deixa a derivada existente resolver o problema.
            await this.log(
              taskId,
              `dedup de derivação: já existe task de correção aberta para "${problem.title}" — não criando duplicata`,
            );
          } else {
            await this.createDerivedTask(taskId, problem);
          }
        }
      }
      // US-F5.2 — learnings da fase de VALIDAÇÃO. Antes eram DESCARTADOS (o
      // `return true` abaixo nunca alcançava o bloco de learnings do fluxo
      // normal); e é justamente aqui que vive o sinal mais forte do loop:
      // `useful` quando o gate passou (task fecha Done), `corrected` quando a
      // validação reprovou e exigiu nova rodada (task derivada/dedup),
      // `dead_end` quando o loop escalou a humano sem saída. Best-effort — o
      // helper nunca lança.
      if (runResult.learnings?.length) {
        await this.persistIterationLearnings(
          taskId,
          storyId,
          cwd,
          diffBaseline ?? null,
          runResult.learnings,
          deriveLearningOutcome({
            kind: 'validation',
            passed: effectivePassed,
            escalated: validationEscalated,
          }),
        );
      }
      return true;
    }

    // Guard anti-progresso-fantasma: na fase de implementação, se a AI reivindica
    // trabalho que EXIGE código novo — declarar a task `done` ou listar
    // `affectedFlows` (afirmar que mexeu em fluxos) — mas o `git diff` desta
    // iteração está VAZIO, então nenhuma mudança nova aterrissou no working tree
    // e a reivindicação é alucinada. Nesse caso NÃO aceitamos: ignoramos e
    // registramos um desvio, para o loop corrigir em vez de avançar sobre
    // trabalho inexistente. (runner mock não produz diff real — só ao real.)
    //
    // IMPORTANTE (correção do deadlock de fechamento de DOD): marcar `dodTouched`
    // NÃO é, por si só, reivindicação de código novo. Muitos itens de DOD são de
    // VERIFICAÇÃO ("monorepo verde após build/lint/test", "tipo exportado pelo
    // barrel", "confirmar reuso de US-115") e são legitimamente fechados em
    // iterações SEM diff, depois que o código já foi escrito numa iteração
    // anterior. Antes, um diff de iteração vazio descartava o `dodTouched` e a
    // task nunca conseguia fechar o DOD → escalava como "improdutiva" em loop.
    // Só tratamos o fechamento de DOD como fantasma quando a task NUNCA produziu
    // diff algum (nenhuma iteração de implementação produtiva antes): aí o item
    // provavelmente se refere a código que não existe.
    // Guard anti-progresso-fantasma (reformulado após o deadlock das TK-129/130).
    //
    // Precisamos distinguir DOIS tipos de reivindicação da AI numa iteração de
    // implementação com `git diff` VAZIO:
    //
    //  (A) Reivindicações que EXIGEM código novo NESTA iteração — declarar a task
    //      `done` ou listar `affectedFlows` (afirmar que mexeu em fluxos). Se o
    //      diff está vazio, essas reivindicações são alucinadas: bloqueamos.
    //
    //  (B) Marcar `dodTouched` — a AI ATESTANDO que um critério de DOD específico
    //      está satisfeito. Isso NÃO exige diff nesta iteração: o código que
    //      satisfaz o item pode ter sido escrito antes (iteração anterior, um
    //      PROCESSO anterior que foi reiniciado, ou uma TASK IRMÃ da mesma story
    //      no mesmo repo — foi exatamente o que travou a TK-130, cujo código
    //      `ResolveRequest`/`MemoryReviewItem` já existia no repo). Muitos itens
    //      de DOD são de VERIFICAÇÃO ("monorepo verde", "tipo exportado pelo
    //      barrel") e nunca produzem diff. Zerar `dodTouched` aqui era a causa do
    //      deadlock: a task nunca fechava o DOD e re-escalava para humano em loop.
    //
    // Portanto o bypass zera SÓ as reivindicações do tipo (A). O `dodTouched`
    // (tipo B) sempre passa pela validação normal (ids desta task, ainda não
    // marcados, regra nano de 1 por iteração). O antídoto contra a AI marcar DOD
    // falsamente NÃO é o diff (que aqui é inconclusivo), e sim: (1) a nano-regra
    // limita a 1 item/iteração; (2) o cap de improdutivas — agora ciente de
    // `dodTouched` — só perdoa quem realmente avança o DOD e escala o resto.
    // O aviso de desvio só faz sentido quando a reivindicação é de fato
    // fantasma: `affectedFlows` sem diff, ou `done` sem diff E com DOD ainda
    // incompleto (declarar conclusão sem ter terminado o checklist nem escrito
    // código). `done` com todo o DOD fechado é conclusão legítima (tratada em
    // `canFinish` adiante) e não deve alarmar.
    const claimsNewCodeWithoutDiff =
      profile.toolset !== 'board-only' &&
      runner.id !== 'mock' &&
      phase === 'implementation' &&
      iterationDiff.trim().length === 0 &&
      (runResult.affectedFlows?.length ?? 0) > 0;
    if (claimsNewCodeWithoutDiff) {
      await this.log(
        taskId,
        'desvio detectado: a AI listou fluxos afetados mas o git diff do repo-alvo ' +
          'está VAZIO nesta iteração. A reivindicação de mudança em fluxos foi ' +
          'IGNORADA — marque os itens de DOD que você validou; para fechar a task, ' +
          'edite de fato os arquivos ou conclua o DOD item a item.',
      );
    }

    // US-COLAB2 / ADR-0031: a restrição do board-manager é COOPERATIVA (imposta
    // por prompt, não por sandbox). Se um profile `board-only` produziu diff
    // não-vazio, ele desobedeceu ("não coda") — logamos como warning para
    // auditoria; o enforcement real (allow/deny de tools) fica para runners
    // futuros.
    if (profile.toolset === 'board-only' && iterationDiff.trim().length > 0) {
      await this.log(
        taskId,
        'aviso: o perfil ORQUESTRADOR (board-only) NÃO deveria editar arquivos, mas o ' +
          'git diff do repo-alvo veio NÃO-VAZIO nesta iteração. A restrição é cooperativa ' +
          '(imposta por prompt) — o board-manager deve apenas criar/atribuir/linkar cards.',
      );
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
    } else if (runner.id === 'mock' && phase === 'implementation') {
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
    // STORY pai (merge por nome) para alimentar a validação final. Não
    // persistimos quando a reivindicação é fantasma (fluxos sem diff nesta
    // iteração) — ver `claimsNewCodeWithoutDiff`.
    if (
      !claimsNewCodeWithoutDiff &&
      runResult.affectedFlows &&
      runResult.affectedFlows.length > 0 &&
      context.storyId
    ) {
      await this.persistAffectedFlows(context.storyId, runResult.affectedFlows);
    }

    // US-F2.7 — blast radius DERIVADO do grafo: a IA continua declarando (acima),
    // mas deixa de ser a única fonte. Os arquivos do diff viram seeds do
    // `/affected` (US-F1.6) e o corte vira o fluxo `blast radius (grafo)` na
    // story — a validação passa a exercitar os dependentes diretos do que a
    // mudança realmente tocou. Roda mesmo sem declaração da IA (o caso
    // "declarou de menos"); com diff vazio é no-op (ancorado na realidade, o
    // derivado não tem como ser fantasma). Env off (default) = byte-idêntico.
    if (context.storyId && cwd) {
      await this.maybeDeriveAffectedFlows({
        taskId,
        storyId: context.storyId,
        cwd,
        diffBaseline: diffBaseline ?? null,
        // Fluxos fantasma (declarados sem diff) não contam como "declarado" na
        // conferência — eles nem foram persistidos (guard acima).
        declared: claimsNewCodeWithoutDiff ? [] : (runResult.affectedFlows ?? []),
      });
    }

    // A task pode ir a `done` quando a AI declara `done` E isso é crível. Com
    // diff vazio, `done` só é aceito se TODO o DOD já estiver satisfeito (o DOD
    // é a fonte de verdade da conclusão) — inclusive contando o item marcado
    // AGORA nesta iteração. Assim a iteração final de fechamento (marca o último
    // item de DOD e declara `done`, sem diff) conclui a task; mas declarar
    // `done` com DOD incompleto e sem diff cai no guard anti-fantasma.
    let dodAllDone = false;
    if (runResult.done) {
      const pendingDod = await this.prisma.dodItem.count({
        where: { cardId: taskId, done: false },
      });
      dodAllDone = pendingDod === 0;
    }
    const canFinish =
      runResult.done &&
      (dodAllDone || iterationDiff.trim().length > 0 || runner.id === 'mock');
    const handoffState = canFinish ? 'done' : execStateAfterPhase(phase);

    // US-A3 (EP-A/ADR-0027) → US-F2.3 — persiste os aprendizados reportados
    // pelo agent na colmeia do CLONE (`<clone>/.hive/memory/*.md`, a fonte da
    // verdade desde a deleção do git da memória). Totalmente DEFENSIVO: a
    // memória NUNCA pode derrubar o loop (US-F2.6 — a perda definitiva vira
    // Activity no card, tudo dentro de `persistLearning`, que nunca lança).
    //
    // US-F5.2 — o bloco MUDOU DE LUGAR (agora roda depois de `canFinish`)
    // para o `outcome` do memory doc nascer do sinal real do loop: `useful`
    // quando a task pôde concluir, `corrected` quando o guard anti-fantasma
    // rejeitou a reivindicação da iteração, e SEM outcome (unmarked) nas
    // iterações intermediárias. Depois da escrita, o helper dispara o
    // `graphify reflect` (fire-and-forget) para agregar os docs no LESSONS.md
    // e no overlay `.graphify_learning.json`.
    if (runResult.learnings?.length) {
      await this.persistIterationLearnings(
        taskId,
        storyId,
        cwd,
        diffBaseline ?? null,
        runResult.learnings,
        deriveLearningOutcome({
          kind: 'iteration',
          canFinish,
          phantomClaim: claimsNewCodeWithoutDiff,
        }),
      );
    }
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
      evidence: evidenceToString(runResult.evidence),
      diff: iterationDiff,
      durationMs: Date.now() - iterationStartedAt,
      inputTokens: runResult.inputTokens,
      outputTokens: runResult.outputTokens,
      provider: runResult.provider,
      outcome: hitlExchange ? 'awaiting-input' : 'ok',
    });

    // ── US-CTX3 (EP-CTX/ADR-0040) — continuação bounded direcionada ──────────
    // Classifica o liveness do run. Se foi improdutivo-mas-recuperável
    // (plan_only/empty_response) e ainda estamos dentro do cap, registra um
    // `livenessReason` direcionado + incrementa o contador e enfileira um wake
    // 'continuation' (re-tick imediato quando fora do auto-play). Em qualquer
    // run que AVANÇOU (advanced/completed), zera o contador e limpa o motivo.
    // Best-effort: nunca derruba o loop.
    await this.applyContinuationPolicy(
      storyId,
      this.classifyRunLiveness(runResult, iterationDiff, touched, handoffState),
      runResult,
    ).catch((err) =>
      this.logger.warn(
        `applyContinuationPolicy falhou (task=${taskId}): ${(err as Error).message}`,
      ),
    );

    await this.setExecState(taskId, execStateAfterPhase(phase));
    return true;
  }

  /**
   * US-CTX3 (EP-CTX/ADR-0040) — aplica a política de continuação bounded a
   * partir do liveness classificado. Persiste `continuationAttempt`/
   * `livenessReason` em AgentRuntimeState (durável, cross-run). Feature toggle:
   * `agent.continuationCap === 0` desliga (só limpa estado residual).
   *
   * US-F3.11 — AUDITADA e MANTIDA após o outputSchema (US-F3.5): o schema
   * garante FORMA, não TRABALHO. Um payload que casa o schema pode ser
   * exatamente um plan_only (summary+nextStep válidos, diff vazio), e a
   * PRÓPRIA rejeição de schema produz um resultado plan_only-shaped cujo
   * re-empurrão de retry é esta política. Não remover enquanto qualquer
   * runner puder devolver um run sem progresso — ou seja, sempre.
   */
  private async applyContinuationPolicy(
    storyId: string,
    liveness: RunLivenessState,
    runResult: AgentRunResult,
  ): Promise<void> {
    const cap = this.config.agent.continuationCap;

    // Run que avançou/concluiu → zera o contador e limpa o motivo (fim de
    // qualquer sequência de continuação). Também para blocked/needs_followup:
    // esses têm seus próprios fluxos (dep/HITL), não são continuação nossa.
    if (liveness === 'advanced' || liveness === 'completed' || liveness === 'blocked' || liveness === 'needs_followup' || liveness === 'failed') {
      await this.resetContinuation(storyId);
      return;
    }

    // Feature desligada → não faz nada além de garantir estado limpo.
    if (cap <= 0) {
      await this.resetContinuation(storyId);
      return;
    }

    // A partir daqui: plan_only | empty_response (recuperáveis, sem progresso).
    if (!CONTINUABLE_LIVENESS.includes(liveness)) {
      await this.resetContinuation(storyId);
      return;
    }

    const current = await this.prisma.agentRuntimeState.findUnique({
      where: { storyId },
      select: { continuationAttempt: true },
    });
    const attempt = current?.continuationAttempt ?? 0;

    if (attempt >= cap) {
      // Estourou o cap → cede ao fluxo normal (auto-step/anti-thrash). Limpa o
      // motivo para não injetar continuação eternamente, mas NÃO zera o
      // contador (anti-thrash usa o histórico de iterações; aqui só paramos de
      // "empurrar").
      await this.prisma.agentRuntimeState
        .update({ where: { storyId }, data: { livenessReason: null } })
        .catch(() => undefined);
      return;
    }

    const reason =
      liveness === 'plan_only'
        ? `Run anterior apenas PLANEJOU (sem diff/DOD). Execute agora o próximo passo: ${
            runResult.nextStep?.trim() || 'implemente a mudança planejada'
          }`
        : 'Run anterior não produziu resposta acionável. Retome do último passo e produza uma mudança concreta agora.';

    await this.prisma.agentRuntimeState.upsert({
      where: { storyId },
      update: { continuationAttempt: attempt + 1, livenessReason: reason },
      create: {
        sessionId: `ctx-${storyId}`,
        storyId,
        continuationAttempt: attempt + 1,
        livenessReason: reason,
      },
    });

    // Re-tick alvo: só útil quando NÃO há auto-play ativo (o interval já
    // re-tica sozinho). Enfileira um wake durável 'continuation' (coalesce).
    if (!this.autoTimers.has(storyId)) {
      await this.enqueueWakeup(storyId, 'continuation');
      const delay = this.config.agent.continuationDelayMs;
      setTimeout(() => {
        void this.stepStory(storyId).catch((err) =>
          this.logger.warn(
            `continuation step falhou (story=${storyId}): ${(err as Error).message}`,
          ),
        );
      }, delay);
    }
  }

  /** US-CTX3 — zera contador e limpa motivo de continuação (best-effort). */
  private async resetContinuation(storyId: string): Promise<void> {
    await this.prisma.agentRuntimeState
      .updateMany({
        where: { storyId, OR: [{ continuationAttempt: { gt: 0 } }, { livenessReason: { not: null } }] },
        data: { continuationAttempt: 0, livenessReason: null },
      })
      .catch(() => undefined);
  }

  /**
   * US-CTX2 (EP-CTX/ADR-0040) — grava o snapshot ESTRUTURADO de handoff em
   * `Card.completionMetadata` ao fechar a task (`done`). É consumido por
   * `buildContext` das tasks dependentes (parentHandoffs). Best-effort e
   * idempotente: sempre sobrescreve com o estado final da task.
   *
   * NÃO é um checklist (ADR-0007 proíbe DOR/acceptance) — é um retrato factual
   * do que foi feito, derivado do que já temos (context + runResult/evidence).
   */
  private async writeCompletionMetadata(
    taskId: string,
    context: Awaited<ReturnType<Orchestrator['buildContext']>>,
    runResult: AgentRunResult,
  ): Promise<void> {
    // changed_files: arquivos dos fluxos afetados + os declarados na evidência
    // estruturada (se houver), deduplicados e limitados.
    const fromFlows = context.files ?? [];
    const evidence = runResult.evidence;
    const fromEvidence =
      evidence && typeof evidence === 'object' && Array.isArray(evidence.filesChanged)
        ? evidence.filesChanged
        : [];
    const changedFiles = Array.from(
      new Set([...fromFlows, ...fromEvidence].filter((f) => typeof f === 'string' && f.trim())),
    ).slice(0, 60);

    // verification: a evidência verificável (checks) tem prioridade; senão, o
    // resumo textual da AI. String vazia quando nada foi reportado.
    let verification = '';
    if (evidence && typeof evidence === 'object' && Array.isArray(evidence.checks)) {
      const parts = evidence.checks
        .filter((c) => c && c.name)
        .map((c) => `${c.name}: ${c.passed ? 'passed' : 'failed'}`);
      verification = parts.join('; ');
    }
    if (!verification) {
      verification = (evidenceToString(evidence) || runResult.summary || '').slice(0, 1000);
    }

    const metadata: CompletionMetadata = {
      changed_files: changedFiles,
      verification: verification || undefined,
      dependencies: undefined,
      retry_notes: undefined,
      residual_risk: runResult.nextStep?.trim() ? runResult.nextStep.trim().slice(0, 500) : undefined,
    };

    await this.prisma.card.update({
      where: { id: taskId },
      data: { completionMetadata: metadata as unknown as Prisma.InputJsonValue },
    });
  }

  /**
   * US-CTX3 (EP-CTX/ADR-0040) — classifica o "liveness" de um run em uma das
   * categorias de {@link RunLivenessState}, para decidir se vale uma
   * CONTINUAÇÃO direcionada (plan_only/empty_response) ou se cede ao fluxo
   * normal (auto-step/anti-thrash). Função PURA (sem I/O).
   *
   * US-F3.11 — AUDITADA e MANTIDA após o outputSchema (US-F3.5), inclusive
   * `empty_response`: o schema torna summary vazio impossível SÓ no caminho
   * estruturado do TanStack; o CopilotCliRunner (produção) segue no marcador,
   * onde o CliAdapter coage summary/nextStep mal-tipados para '' (oráculo
   * cli-contract da US-F3.2) — o run "vazio" continua alcançável lá.
   */
  private classifyRunLiveness(
    runResult: AgentRunResult,
    iterationDiff: string,
    touched: string[],
    handoffState: string,
  ): RunLivenessState {
    if (runResult.fatalError) return 'failed';
    const hasDiff = (iterationDiff ?? '').trim().length > 0;
    const hasTouched = (touched ?? []).length > 0;
    const hasSummary = (runResult.summary ?? '').trim().length > 0;
    const hasNextStep = (runResult.nextStep ?? '').trim().length > 0;

    if (handoffState === 'done' || runResult.done) return 'completed';
    if (handoffState === 'blocked') return 'blocked';
    if (handoffState === 'awaiting-input') return 'needs_followup';
    if (hasDiff || hasTouched) return 'advanced';
    // Sem progresso concreto: só planejou (tem resumo/próximo passo) ou vazio.
    if (hasSummary || hasNextStep) return 'plan_only';
    return 'empty_response';
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
    // US-BLOCK3 — reverso do M3: acorda os dependentes cujo conjunto de blockers
    // ficou totalmente resolvido. Roda ANTES do deleteMany abaixo, pois lê as
    // arestas `TaskDependency` intactas para computar o `blockerSetHash`.
    await this.wakeBlockersResolvedDependents(taskId);
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
    // US-ROB3 — após o re-validate acima, promove dependentes que ficaram READY
    // mas nunca arrancaram (idle / de outra story do epic). Guardado por flag.
    await this.promoteReadyDependents(taskId);
  }

  /**
   * US-ROB3 — ao fechar `taskId`, recomputa quais dependentes ficaram READY e
   * garante que o auto-play da story-dona esteja ativo (via `onStoryEnterInProgress`,
   * caminho canônico que respeita serialização/concorrência/watchdog). Reusa
   * `pendingDeps` (loop-helpers); NÃO reimplementa a checagem de dependências.
   * Idempotente (onStoryEnterInProgress já é) e guardado por flag. Nunca acorda
   * story fora de In Progress (invariante 6).
   */
  private async promoteReadyDependents(taskId: string): Promise<void> {
    if (!this.config.agent.autostartDependents) return;

    const edges = await this.prisma.taskDependency.findMany({
      where: { dependsOnId: taskId },
      select: { dependentId: true },
    });
    const seenStories = new Set<string>();
    for (const { dependentId } of edges) {
      const dep = await this.loadTask(dependentId);
      if (!dep || dep.execState === 'done') continue;
      const byId = await this.loadSiblingsById(dependentId);
      if (pendingDeps(dep, byId).length > 0) continue; // ainda não READY

      const storyId = await this.resolveTaskStory(dependentId);
      if (!storyId || seenStories.has(storyId)) continue;
      seenStories.add(storyId);

      // Invariante 6: só promove se a story-dona está In Progress.
      if (!(await this.isStoryInProgress(storyId))) continue;

      await this.log(
        dependentId,
        `dependência ${taskId} resolvida → dependente pronto; garantindo auto-play`,
      );
      if (!this.isAutoRunning(storyId)) {
        await this.onStoryEnterInProgress(storyId);
      }
    }
  }

  /**
   * US-BLOCK3 — ponto de entrada público chamado pelo caminho de board/UI
   * (`CardsService.move`) quando um card `cardId` chega numa coluna "Done".
   * Espelha o gancho in-engine de `onTaskDone`: quando TODOS os blockers de um
   * dependente fecham, acorda o bloqueado exatamente uma vez. Totalmente
   * defensivo — uma falha aqui NUNCA pode derrubar o fluxo de mover card.
   */
  async onCardResolved(cardId: string): Promise<void> {
    try {
      await this.wakeBlockersResolvedDependents(cardId);
    } catch (err) {
      this.logger.warn(
        `onCardResolved falhou (card=${cardId}) — segue: ${(err as Error).message}`,
      );
    }
  }

  /**
   * US-BLOCK3 (reverso do M3) — ao fechar `cardId`, para cada dependente
   * (`TaskDependency where dependsOnId = cardId`) verifica se o conjunto INTEIRO
   * de blockers dele ficou resolvido. Regras:
   *  - Só `execState === 'done'` satisfaz um blocker; `cancelled`/qualquer outro
   *    estado deixa a aresta ABERTA (a story permanece bloqueada) — reusa
   *    `pendingDeps` (loop-helpers), que já trata só `done` como satisfação.
   *  - Invariante 6: só acorda story em "In Progress".
   *  - Idempotência: coalescing por story da WakeupQueue garante no-máx-1 wake
   *    não-terminal; um `blockerSetHash` (hash ordenado dos `dependsOnId`
   *    resolvidos) guardado no `stateJson` do `AgentRuntimeState` evita
   *    re-disparar para o MESMO conjunto se a story voltar a bloquear por outra
   *    causa (sem coluna nova).
   */
  private async wakeBlockersResolvedDependents(cardId: string): Promise<void> {
    const edges = await this.prisma.taskDependency.findMany({
      where: { dependsOnId: cardId },
      select: { dependentId: true },
    });
    const seenStories = new Set<string>();
    for (const { dependentId } of edges) {
      const dependent = await this.loadTask(dependentId);
      if (!dependent) continue;
      // Conjunto de blockers do dependente (todas as arestas dependsOn dele).
      if (dependent.dependsOn.length === 0) continue;
      // `cancelled` NÃO satisfaz: só `done` (execState OU coluna "Done") resolve
      // um blocker; qualquer outro estado deixa a aresta ABERTA.
      const allResolved = await this.allBlockersResolved(dependent.dependsOn);
      if (!allResolved) continue; // ainda bloqueado

      const storyId = await this.resolveTaskStory(dependentId);
      if (!storyId || seenStories.has(storyId)) continue;
      seenStories.add(storyId);

      // Invariante 6: só acorda story em In Progress.
      if (!(await this.isStoryInProgress(storyId))) continue;

      // blockerSetHash do conjunto resolvido — evita re-disparo p/ o MESMO set.
      const hash = this.blockerSetHash(dependent.dependsOn);
      if (await this.blockersAlreadyWaken(storyId, hash)) continue;

      await this.log(
        dependentId,
        `blockers resolvidos (fechou ${cardId}) → acordando story ${storyId}`,
      );
      await this.enqueueWakeup(storyId, 'blockers_resolved');
      await this.rememberBlockersWaken(storyId, hash);
      // Garante o re-dispatch mesmo com a wakeup queue OFF (caminho durável é o
      // preferido; este é o fallback in-process, idempotente).
      if (!this.isAutoRunning(storyId)) {
        await this.onStoryEnterInProgress(storyId);
      }
    }
  }

  /** Hash curto e ORDENADO dos ids de blockers de um conjunto (dedupe lógico). */
  private blockerSetHash(dependsOnIds: string[]): string {
    const canonical = [...new Set(dependsOnIds)].sort().join('|');
    return createHash('sha1').update(canonical).digest('hex').slice(0, 12);
  }

  /**
   * True SÓ se TODOS os blockers estão resolvidos. Um blocker está resolvido
   * quando `execState === 'done'` OU está na coluna "Done" (board ou mini-kanban)
   * — o caminho de board/UI move o card sem tocar `execState`. **`cancelled`
   * (ou qualquer estado/coluna que não seja "Done") NÃO satisfaz**: deixa a
   * aresta aberta.
   */
  private async allBlockersResolved(dependsOnIds: string[]): Promise<boolean> {
    for (const id of dependsOnIds) {
      const blocker = await this.prisma.card.findUnique({
        where: { id },
        select: {
          execState: true,
          boardColumn: { select: { title: true } },
          taskColumn: { select: { title: true } },
        },
      });
      if (!blocker) return false; // blocker ausente = aresta ainda aberta
      const doneByState = fromPrismaExecState(blocker.execState) === 'done';
      const doneByColumn =
        blocker.boardColumn?.title?.trim().toLowerCase() === 'done' ||
        blocker.taskColumn?.title?.trim().toLowerCase() === 'done';
      if (!doneByState && !doneByColumn) return false;
    }
    return true;
  }

  /**
   * US-BLOCK3 — leitura leve do último `blockerSetHash` já acordado, guardado no
   * `stateJson` do `AgentRuntimeState` (chave `blockersResolvedHash`). Defensivo:
   * na ausência da linha / JSON inválido, assume que ainda não acordou.
   */
  private async blockersAlreadyWaken(storyId: string, hash: string): Promise<boolean> {
    try {
      const row = await this.prisma.agentRuntimeState.findUnique({
        where: { sessionId: storyId },
        select: { stateJson: true },
      });
      if (!row) return false;
      const state = JSON.parse(row.stateJson ?? '{}') as { blockersResolvedHash?: string };
      return state.blockersResolvedHash === hash;
    } catch {
      return false;
    }
  }

  /** US-BLOCK3 — persiste (merge) o `blockerSetHash` acordado no `stateJson`. */
  private async rememberBlockersWaken(storyId: string, hash: string): Promise<void> {
    try {
      const row = await this.prisma.agentRuntimeState.findUnique({
        where: { sessionId: storyId },
        select: { stateJson: true },
      });
      let state: Record<string, unknown> = {};
      if (row) {
        try {
          state = JSON.parse(row.stateJson ?? '{}') as Record<string, unknown>;
        } catch {
          state = {};
        }
      }
      state.blockersResolvedHash = hash;
      const stateJson = JSON.stringify(state);
      await this.prisma.agentRuntimeState.upsert({
        where: { sessionId: storyId },
        update: { stateJson },
        create: { sessionId: storyId, storyId, stateJson },
      });
    } catch (err) {
      // Best-effort: sem o hash o pior caso é um wake extra (coalescido pela
      // WakeupQueue). Nunca derruba o fluxo.
      this.logger.warn(
        `rememberBlockersWaken falhou (story=${storyId}) — segue: ${(err as Error).message}`,
      );
    }
  }

  /** Story-dona de uma task (parentId). Null se a task não existir / for órfã. */
  private async resolveTaskStory(taskId: string): Promise<string | null> {
    const task = await this.prisma.card.findUnique({
      where: { id: taskId },
      select: { parentId: true },
    });
    return task?.parentId ?? null;
  }

  /** True se a story está numa coluna de board "In Progress" (invariante 6). */
  private async isStoryInProgress(storyId: string): Promise<boolean> {
    const story = await this.prisma.card.findUnique({
      where: { id: storyId },
      select: { boardColumn: { select: { title: true, isTaskColumn: true } } },
    });
    const col = story?.boardColumn;
    return !!col && !col.isTaskColumn && col.title.toLowerCase() === 'in progress';
  }

  /**
   * Decide, ao falhar a validação, entre DERIVAR uma task de correção ou
   * ESCALAR para humano. Extraído para ser testável em isolamento (todo #4):
   * dois caps escalam (em vez de derivar em cadeia infinita):
   *   - #2 profundidade de derivação: `derivedDepth >= AGENT_MAX_DERIVED_DEPTH`
   *   - #3 falhas de validação: `validationFailures >= AGENT_MAX_VALIDATION_FAILURES`
   * O cap de profundidade tem precedência. `0` desliga o cap de profundidade.
   */
  private decideValidationFailureAction(
    depth: number,
    validationFailures: number,
  ):
    | { action: 'escalate'; reasonKind: 'depth' | 'failures'; reason: string; log: string }
    | { action: 'derive' } {
    const maxDerivedDepth = this.config.agent.maxDerivedDepth;
    const maxValidationFailures = this.config.agent.maxValidationFailures;
    if (maxDerivedDepth > 0 && depth >= maxDerivedDepth) {
      const reason = `profundidade de derivação atingida (${depth} ≥ ${maxDerivedDepth})`;
      return {
        action: 'escalate',
        reasonKind: 'depth',
        reason,
        log: `cap de derivação: ${reason} — task marcada como "precisa de humano"; auto-play parado`,
      };
    }
    if (validationFailures >= maxValidationFailures) {
      return {
        action: 'escalate',
        reasonKind: 'failures',
        reason: `validação falhou ${validationFailures}x (limite ${maxValidationFailures})`,
        log: `validação falhou ${validationFailures}x (limite ${maxValidationFailures}) — marcada como "precisa de humano"; auto-play parado`,
      };
    }
    return { action: 'derive' };
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
          derivedDepth: (origin.derivedDepth ?? 0) + 1,
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

  /**
   * Conta quantas tasks de correção ABERTAS (`execState != done`) para o MESMO
   * problema já existem como irmãs sob o mesmo `parentId` (story). A âncora é o
   * título canônico `Corrigir: ${problem.title}` produzido por
   * `createDerivedTask`. Base do dedup + cap agregado por problema (evita o loop
   * de derivações paralelas que escapa do cap de profundidade). `parentId` nulo
   * (task órfã) retorna 0 — sem irmãs para deduplicar.
   */
  private async countOpenDerivedForProblem(
    parentId: string | null,
    problemTitle: string,
  ): Promise<number> {
    if (!parentId) return 0;
    return this.prisma.card.count({
      where: {
        parentId,
        type: 'task',
        title: `Corrigir: ${problemTitle}`,
        execState: { not: 'done' },
      },
    });
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
    // US-COLAB3: registra a intenção durável (coalesce) antes de agir.
    await this.enqueueWakeup(storyId, 'manual_step');
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
    // Story concluída/parada: libera o slot (sessão + watchdog) para que a
    // SERIALIZAÇÃO possa iniciar uma story pendente do mesmo epic (ou repo-alvo,
    // quando serializeByRepo). Não há worktree a destruir — o agent codou direto
    // no repo-alvo e o trabalho permanece no working tree (comportamento
    // desejado). O cleanupWorktree apenas solta o tracking em memória.
    this.sessions.remove(storyId);
    this.clearWatchdog(storyId);
    this.clearHeartbeat(storyId); // US-HARD1: solta o tmpfile de heartbeat
    void this.releaseClaim(storyId); // US-ROB4: solta o lease ao encerrar
    // US-COLAB3: fecha o wakeup durável (status=done) ANTES de drenar a fila,
    // para que a próxima story do epic não veja este item como ativo. Defensivo
    // e no-op quando o flag está OFF.
    if (this.wakeupEnabled) {
      void this.wakeupQueue!
        .complete(storyId)
        .catch((err) =>
          this.logger.warn(
            `wakeupQueue.complete falhou (story=${storyId}): ${(err as Error).message}`,
          ),
        );
      // US-SCHED1: auto-clear do monitor (one-shot) ao sair de In Progress
      // (terminal ou pausa). O agent pode re-armar se ainda estiver esperando.
      void this.wakeupQueue!
        .clearMonitor(storyId)
        .catch((err) =>
          this.logger.warn(
            `wakeupQueue.clearMonitor falhou (story=${storyId}): ${(err as Error).message}`,
          ),
        );
    }
    void this.workspaces.cleanupWorktree(storyId).catch(() => undefined);
    // SERIALIZAÇÃO: destrava a próxima story que estava aguardando este epic/repo.
    void this.resumeDeferredForStory(storyId).catch(() => undefined);
  }

  /**
   * SERIALIZAÇÃO: ao liberar uma story, procura stories que estão em "In
   * Progress" no board mas SEM sessão ativa (foram adiadas por conflito de
   * serialização — mesmo epic, ou mesmo repo-alvo quando `serializeByRepo`) e
   * reinicia o loop de UMA delas. Chamado quando uma story termina.
   *
   * @param finishedStoryId story que acabou de liberar o slot (ignorada na busca).
   */
  private async resumeDeferredForStory(finishedStoryId: string): Promise<void> {
    const freedEpic = await this.resolveStoryEpic(finishedStoryId);
    const freedProject = this.config.agent.serializeByRepo
      ? await this.resolveStoryProject(finishedStoryId)
      : null;
    if (!freedEpic && !freedProject) return;

    // Stories em colunas "In Progress" do board, sem sessão ativa.
    const inProgressCols = await this.prisma.column.findMany({
      where: { isTaskColumn: false, title: 'In Progress' },
      select: { id: true },
    });
    if (inProgressCols.length === 0) return;
    const candidates = await this.prisma.card.findMany({
      where: {
        type: 'story',
        boardColumnId: { in: inProgressCols.map((c) => c.id) },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });

    for (const cand of candidates) {
      if (cand.id === finishedStoryId) continue;
      if (this.sessions.get(cand.id)) continue; // já ativa
      let matches = false;
      if (freedEpic) {
        const candEpic = await this.resolveStoryEpic(cand.id);
        if (candEpic && candEpic === freedEpic) matches = true;
      }
      if (!matches && freedProject) {
        const candProject = await this.resolveStoryProject(cand.id);
        if (candProject && candProject === freedProject) matches = true;
      }
      if (matches) {
        // Só reinicia se ainda houver conflito real (evita re-disparar uma story
        // que já poderia iniciar sozinha). onStoryEnterInProgress reavalia.
        await this.log(
          cand.id,
          'serialização liberada — o epic/repo-alvo ficou livre; iniciando o loop desta story.',
        );
        await this.onStoryEnterInProgress(cand.id);
        return; // uma por vez
      }
    }
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

      // US-BLOCK4: fluxo feliz — zera o contador de recorrência de bloqueio.
      await this.resetBlockRecurrence(storyId);

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
      const marker = `<!-- story-summary:${storyId} -->`;
      const lines: string[] = [marker];
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

      // Idempotência: uma story só deixa UM resumo por épico. Sem isso, cada
      // re-conclusão (ou um loop de encadeamento) acumularia comentários
      // duplicados no épico, inflando o prompt cross-story até estourar o
      // limite de argv do runner (spawn E2BIG). Se já houver um resumo desta
      // story, atualizamos em vez de criar outro.
      const existing = await this.prisma.comment.findFirst({
        where: { cardId: epicId, text: { startsWith: marker } },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.comment.update({
          where: { id: existing.id },
          data: { text: lines.join('\n') },
        });
      } else {
        await this.prisma.comment.create({
          data: { cardId: epicId, authorId: 'ai', text: lines.join('\n') },
        });
      }
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

      // Próxima story ainda pendente de trabalho: não pode estar em Done, nem
      // em In Progress, nem em Review. "Review" significa que o agent já
      // concluiu e está aguardando revisão humana — reencadeá-la criaria um
      // ciclo (promote→advance→promote). Só encadeamos stories que ainda não
      // começaram (Backlog / To Do).
      const next = stories.find((s) => {
        if (s.id === finishedStoryId) return false;
        const title = s.boardColumnId ? byId.get(s.boardColumnId) : undefined;
        return title !== 'done' && title !== 'in progress' && title !== 'review';
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
    this.touchHeartbeat(storyId); // US-HARD1: batida inicial ao acordar a sessão
    const handle = setInterval(() => {
      void this.tickWatchdog(storyId);
    }, this.config.agent.watchdogIntervalMs);
    this.watchdogs.set(storyId, handle);
  }

  // ── US-HARD1 · heartbeat por sessão (SEM Redis, invariante 7) ────────────
  // Um tmpfile por story cujo MTIME é "batido" a cada iteração/acordar. É o
  // sinal barato de vivacidade lido pelo watchdog adaptativo (decideStuck). Sem
  // schema churn no Postgres: mtime é o timestamp. Tudo best-effort (uma falha
  // de FS nunca derruba o loop — só perde a batida, o lease ainda cobre).

  /** Caminho do tmpfile de heartbeat de uma story (estável entre iterações). */
  private heartbeatPath(storyId: string): string {
    const safe = storyId.replace(/[^A-Za-z0-9_.-]/g, '_');
    return join(tmpdir(), `kanban-ai-hb-${safe}`);
  }

  /** Bate o heartbeat: cria/atualiza o mtime do tmpfile da story. */
  private touchHeartbeat(storyId: string): void {
    const path = this.heartbeatPath(storyId);
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      // Arquivo ainda não existe — cria (e o mtime nasce = agora).
      try {
        closeSync(openSync(path, 'w'));
      } catch {
        /* defensivo: FS indisponível — só perde a batida */
      }
    }
  }

  /** Lê o mtime (epoch-ms) do heartbeat; `null` se ausente/ilegível. */
  private readHeartbeatMs(storyId: string): number | null {
    try {
      return statSync(this.heartbeatPath(storyId)).mtimeMs;
    } catch {
      return null;
    }
  }

  /** Remove o tmpfile de heartbeat ao encerrar/limpar uma sessão. */
  private clearHeartbeat(storyId: string): void {
    void rm(this.heartbeatPath(storyId), { force: true }).catch(() => undefined);
  }

  // ── US-ROB4 · claim/lease por execução ──────────────────────────────────
  // O lease vive em Postgres (AgentRuntimeState.claimLock/claimExpiresAt) + um
  // tick in-process (SEM Redis, invariante 7). O watchdog RENOVA o lease
  // enquanto a sessão vive (heartbeat por iteração) e RECUPERA o slot quando
  // vence. Preserva a salvaguarda #3: só age em claim vencido (ou sessão dead).

  /** Adquire/renova o claim da story por TTL. leaseId = sessionId estável. */
  private async claimStory(storyId: string): Promise<void> {
    if (!this.config.agent.claimEnabled) return;
    const ttl = this.config.agent.claimTtlMs;
    try {
      await this.prisma.agentRuntimeState.update({
        where: { sessionId: storyId },
        data: { claimLock: storyId, claimExpiresAt: new Date(Date.now() + ttl) },
      });
    } catch (err) {
      // Defensivo: a linha pode ainda não existir (persistState é fire-and-
      // forget). Um claim perdido só adia a recuperação até o próximo tick.
      this.logger.warn(
        `claimStory falhou (story=${storyId}) — loop segue: ${(err as Error).message}`,
      );
    }
  }

  /** Heartbeat: renova o lease enquanto a sessão itera (chamado por iteração). */
  private async renewClaim(storyId: string): Promise<void> {
    if (!this.config.agent.claimEnabled) return;
    await this.claimStory(storyId);
  }

  /** Solta o claim ao encerrar a story (junto do remove/finishAuto). */
  private async releaseClaim(storyId: string): Promise<void> {
    if (!this.config.agent.claimEnabled) return;
    try {
      await this.prisma.agentRuntimeState.update({
        where: { sessionId: storyId },
        data: { claimLock: null, claimExpiresAt: null },
      });
    } catch {
      /* defensivo: linha pode não existir — nada a soltar */
    }
  }

  /**
   * Recovery de claims vencidos — espelha `MemoryLockService.expireStale`. Busca
   * execuções com `claimExpiresAt <= now` cujo processo não as mantém vivas e as
   * libera: remove a sessão in-process (se houver), limpa o watchdog e marca a
   * linha como `stalled` para a serialização liberar o slot. Idempotente.
   */
  private async recoverStaleClaims(nowMs = Date.now()): Promise<number> {
    if (!this.config.agent.claimEnabled) return 0;
    let stale: Array<{ storyId: string }> = [];
    try {
      stale = await this.prisma.agentRuntimeState.findMany({
        where: { claimExpiresAt: { lte: new Date(nowMs) }, NOT: { claimLock: null } },
        select: { storyId: true },
      });
    } catch (err) {
      this.logger.warn(`recoverStaleClaims: leitura falhou: ${(err as Error).message}`);
      return 0;
    }
    for (const { storyId } of stale) {
      this.logger.warn(`Claim vencido para story=${storyId} — recuperando slot`);
      this.sessions.remove(storyId);
      this.clearWatchdog(storyId);
      this.clearHeartbeat(storyId);
      void this.workspaces.cleanupWorktree(storyId).catch(() => undefined);
      try {
        await this.prisma.agentRuntimeState.update({
          where: { sessionId: storyId },
          data: { claimLock: null, claimExpiresAt: null, livenessState: 'stalled' },
        });
      } catch {
        /* defensivo: não pode derrubar o recovery dos demais */
      }
      // Libera a serialização (mesmo caminho de finishAuto).
      void this.resumeDeferredForStory(storyId).catch(() => undefined);
    }
    return stale.length;
  }

  private async tickWatchdog(storyId: string): Promise<void> {
    const session = this.sessions.get(storyId);
    if (!session) return;
    // Salvaguarda #3: só age em sessões mortas; nunca duplica iteração running.
    if (session.state === 'dead') {
      this.logger.warn(`Watchdog: sessão morta para story=${storyId} — limpando`);
      this.sessions.remove(storyId);
      this.clearWatchdog(storyId);
      this.clearHeartbeat(storyId);
      void this.workspaces.cleanupWorktree(storyId).catch(() => undefined);
      return;
    }

    // US-HARD1 — decisão ADAPTATIVA de "travado": além da sessão `dead`, detecta
    // uma sessão nominalmente "running" cujo heartbeat envelheceu além do teto
    // efetivo. O teto ALARGA enquanto uma operação longa está DECLARADA
    // (toolDeclaredTimeoutMs, US-HARD5) — uma op longa legítima NÃO é morta cedo.
    // A decisão é PURA (decideStuck); aqui só coletamos os sinais (heartbeat +
    // claimExpiresAt) e agimos idempotentemente (salvaguarda #3).
    const now = Date.now();
    const lastHeartbeatAt = this.readHeartbeatMs(storyId);
    const claimExpiresAt = await this.readClaimExpiresAtMs(storyId);
    const decision = decideStuck({
      now,
      lastHeartbeatAt,
      baseCeilingMs: this.config.agent.stuckHeartbeatCeilingMs,
      declaredTimeoutMs: this.config.agent.toolDeclaredTimeoutMs,
      claimExpiresAt,
    });
    if (decision.stuck) {
      this.logger.warn(
        `Watchdog: sessão travada (stuck) para story=${storyId} — ${decision.reason}. Recuperando slot.`,
      );
      await this.recoverStuckStory(storyId);
    }
  }

  /**
   * US-HARD1 — lê `AgentRuntimeState.claimExpiresAt` (epoch-ms) da story, ou
   * `null` se ausente/claim desligado. Best-effort (uma falha de DB não pode
   * derrubar o watchdog — a decisão de stuck ainda considera o heartbeat).
   */
  private async readClaimExpiresAtMs(storyId: string): Promise<number | null> {
    if (!this.config.agent.claimEnabled) return null;
    try {
      const row = await this.prisma.agentRuntimeState.findUnique({
        where: { sessionId: storyId },
        select: { claimExpiresAt: true },
      });
      return row?.claimExpiresAt?.getTime() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * US-HARD1 — recupera UMA story detectada como travada. Espelha o que
   * `recoverStaleClaims` faz por linha (aborta/remove sessão, limpa watchdog,
   * heartbeat e worktree, marca `livenessState='stalled'`, solta o claim e
   * destrava a serialização). Idempotente: seguro reentrar.
   */
  private async recoverStuckStory(storyId: string): Promise<void> {
    this.sessions.abort(storyId); // salvaguarda #4: AbortSignal
    this.sessions.remove(storyId);
    this.clearWatchdog(storyId);
    this.clearHeartbeat(storyId);
    void this.workspaces.cleanupWorktree(storyId).catch(() => undefined);
    try {
      await this.prisma.agentRuntimeState.update({
        where: { sessionId: storyId },
        data: { claimLock: null, claimExpiresAt: null, livenessState: 'stalled' },
      });
    } catch {
      /* defensivo: linha pode não existir — recovery segue */
    }
    void this.resumeDeferredForStory(storyId).catch(() => undefined);
    // US-OBS2-5 — lane de recuperação status-only: após normalizar o estado,
    // dispara UM wake BARATO (modelo `cheapModelId`) só para pedir intervenção
    // humana / normalizar resíduos, com guard explícito para a AI NÃO produzir
    // trabalho entregável. Best-effort e não-bloqueante: a recuperação do slot
    // (acima) NUNCA pode depender deste dispatch.
    void this.dispatchRecoveryWake(storyId).catch((err) =>
      this.logger.warn(
        `dispatchRecoveryWake(story=${storyId}) falhou (recuperação já concluída): ${String(err)}`,
      ),
    );
  }

  /**
   * US-OBS2-5 — dispara um dispatch de RECUPERAÇÃO status-only para a story:
   * roda UMA iteração com o modelo BARATO (`recovery:true` → `resolveDispatchModel`)
   * e o guard de "não produza entregável" injetado no prompt. Escolhe a task
   * mais relevante da story (a que estava em progresso; senão a próxima pronta).
   * No-op silencioso se a story não tiver task acionável. Best-effort.
   */
  private async dispatchRecoveryWake(storyId: string): Promise<void> {
    const tasks = await this.loadStoryTasks(storyId);
    if (tasks.length === 0) return;
    const target =
      tasks.find((t) => t.execState !== 'done' && t.execState !== 'idle') ??
      tasks.find((t) => t.execState !== 'done');
    if (!target) return;
    await this.runIteration(target.id, { recovery: true });
  }

  /** Para o loop de uma story (graceful: termina o passo atual; hard: aborta). */
  async stop(storyId: string, mode: StopMode): Promise<void> {
    this.stopRequested.set(storyId, mode);
    if (mode === 'hard') {
      this.sessions.abort(storyId); // salvaguarda #4: AbortSignal
      this.finishAuto(storyId, 'hard');
      this.clearWatchdog(storyId);
      this.clearHeartbeat(storyId);
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
   * US-BLOCK2 (EP-BLOCK / ADR-0039) — roteia um card que entra em `blocked` por
   * um {@link BlockedDescriptor} typed. Persiste o descriptor no card e decide o
   * dono do unblock:
   *
   *  - `owner` = agentId  → enfileira **1** wake idempotente `issue_unblock` à
   *    story. A idempotência vem do coalescing por story do
   *    {@link WakeupQueueService} (no máx. 1 wake não-terminal por story) MAIS o
   *    anti re-fire por `blockedOwnerNotifiedAt`: só notifica se o card ainda não
   *    foi notificado NESTE bloqueio (campo null ou anterior à entrada em
   *    blocked). Ao disparar, grava `blockedOwnerNotifiedAt = now`.
   *  - `owner` = `'board'` OU descriptor ausente/malformado (prose-only) →
   *    `needsHuman = true` (needs_attention humano). NÃO enfileira wake.
   *
   * Aditivo/retrocompatível: `Card.blocked`/`needsHuman` permanecem. Defensivo
   * quanto à fila (nunca derruba o loop).
   */
  async routeBlockedCard(
    cardId: string,
    storyId: string,
    descriptor: BlockedDescriptor | null | undefined,
    blockedEnteredAt: Date = new Date(),
  ): Promise<{ routedTo: 'agent' | 'human'; wakeEnqueued: boolean }> {
    const owner = descriptor?.owner;
    const action = descriptor?.action;
    // Prose-only: descriptor ausente/malformado, ou dono = board => needsHuman.
    if (
      typeof owner !== 'string' ||
      owner.length === 0 ||
      typeof action !== 'string' ||
      action.length === 0 ||
      owner === 'board'
    ) {
      const reason =
        owner === 'board'
          ? action || 'Bloqueio direcionado ao board (humano).'
          : 'Bloqueio sem descriptor typed (prose-only) — precisa de intervenção humana.';
      await this.prisma.card.update({
        where: { id: cardId },
        data: {
          blocked: true,
          needsHuman: true,
          needsHumanReason: reason,
          blockedDescriptor: (descriptor ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        },
      });
      this.realtime.broadcast({ type: 'card.needs_human', taskId: cardId, storyId, reason });
      return { routedTo: 'human', wakeEnqueued: false };
    }

    // owner = agentId → auto-notify por wake, anti re-fire por notifiedAt.
    const current = await this.prisma.card.findUnique({
      where: { id: cardId },
      select: { blockedOwnerNotifiedAt: true },
    });
    const notifiedAt = current?.blockedOwnerNotifiedAt ?? null;
    const alreadyNotified = notifiedAt != null && notifiedAt >= blockedEnteredAt;

    await this.prisma.card.update({
      where: { id: cardId },
      data: {
        blocked: true,
        blockedDescriptor: descriptor as unknown as Prisma.InputJsonValue,
        ...(alreadyNotified ? {} : { blockedOwnerNotifiedAt: new Date() }),
      },
    });

    if (alreadyNotified) {
      return { routedTo: 'agent', wakeEnqueued: false };
    }
    await this.enqueueWakeup(storyId, 'issue_unblock');
    return { routedTo: 'agent', wakeEnqueued: true };
  }

  /**
   * Caminho de resgate ("needs human"): marca a task, para o auto-play graceful
   * e emite `card.needs_human`. Reusado pelo limite de falhas de validação
   * (#5), pelo gate de custo (#1) e pelo anti-thrash (#3).
   *
   * Além de marcar a flag, registra uma PERGUNTA HITL sintética (AgentMessage
   * role=ai + questionId + opções) e emite `agent.question`. Sem isso, a task
   * exibiria o badge "🙋 precisa de você" mas o chat ficaria bloqueado (não há
   * pergunta pendente para o `ChatPanel` reidratar) — o humano veria o problema
   * sem ter como responder/destravar. Com a pergunta sintética, `answerQuestion`
   * (caminho de resiliência) limpa `needsHuman` e retoma a iteração.
   */
  /**
   * EP-BLOCK / US-BLOCK4 — loop-breaker de recorrência de bloqueio (cross-run).
   *
   * Computa uma assinatura da causa do bloqueio (`blockKind` + hash curto do
   * motivo) e a compara com a última causa registrada no `AgentRuntimeState`
   * (durável, sobrevive a recovery/restart). Se a MESMA causa recorre, incrementa
   * `consecutiveBlockCount`; se mudou, reseta o contador para 1. Retorna `true`
   * quando o contador atinge `maxConsecutiveBlocks` (default 2, env
   * `AGENT_MAX_CONSECUTIVE_BLOCKS`; `0` desliga) — sinal para o chamador escalar
   * a humano em vez de re-ciclar `blocked↔unblocked`. Ver ADR-0039.
   */
  private async recordBlockRecurrence(
    storyId: string,
    kind: BlockKind,
    reason: string,
  ): Promise<boolean> {
    const cap = this.config.agent.maxConsecutiveBlocks;
    if (cap <= 0) return false; // gate desligado
    const signature = `${kind}:${createHash('sha1').update(reason).digest('hex').slice(0, 12)}`;
    try {
      const prev = await this.prisma.agentRuntimeState.findUnique({
        where: { storyId },
        select: { lastBlockReason: true, consecutiveBlockCount: true },
      });
      const same = prev?.lastBlockReason === signature;
      const nextCount = same ? (prev?.consecutiveBlockCount ?? 0) + 1 : 1;
      // upsert defensivo: a linha de runtime pode ainda não existir para a story.
      await this.prisma.agentRuntimeState.upsert({
        where: { storyId },
        create: {
          sessionId: storyId,
          storyId,
          lastBlockReason: signature,
          consecutiveBlockCount: nextCount,
        },
        update: { lastBlockReason: signature, consecutiveBlockCount: nextCount },
      });
      return nextCount >= cap;
    } catch (err) {
      this.logger.warn(
        `recordBlockRecurrence falhou (story=${storyId}): ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * US-BLOCK4 — zera o contador de recorrência ao CONCLUIR a story (fluxo feliz).
   * Chamado de `promoteStory`. Idempotente e defensivo.
   */
  private async resetBlockRecurrence(storyId: string): Promise<void> {
    try {
      await this.prisma.agentRuntimeState.updateMany({
        where: { storyId },
        data: { consecutiveBlockCount: 0, lastBlockReason: null },
      });
    } catch (err) {
      this.logger.warn(
        `resetBlockRecurrence falhou (story=${storyId}): ${(err as Error).message}`,
      );
    }
  }

  private async escalateToHuman(
    taskId: string,
    storyId: string,
    reason: string,
    logMessage: string,
    kind: BlockKind = 'capability',
  ): Promise<void> {
    await this.prisma.card.update({
      where: { id: taskId },
      data: { needsHuman: true, needsHumanReason: reason, blockKind: kind },
    });

    // Pergunta HITL sintética: dá ao humano um canal de resposta para destravar
    // a task escalada por um gate (cap/custo/thrash/validação), que NÃO passa
    // pelo fluxo `onQuestion` da AI. As opções guiam a intervenção; qualquer
    // texto livre também é aceito (o `answerQuestion` retoma a iteração).
    const questionId = randomUUID();
    const prompt =
      `A execução automática foi pausada e preciso de você: ${reason}. ` +
      'Como devo prosseguir? Você pode escolher uma opção ou escrever uma orientação.';
    const options = ['Retomar do ponto atual', 'Revisar o plano e continuar'];
    await this.prisma.agentMessage.create({
      data: {
        cardId: taskId,
        role: 'ai',
        text: prompt,
        questionId,
        options,
      },
    });

    // Para o auto-play da story sem abortar hard (graceful): preserva o estado
    // no Postgres e deixa o próximo tick encerrar limpo.
    await this.stop(storyId, 'graceful');
    this.realtime.broadcast({ type: 'card.needs_human', taskId, storyId, reason });
    // Espelha a pergunta sintética para o chat abrir ao vivo (sem depender de F5
    // + hydrate). Mesmo shape do HITL normal (onQuestion).
    this.realtime.broadcast({
      type: 'agent.question',
      taskId,
      storyId,
      questionId,
      prompt,
      options,
    });
    await this.log(taskId, logMessage);
  }

  /**
   * Salvaguardas por-iteração fecham o ciclo métrica→ação (#1) e anti-thrash
   * (#3). Rodam ANTES de gastar uma nova iteração:
   *
   *  - **Cap de iterações**: se a task já acumulou `maxIterationsPerTask`
   *    iterações persistidas (0 = desligado; LIGADO por default), escala para
   *    humano — proteção anti-loop-infinito.
   *  - **Gate de custo**: soma `durationMs` e (input+output) tokens já gastos
   *    pela task; se ultrapassar `maxTaskDurationMs`/`maxTaskTokens` (0 = gate
   *    desligado), escala para humano com reason de custo.
   *  - **Anti-thrash**: compara `summary`+`nextStep` das últimas `thrashWindow`
   *    iterações; se estiverem quase idênticas (≥ `thrashSimilarityThreshold`),
   *    escala para humano (a AI está travada repetindo a mesma coisa).
   *
   * Retorna `true` se escalou (o chamador deve abortar a iteração).
   */
  private async enforceLoopGuards(taskId: string, storyId: string): Promise<boolean> {
    const {
      maxIterationsPerTask,
      maxUnproductiveIterations,
      maxTaskDurationMs,
      maxTaskTokens,
      thrashDetectionEnabled,
      thrashSimilarityThreshold,
      thrashWindow,
    } = this.config.agent;

    const iterationCapOn = maxIterationsPerTask > 0;
    const unproductiveCapOn = maxUnproductiveIterations > 0;
    const costGateOn = maxTaskDurationMs > 0 || maxTaskTokens > 0;
    const thrashOn = thrashDetectionEnabled && thrashWindow >= 2;
    if (!iterationCapOn && !unproductiveCapOn && !costGateOn && !thrashOn) return false;

    const iterationsAll = await this.prisma.iteration.findMany({
      where: { cardId: taskId },
      orderBy: { index: 'asc' },
      select: {
        ts: true,
        durationMs: true,
        inputTokens: true,
        outputTokens: true,
        summary: true,
        handoffNextStep: true,
        phase: true,
        diff: true,
        dodTouched: true,
      },
    });
    if (iterationsAll.length === 0) return false;

    // "Perdão" pós-intervenção humana: quando o humano responde uma escalação
    // (needsHuman), a task é destravada e o loop retomado. Se os guards
    // continuassem contando desde o início (caps CUMULATIVOS), a primeira
    // iteração retomada re-escalaria imediatamente — deixando a task presa. Por
    // isso, todos os caps passam a contar A PARTIR da última resposta humana:
    // filtramos as iterações anteriores a ela. Sem intervenção, o comportamento
    // é idêntico ao anterior (janela = todas as iterações).
    const lastHumanAnswer = await this.prisma.agentMessage.findFirst({
      where: { cardId: taskId, role: 'user' },
      orderBy: { ts: 'desc' },
      select: { ts: true },
    });
    const iterations = lastHumanAnswer
      ? iterationsAll.filter((it) => it.ts > lastHumanAnswer.ts)
      : iterationsAll;
    if (iterations.length === 0) return false;

    // Cap de iterações (#1 — anti-loop-infinito). Roda antes do gate de custo:
    // se a task já acumulou muitas iterações, provavelmente está em loop.
    if (iterationCapOn && iterations.length >= maxIterationsPerTask) {
      const reason = `cap de iterações atingido (${iterations.length} ≥ ${maxIterationsPerTask}) — possível loop infinito`;
      await this.escalateToHuman(
        taskId,
        storyId,
        reason,
        `cap de iterações: ${reason} — task marcada como "precisa de humano"; auto-play parado`,
      );
      return true;
    }

    // Cap de iterações IMPRODUTIVAS consecutivas (#4 — anti-deadlock de
    // blocked_dep/derivações que ciclam sem produzir código). Conta, do fim
    // para o começo, iterações de fase `implementation` que NÃO produziram nada:
    // nem `diff` no worktree NEM avanço de DOD (`dodTouched` vazio). Para na
    // primeira iteração PRODUTIVA (com diff OU que fechou ≥1 item de DOD).
    //
    // Por que considerar `dodTouched` (correção do deadlock de fechamento de
    // DOD): uma task saudável tem fase(s) de implementação (com diff) seguida(s)
    // de fase(s) de FECHAMENTO de itens de DOD de verificação ("build/lint/test
    // verde", "tipo exportado pelo barrel") que legitimamente NÃO geram diff. Se
    // contássemos essas iterações de fechamento como improdutivas, toda task
    // escalaria para humano ao fechar o DOD — deadlock. Uma iteração que fecha
    // um item de DOD avançou o trabalho e portanto é produtiva.
    if (unproductiveCapOn) {
      let consecutiveUnproductive = 0;
      for (let i = iterations.length - 1; i >= 0; i--) {
        const it = iterations[i];
        if (it.phase !== 'implementation') continue;
        const noDiff = (it.diff ?? '').trim().length === 0;
        const noDodProgress = (it.dodTouched?.length ?? 0) === 0;
        if (noDiff && noDodProgress) {
          consecutiveUnproductive += 1;
        } else {
          break;
        }
      }
      if (consecutiveUnproductive >= maxUnproductiveIterations) {
        const reason = `iterações improdutivas consecutivas (${consecutiveUnproductive} ≥ ${maxUnproductiveIterations}) — nenhuma mudança no worktree nem avanço de DOD; possível deadlock`;
        await this.escalateToHuman(
          taskId,
          storyId,
          reason,
          `cap de iterações improdutivas: ${reason} — task marcada como "precisa de humano"; auto-play parado`,
        );
        return true;
      }
    }
    if (maxTaskDurationMs > 0) {
      const totalMs = iterations.reduce((a, it) => a + (it.durationMs ?? 0), 0);
      if (totalMs >= maxTaskDurationMs) {
        const reason = `orçamento de tempo excedido (${totalMs}ms ≥ ${maxTaskDurationMs}ms)`;
        await this.escalateToHuman(
          taskId,
          storyId,
          reason,
          `gate de custo: ${reason} — task marcada como "precisa de humano"; auto-play parado`,
        );
        return true;
      }
    }
    if (maxTaskTokens > 0) {
      const totalTokens = iterations.reduce(
        (a, it) => a + (it.inputTokens ?? 0) + (it.outputTokens ?? 0),
        0,
      );
      if (totalTokens >= maxTaskTokens) {
        const reason = `orçamento de tokens excedido (${totalTokens} ≥ ${maxTaskTokens})`;
        await this.escalateToHuman(
          taskId,
          storyId,
          reason,
          `gate de custo: ${reason} — task marcada como "precisa de humano"; auto-play parado`,
        );
        return true;
      }
    }

    // Anti-thrash (#3).
    if (thrashOn) {
      const samples: ThrashSample[] = iterations.map((it) => ({
        summary: it.summary ?? '',
        nextStep: it.handoffNextStep ?? '',
      }));
      if (isThrashing(samples, thrashSimilarityThreshold, thrashWindow)) {
        const reason = 'AI travada (iterações repetitivas sem progresso)';
        await this.escalateToHuman(
          taskId,
          storyId,
          reason,
          `anti-thrash: ${reason} — ${thrashWindow} iterações com similaridade ≥ ${thrashSimilarityThreshold}; task marcada como "precisa de humano"; auto-play parado`,
        );
        return true;
      }
    }

    return false;
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
    // Se a task estava escalada (needsHuman), a resposta humana é a intervenção
    // que a destrava: limpamos a flag/reason para que o card saia do estado
    // "🙋 precisa de você" e o loop possa retomar. Inofensivo para o HITL normal
    // (needsHuman já era false). Os guards de cap/thrash passam a contar a
    // partir desta intervenção (ver enforceLoopGuards), evitando re-escalar na
    // primeira iteração retomada.
    await this.prisma.card.update({
      where: { id: taskId },
      data: { needsHuman: false, needsHumanReason: null },
    });
    this.realtime.broadcast({ type: 'agent.answered', taskId, questionId });
    // US-COLAB3: registra (coalesce) a intenção durável de acordar a story após
    // a resposta HITL, para que a retomada sobreviva a restart.
    await this.enqueueWakeup(storyId, 'hitl_answered');
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
      select: { execState: true, parentId: true },
    });
    if (fromPrismaExecState(current?.execState) === state) return;
    // US-BLOCK1 (ADR-0039): blocked-dep é sempre um bloqueio de dependência.
    // Ao sair de blocked-dep para outro estado, limpamos o blockKind de dependência.
    // US-BLOCK2: ao SAIR de blocked-dep (unblock/resume/done), limpamos também o
    // anti re-fire `blockedOwnerNotifiedAt` para que um bloqueio futuro possa
    // notificar o owner de novo.
    const enteringBlockedDep =
      fromPrismaExecState(current?.execState) !== 'blocked-dep' && state === 'blocked-dep';
    const leavingBlockedDep =
      fromPrismaExecState(current?.execState) === 'blocked-dep' && state !== 'blocked-dep';
    const blockKindPatch =
      state === 'blocked-dep'
        ? { blockKind: 'dependency' as BlockKind }
        : leavingBlockedDep
          ? { blockKind: null, blockedOwnerNotifiedAt: null }
          : {};
    await this.prisma.card.update({
      where: { id: taskId },
      data: { execState: toPrismaExecState(state), ...blockKindPatch },
    });
    this.realtime.broadcast({ type: 'task.state.changed', taskId, execState: state });
    // #1/#3: espelhar o execState na coluna do mini-kanban da task.
    await this.moveTaskToColumnFor(taskId, state);

    // US-BLOCK4 (ADR-0039): ao ENTRAR em blocked-dep, conta a recorrência da
    // MESMA causa (assinatura = dependency + hash do taskId, estável para a
    // mesma task). Se a task re-bloqueia pela dependência N vezes seguidas
    // (ciclo blocked↔unblocked), escala a humano em vez de re-ciclar para sempre.
    if (enteringBlockedDep) {
      const storyId = current?.parentId ?? taskId;
      const recurs = await this.recordBlockRecurrence(
        storyId,
        'dependency',
        `dependency:${taskId}`,
      );
      if (recurs) {
        await this.escalateToHuman(
          taskId,
          storyId,
          'A task voltou a bloquear pela mesma dependência repetidas vezes (ciclo blocked↔unblocked).',
          `US-BLOCK4: recorrência de bloqueio de dependência atingiu o limite (${this.config.agent.maxConsecutiveBlocks}) — escalando a humano.`,
          'dependency',
        );
      }
    }
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
      /** US-OBS2-5: proveniência de uso (provider da telemetria de tokens). */
      provider?: string;
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
          provider: it.provider ?? null,
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
   * US-OBS3 (ADR-0037) — Gate de auto-commit/PR OPCIONAL após a validação verde
   * de uma iteração. Puro nas decisões (delega o git ao `WorkspaceService`, que
   * é o ENGINE — nunca o agent, ver ADR-0008). Retorna o `CommitOutcome` (também
   * exposto para testes/observabilidade); os `skippedReason` são:
   *
   *  - 'disabled'             → `AGENT_AUTO_COMMIT` off (default) → NADA é commitado.
   *  - 'not-verified'         → evidência não é verificável (`isVerifiableEvidence`
   *                             false: sem check `passed=true`).
   *  - 'no-isolated-worktree' → não há worktree isolado (US-OBS2/ADR-0035);
   *                             jamais commitamos direto no repo-alvo do usuário.
   *  - 'nothing-to-commit'    → worktree isolado sem mudanças.
   *  - 'commit-failed'        → git do engine falhou.
   *
   * Default (flag off) ⇒ `committed=false, skippedReason='disabled'` — zero
   * mudança de comportamento.
   */
  async maybeAutoCommit(
    storyId: string,
    taskId: string,
    evidence: string | StructuredEvidence | null | undefined,
  ): Promise<CommitOutcome> {
    // US-HARD4 — roteia esta ação privilegiada pelo catálogo guardado
    // (fail-closed). O guard vê os SINAIS VIVOS (opt-in + evidência verificável
    // AGORA, não um snapshot) e decide allow|hold|deny. `hold` REUSA o HITL
    // existente via `escalateToHuman` (needsHuman + card.needs_human); assim,
    // quando o humano responde (`answerQuestion`), a iteração é re-disparada e
    // os checks vivos re-avaliados. `deny`/guard-throw ⇒ nada é commitado.
    const evidenceVerified =
      isVerifiableEvidence(evidence) && !evidence.checks.some((c) => c && c.passed === false);
    const ctx: GuardedActionContext = {
      escalate: (reason, kind) =>
        this.escalateToHuman(
          taskId,
          storyId,
          reason,
          `auto-commit: gate guardado SEGUROU a ação (hold) — ${reason}`,
          kind ?? 'needs_input',
        ),
    };

    try {
      const run = await runGuarded(
        GUARDED_ACTIONS.autoCommit,
        {
          autoCommitEnabled: this.config.agent.autoCommit,
          evidenceVerified,
          requireHumanApproval: this.config.agent.autoCommitRequireApproval,
        },
        ctx,
        () => this.performAutoCommit(storyId, taskId, evidence),
      );
      if (run.ran) return run.value;
      // hold: HITL disparado; nenhum commit nesta passagem.
      return { committed: false, skippedReason: 'held-for-human' };
    } catch (err) {
      if (err instanceof GuardedActionDeniedError) {
        await this.log(taskId, `auto-commit: ação negada pelo gate — ${err.reason}`);
        return { committed: false, skippedReason: 'denied' };
      }
      throw err;
    }
  }

  /**
   * Executor REAL do auto-commit (roda só quando o gate guardado libera). Puro
   * nas decisões (delega o git ao `WorkspaceService`, o ENGINE — ADR-0008).
   */
  private async performAutoCommit(
    storyId: string,
    taskId: string,
    evidence: string | StructuredEvidence | null | undefined,
  ): Promise<CommitOutcome> {
    if (!this.config.agent.autoCommit) {
      return { committed: false, skippedReason: 'disabled' };
    }

    // Gate de evidência: só commita se a conclusão for VERIFICÁVEL (≥1 check
    // passed=true). Se algum check falhou, isVerifiableEvidence pode ainda ser
    // true (há ≥1 passed); então exigimos que NENHUM check tenha passed=false.
    if (!isVerifiableEvidence(evidence)) {
      return { committed: false, skippedReason: 'not-verified' };
    }
    const anyFailed = evidence.checks.some((c) => c && c.passed === false);
    if (anyFailed) {
      return { committed: false, skippedReason: 'not-verified' };
    }

    // Isolamento obrigatório (ADR-0035): sem worktree isolado, NÃO commitamos.
    const isolated = this.workspaces.getIsolatedWorktree(storyId);
    if (!isolated) {
      return { committed: false, skippedReason: 'no-isolated-worktree' };
    }

    let commit: { sha: string | null; branch: string } | null;
    try {
      commit = await this.workspaces.commitIsolatedWorktree(
        storyId,
        `chore(agent): auto-commit task ${taskId} (validação verde)`,
      );
    } catch (err) {
      await this.log(
        taskId,
        `auto-commit: git do engine falhou — ${(err as Error).message}`,
      );
      return { committed: false, skippedReason: 'commit-failed' };
    }

    if (!commit) {
      return { committed: false, skippedReason: 'no-isolated-worktree' };
    }
    if (!commit.sha) {
      return { committed: false, branch: commit.branch, skippedReason: 'nothing-to-commit' };
    }

    await this.log(
      taskId,
      `auto-commit: engine commitou ${commit.sha.slice(0, 8)} no worktree isolado (${commit.branch}).`,
    );

    const outcome: CommitOutcome = {
      committed: true,
      commitSha: commit.sha,
      branch: commit.branch,
    };

    // PR opcional: ponto de extensão (v1 não abre PR automaticamente sem
    // `gh`/token). Registramos a intenção; nunca falha o loop.
    if (this.config.agent.autoPr) {
      await this.log(
        taskId,
        'auto-pr: AGENT_AUTO_PR ligado — abertura de PR é ponto de extensão (v1 não abre PR sem gh/token).',
      );
    }

    return outcome;
  }

  /**
   * Diff/Replay Viewer: captura um SNAPSHOT do working tree como um objeto
   * tree do git (`git write-tree`), retornando o tree-hash. Usado no INÍCIO de
   * cada iteração como baseline, para que captureDiff() compute apenas o delta
   * produzido NESTA iteração (e não o acumulado desde o último commit).
   *
   * Usa um ÍNDICE TEMPORÁRIO (GIT_INDEX_FILE) para não poluir o índice real do
   * repo-alvo, e `git add -A` (conteúdo real, sem `-N`) para que o tree capture
   * o CONTEÚDO exato dos arquivos naquele instante — inclusive novos e
   * modificados por iterações anteriores. Assim o baseline representa fielmente
   * o estado inicial da iteração. Qualquer falha (não é repo, timeout) retorna
   * null — nesse caso captureDiff cai no comportamento antigo (git diff HEAD).
   */
  private async captureTreeBaseline(cwd: string): Promise<string | null> {
    if (!cwd) return null;
    const tmpIndex = join(tmpdir(), `kanban-diff-idx-${randomUUID()}`);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const run = (args: string[]): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        execFile(
          'git',
          args,
          { cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 20 * 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              resolve(null);
              return;
            }
            resolve((stdout ?? '').trim());
          },
        );
      });
    try {
      // Semeia o índice temporário com o HEAD (best-effort; repo sem commits
      // simplesmente parte de um índice vazio) e adiciona TODO o working tree
      // com conteúdo real, gerando um tree fiel ao estado atual.
      await run(['read-tree', 'HEAD']);
      await run(['add', '-A']);
      const tree = await run(['write-tree']);
      return tree && tree.length > 0 ? tree : null;
    } catch (err) {
      this.logger.warn(
        `Falha ao capturar baseline de diff em ${cwd}: ${(err as Error).message}`,
      );
      return null;
    } finally {
      // Remove o índice temporário; o índice real do repo-alvo nunca foi tocado.
      await rm(tmpIndex, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Diff/Replay Viewer: captura o unified diff do worktree isolado ao fim de
   * uma iteração, para o front navegar iteração a iteração vendo o que mudou.
   *
   * IMPORTANTE: este `git` é do ORQUESTRADOR (código do engine) inspecionando o
   * resultado no worktree — NÃO é o agent rodando git (isso é proibido pelo
   * prompt). Roda `git add -A -N` para que arquivos novos apareçam no diff.
   *
   * Quando `baseline` (tree-hash capturado por captureTreeBaseline no início da
   * iteração) é fornecido, computa `git diff <baseline>` — o DELTA produzido
   * SÓ nesta iteração. Sem baseline (fallback), volta ao comportamento antigo
   * (`git diff HEAD`, acumulado desde o último commit). Trunca em ~100KB para
   * não estourar payload/DB. Qualquer erro é tratado silenciosamente ('').
   */
  private async captureDiff(cwd: string, baseline?: string | null): Promise<string> {
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
      let diff = '';
      if (baseline) {
        // Delta desta iteração: diferença entre o snapshot do início (baseline
        // tree) e o estado atual do working tree.
        diff = await run(['diff', baseline]);
      } else {
        // Fallback (sem baseline): acumulado contra o último commit.
        diff = await run(['diff', 'HEAD']);
        if (!diff) diff = await run(['diff']);
      }
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
    const aiProposed = texts.length > 0;

    // Fallback determinístico: só na análise, e só se a AI não propôs nada.
    if (texts.length === 0) {
      if (phase !== 'analysis') return [];
      this.logger.warn(
        `Task ${taskId}: AI não propôs DOD na análise — aplicando fallback genérico. ` +
          `DOD relevante à task depende do agent emitir \`proposedDod\` no KANBAN_RESULT.`,
      );
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
      `DOD definido na fase de ${phase} (${aiProposed ? 'proposto pela AI' : 'fallback genérico'}) — ` +
        `${created.length} ${created.length === 1 ? 'item' : 'itens'}`,
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
      select: { parentId: true, title: true, description: true },
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
   * US-F2.7 — deriva o blast radius da iteração e o persiste como o fluxo
   * `AFFECTED_FLOW_DERIVED_NAME` na story. SEMÂNTICA: **complementa e confere**
   * o declarado pela IA — nunca substitui. O `ValidationRunner` consome os
   * fluxos da story por igual (`verifyFlowFiles` + `runFlowTargetedTests`),
   * então o fluxo derivado faz a validação exercitar os DEPENDENTES DIRETOS
   * da mudança (specs co-located dos importadores/chamadores) mesmo quando a
   * IA declara de menos; a divergência declarado×derivado vira Activity no
   * card (o "confere"). Substituir apagaria os nomes/notas semânticos da IA e
   * esvaziaria o `verifyFlowFiles` (arquivos do grafo existem por construção);
   * só complementar sem conferir deixaria a subdeclaração invisível.
   *
   * Gate: env `GRAPHIFY_AFFECTED_FLOWS` (default OFF — com ela off este método
   * nem é chamado e o comportamento é byte-idêntico ao anterior; cutover na
   * US-F2.10). NUNCA lança; falha não é silenciosa (Activity + warn) nem fatal
   * (o loop segue com o declarado da IA) — mesma filosofia das F2.5/F2.6.
   */
  private async maybeDeriveAffectedFlows(input: {
    taskId: string;
    storyId: string;
    cwd: string;
    diffBaseline: string | null;
    declared: { name: string; files: string[] }[];
  }): Promise<void> {
    if (!this.config.graphify?.affectedFlowsEnabled || !this.projectGraph) return;
    try {
      // Seeds = arquivos que a iteração REALMENTE tocou (git diff, não a
      // declaração da IA). Mesmo corte da US-F2.6: sem lockfiles/.hive, teto 10.
      const changed = cutLearningFiles(
        await collectChangedFiles(input.cwd, input.diffBaseline).catch(() => []),
      );
      if (changed.length === 0) return; // sem diff não há raio (e não há fantasma)
      const derived = await this.deriveAffectedFlow({ ...input, changed });
      if (derived) await this.persistAffectedFlows(input.storyId, [derived]);
    } catch (err) {
      this.logger.warn(
        `US-F2.7: derivação do blast radius falhou: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * US-F2.7 — o miolo da derivação: seeds → `POST /affected` (depth
   * `AFFECTED_FLOW_DEPTH`) → corte (`rankAffectedFiles` + existência no
   * worktree + teto) → fluxo derivado. Retorna `null` quando não se aplica
   * (Board legado sem Project) ou quando falhou (já sinalizado ao operador).
   */
  private async deriveAffectedFlow(input: {
    taskId: string;
    storyId: string;
    cwd: string;
    changed: string[];
    declared: { name: string; files: string[] }[];
  }): Promise<{ name: string; files: string[]; note: string } | null> {
    const { taskId, storyId, cwd, changed, declared } = input;
    const projectId = await this.resolveStoryProjectId(storyId);
    if (!projectId) return null; // Board legado sem Project → não há grafo (não é falha)
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { graphState: true },
    });
    const graphState = String(project?.graphState ?? 'inexistente');
    if (graphState !== 'ready') {
      this.logger.warn(
        `US-F2.7: blast radius indisponível para project=${projectId} (graphState=${graphState})`,
      );
      await this.log(
        taskId,
        `US-F2.7: blast radius indisponível (grafo do projeto ${graphState}) — a validação segue apenas com os fluxos declarados pela IA.`,
      );
      return null;
    }

    const hits: { file: string | null; depth: number }[] = [];
    let failures = 0;
    let firstError = '';
    for (const seed of changed) {
      const res = await this.projectGraph!.affected(projectId, seed, AFFECTED_FLOW_DEPTH);
      if (!res.ok) {
        failures += 1;
        firstError ||= res.error;
        continue;
      }
      hits.push(...res.hits);
    }
    if (failures === changed.length) {
      // Sidecar fora / erro sistêmico: TODOS os seeds falharam. O loop segue
      // com o declarado, mas o operador fica sabendo (não-silencioso).
      this.logger.warn(`US-F2.7: /affected falhou para todos os seeds: ${firstError}`);
      await this.log(
        taskId,
        `US-F2.7: blast radius falhou (${firstError}) — a validação segue apenas com os fluxos declarados pela IA.`,
      );
      return null;
    }

    // O CORTE: ranking (depth/hits/path) → só arquivos que EXISTEM no worktree
    // (grafo pode estar defasado; um arquivo fantasma aqui viraria um problema
    // falso de "alucinação" no verifyFlowFiles) → teto.
    const files: string[] = [];
    for (const r of rankAffectedFiles(changed, hits)) {
      if (files.length >= AFFECTED_FLOW_MAX_FILES) break;
      if (await this.workspaces.fileExistsInWorktree(cwd, r.file)) files.push(r.file);
    }
    if (files.length === 0) return null; // nada afetado além da própria mudança

    // O "confere": arquivos afetados que NENHUM fluxo declarado menciona.
    const declaredFiles = new Set(declared.flatMap((f) => f.files));
    const undeclared = files.filter((f) => !declaredFiles.has(f));
    if (undeclared.length > 0) {
      await this.log(
        taskId,
        `US-F2.7: blast radius do grafo encontrou ${undeclared.length} arquivo(s) afetado(s) que a IA não declarou: ${undeclared.join(', ')}.`,
      );
    }

    return {
      name: AFFECTED_FLOW_DERIVED_NAME,
      files,
      note:
        `US-F2.7 — derivado do grafo (depth ${AFFECTED_FLOW_DEPTH}) a partir de ` +
        `${changed.length} arquivo(s) tocado(s) pela iteração; teto ${AFFECTED_FLOW_MAX_FILES}.`,
    };
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

  /**
   * US-F3.10 — Resolve o adapter de AI de um card via herança em cascata,
   * espelhando `resolveCardModel`:
   * `own ?? parent.adapter (recursivo) ?? board.defaultAdapter ?? global`.
   *
   * O "global" é `config.agentAdapter`, que já embute a precedência
   * `AGENT_ADAPTER` → default do processo (`mock`) — ADR-0036, emenda US-F3.1.
   * Valores desconhecidos vindos do banco (coluna String) são IGNORADOS e a
   * cascata continua — a validação forte de escrita fica no schema da API.
   */
  private async resolveCardAdapter(
    ownAdapter: string | null,
    parentId: string | null,
    boardId: string | null,
  ): Promise<AgentAdapterKind> {
    const known = (value: string | null | undefined): AgentAdapterKind | null =>
      AGENT_ADAPTER_KINDS.find((k) => k === value) ?? null;

    const own = known(ownAdapter);
    if (own) return own;

    let currentParentId = parentId;
    const seen = new Set<string>();
    while (currentParentId && !seen.has(currentParentId)) {
      seen.add(currentParentId);
      const parent = await this.prisma.card.findUnique({
        where: { id: currentParentId },
        select: { adapter: true, parentId: true },
      });
      if (!parent) break;
      const inherited = known(parent.adapter);
      if (inherited) return inherited;
      currentParentId = parent.parentId;
    }

    if (boardId) {
      const board = await this.prisma.board.findUnique({
        where: { id: boardId },
        select: { defaultAdapter: true },
      });
      const fromBoard = known(board?.defaultAdapter);
      if (fromBoard) return fromBoard;
    }

    return this.config.agentAdapter;
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
    /**
     * Contexto real (#2): diff acumulado do worktree, lido do `Iteration.diff`
     * da ÚLTIMA iteração persistida desta task. Injetado no prompt para a AI ver
     * concretamente o que já foi mudado (não só o histórico textual). Vazio na
     * primeira iteração.
     */
    lastDiff: string;
    taskDescription: string;
    storyContext: { title: string; description: string } | null;
    epicContext: { title: string; description: string } | null;
    /**
     * US-F2.5 (EP-F2/ADR-0041) — memória recuperada por TRAVESSIA DE GRAFO
     * (graphify), quando `GRAPHIFY_MEMORY_RECALL` está ON e o Board tem
     * Project com grafo `ready`. É o ÚNICO recall desde a US-F2.3 (o LIKE
     * legado morreu com o módulo `memory/`). Estados:
     *  - `null`  → recall NÃO se aplica (env off / Board legado): iteração
     *    segue sem memória, sem seção no prompt;
     *  - `ok:true` → texto da travessia (vazio = memória VAZIA de verdade;
     *    US-F5.3: `noVocabMatch` = a consulta NÃO rodou porque nenhum termo
     *    da task existe no vocabulário do grafo — o prompt distingue);
     *  - `ok:false` → memória FALHOU (sidecar fora, grafo building/failed) —
     *    distinto de vazia; o prompt avisa a IA explicitamente.
     */
    memoryGraph:
      | { ok: true; text: string; noVocabMatch?: true }
      | { ok: false; error: string }
      | null;
    /**
     * US-F5.5 (EP-F5) — id do Project quando o grafo está `ready`
     * (`memoryGraph.ok` — reuso do estado que o recall da US-F2.5 já
     * resolveu). Habilita a seção "Grafo de conhecimento" do prompt (tools
     * MCP + Wiki). `null` ⇒ seção omitida (Board legado sem Project, grafo
     * não-`ready`, integração desligada).
     */
    graphProjectId: string | null;
    /**
     * US-CTX1 (EP-CTX/ADR-0040) — snapshot da TENTATIVA ANTERIOR desta story,
     * quando este é um re-dispatch (reclaim pós-crash M4 ou continuação M3).
     * `null` na 1ª execução (nada a injetar). Fonte: AgentRuntimeState.lastError
     * + outcome da última Iteration. Defensivo: falha => null.
     */
    priorAttempt: { lastError: string | null; lastOutcome: string | null } | null;
    /**
     * US-CTX2 (EP-CTX/ADR-0040) — handoffs ESTRUTURADOS das tasks das quais esta
     * depende (irmãs já concluídas / blockers resolvidos), lidos de
     * Card.completionMetadata. Vazio quando não há metadata. Injetado no prompt
     * para a AI herdar changed_files/verification/residual_risk do trabalho pai.
     */
    parentHandoffs: { key: string; title: string; metadata: CompletionMetadata }[];
    /**
     * US-CTX3 (EP-CTX/ADR-0040) — motivo/dica da última continuação bounded
     * (ex.: "run anterior só planejou"). `null` = sem continuação pendente.
     * Fonte: AgentRuntimeState.livenessReason.
     */
    continuationReason: string | null;
    /**
     * US-BUX3 (EP-BUX) — plan mode: quando true, a iteração deve APENAS
     * investigar e produzir um plano, sem editar código. Reflete o
     * `startInPlanMode` da STORY em execução (o loop dispara por story).
     * Defensivo: default false quando a story não é encontrada.
     */
    startInPlanMode: boolean;
    /**
     * US-F3.6 (ADR-0042) — retomada HITL pós-restart, runner-agnóstica. Par
     * pergunta+resposta cuja resposta humana ainda NÃO foi consumida por
     * nenhuma iteração (ela chegou pelo caminho de resiliência do ADR-0022,
     * após um restart matar a promise de `waitForAnswer`). Injetado no prompt
     * para runners SEM sessão em disco (ex.: tanstack) retomarem do ponto da
     * decisão — no fluxo sem restart o par vira `handoffNextStep` da iteração
     * e este campo é `null`. Defensivo: falha de leitura => `null`.
     */
    hitlResume: { prompt: string; answer: string } | null;
  }> {
    const task = await this.prisma.card.findUnique({
      where: { id: taskId },
      select: { parentId: true, title: true, description: true },
    });
    const story = task?.parentId
      ? await this.prisma.card.findUnique({
          where: { id: task.parentId },
          select: {
            aiProject: true,
            aiNotes: true,
            affectedFlows: true,
            parentId: true,
            title: true,
            description: true,
            startInPlanMode: true,
          },
        })
      : null;
    // #10a: propagação epic→story. Se a story não tem aiProject/aiNotes
    // próprios, herda do épico pai.
    const epic = story?.parentId
      ? await this.prisma.card.findUnique({
          where: { id: story.parentId },
          select: { aiProject: true, aiNotes: true, title: true, description: true },
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
        diff: true,
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
    // #2: diff acumulado — última iteração com diff não-vazio.
    const lastDiff =
      [...historyRows].reverse().find((it) => (it.diff ?? '').trim().length > 0)?.diff ?? '';

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

    // #10c: lastro cross-story — resumos das stories já concluídas, acumulados
    // como comments no épico. Só consideramos os comments de RESUMO (marcados
    // com `<!-- story-summary:<id> -->`), deduplicamos por story (o mais
    // recente vence) e limitamos a quantidade, para o lastro NÃO inflar o
    // prompt sem limite (o que estoura o argv do runner — spawn E2BIG).
    const epicNotes: string[] = [];
    if (story?.parentId) {
      const comments = await this.prisma.comment.findMany({
        where: { cardId: story.parentId },
        orderBy: { ts: 'asc' },
        select: { text: true },
      });
      const MARKER = /^<!-- story-summary:([^\s]+) -->\n?/;
      const byStory = new Map<string, string>();
      const plain: string[] = [];
      for (const c of comments) {
        const m = c.text.match(MARKER);
        if (m) {
          byStory.set(m[1], c.text.replace(MARKER, '').trimStart());
        } else {
          plain.push(c.text);
        }
      }
      // No máximo os 20 resumos de story mais recentes + 5 comments avulsos.
      const MAX_STORY_SUMMARIES = 20;
      const summaries = [...byStory.values()];
      epicNotes.push(...summaries.slice(-MAX_STORY_SUMMARIES));
      epicNotes.push(...plain.slice(-5));
    }

    // US-F2.5/F2.10 → US-F2.3 (EP-F2) — recall de memória por GRAFO, o único
    // caminho: o recall LIKE legado (US-A1) morreu com o módulo `memory/` (a
    // emenda da US-F2.10 no ADR-0027 previa: "a partir da F2.3 o rollback
    // deixa de existir"). `null` = recall não se aplica (env off, Board legado
    // sem Project, task sem story) → a iteração segue SEM memória, sem seção
    // no prompt. Falha (`ok:false`) é DISTINTA de vazio e vira aviso explícito
    // no prompt + Activity no card.
    const memoryGraph = await this.recallFromGraph(task?.parentId ?? null, taskTitle, flows);
    // US-F5.5 — Project do Board para a seção "Grafo de conhecimento" do
    // prompt. Só resolve quando o recall PROVOU grafo `ready` (`memoryGraph.ok`)
    // — nada de re-checar `graphState` aqui. Defensivo: falha ⇒ null (sem seção).
    let graphProjectId: string | null = null;
    if (memoryGraph?.ok && task?.parentId) {
      graphProjectId = await this.resolveStoryProjectId(task.parentId).catch(() => null);
    }
    if (memoryGraph && !memoryGraph.ok) {
      // US-F2.10 (cutover) — com o recall por grafo como DEFAULT, "grafo
      // indisponível" deixou de ser exceção de opt-in: o operador precisa ver
      // no CARD (Activity), não só no warn do servidor, que a IA trabalhou sem
      // memória — mesmo padrão da US-F2.7. Sem fallback (reavaliado no
      // cutover: o oráculo da F2.1 provou que o LIKE devolvia [] nos mesmos
      // cenários — o fallback só re-mascararia a falha).
      await this
        .log(
          taskId,
          `US-F2.10: memória do projeto INDISPONÍVEL nesta iteração (${memoryGraph.error}) — ` +
            'a IA foi avisada no prompt e segue sem memória; sem fallback para o recall legado.',
        )
        .catch(() => undefined);
    }

    // ── US-CTX1/CTX3 (EP-CTX/ADR-0040) — snapshot do AgentRuntimeState desta
    // story (leitura ÚNICA, wide select) para: (1) tentativa anterior em
    // re-dispatch e (2) motivo de continuação bounded. Totalmente defensivo:
    // qualquer falha => priorAttempt=null / continuationReason=null.
    let priorAttempt: { lastError: string | null; lastOutcome: string | null } | null = null;
    let continuationReason: string | null = null;
    const storyIdForCtx = task?.parentId ?? null;
    if (storyIdForCtx) {
      try {
        const runtime = await this.prisma.agentRuntimeState.findUnique({
          where: { storyId: storyIdForCtx },
          select: { lastError: true, livenessReason: true },
        });
        if (runtime) {
          continuationReason = runtime.livenessReason ?? null;
          // outcome da última iteração da story-corrente (task): se houver
          // qualquer sinal (erro prévio OU outcome não-ok), montamos o bloco.
          const lastIter = await this.prisma.iteration.findFirst({
            where: { cardId: taskId },
            orderBy: { index: 'desc' },
            select: { outcome: true },
          });
          const lastOutcome = lastIter?.outcome ?? null;
          if (runtime.lastError || (lastOutcome && lastOutcome !== 'ok')) {
            priorAttempt = { lastError: runtime.lastError ?? null, lastOutcome };
          }
        }
      } catch (err) {
        this.logger.warn(
          `Falha ao ler AgentRuntimeState em buildContext: ${(err as Error).message}`,
        );
        priorAttempt = null;
        continuationReason = null;
      }
    }

    // ── US-CTX2 (EP-CTX/ADR-0040) — handoffs ESTRUTURADOS das tasks pai/irmãs
    // concluídas: lê Card.completionMetadata das mesmas irmãs `done` já
    // consideradas em siblingHandoffs. Defensivo: metadata inválido é ignorado.
    const parentHandoffs: { key: string; title: string; metadata: CompletionMetadata }[] = [];
    if (task?.parentId) {
      try {
        const doneWithMeta = await this.prisma.card.findMany({
          where: {
            parentId: task.parentId,
            type: 'task',
            execState: 'done',
            NOT: { id: taskId },
            completionMetadata: { not: Prisma.JsonNull },
          },
          select: { key: true, title: true, completionMetadata: true },
        });
        for (const c of doneWithMeta) {
          const raw = c.completionMetadata as unknown as CompletionMetadata | null;
          if (raw && typeof raw === 'object') {
            parentHandoffs.push({ key: c.key, title: c.title, metadata: raw });
          }
        }
      } catch (err) {
        this.logger.warn(
          `Falha ao ler completionMetadata em buildContext: ${(err as Error).message}`,
        );
      }
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
      lastDiff,
      taskDescription: task?.description ?? '',
      storyContext: story ? { title: story.title ?? '', description: story.description ?? '' } : null,
      epicContext: epic ? { title: epic.title ?? '', description: epic.description ?? '' } : null,
      memoryGraph,
      graphProjectId,
      priorAttempt,
      parentHandoffs,
      continuationReason,
      startInPlanMode: story?.startInPlanMode ?? false,
      hitlResume: await this.loadHitlResume(taskId),
    };
  }

  /**
   * US-F3.6 (ADR-0042) — localiza uma troca HITL (pergunta role=ai + resposta
   * role=user, mesmo `questionId`) cuja resposta ainda não foi consumida por
   * nenhuma iteração — i.e. respondida DEPOIS da última `Iteration` persistida
   * da task. Isso só acontece no caminho de resiliência do ADR-0022 (restart
   * matou a promise de `waitForAnswer`; no fluxo normal o par vira o
   * `handoffNextStep` da iteração que pausou, persistida após a resposta).
   *
   * O Copilot recupera a pergunta via sessão em disco (`--session-id`), mas a
   * RESPOSTA só existe no banco; runners sem sessão em disco (tanstack) não
   * recuperam nada. Reinjetar o par no prompt fecha a lacuna para TODOS os
   * runners (para o Copilot é redundância inofensiva — o mesmo espírito do
   * "prompt auto-suficiente como fallback" do ADR-0022).
   *
   * Defensivo: qualquer falha => `null` (a retomada degrada para o prompt
   * reconstruído sem o par, como antes — nunca derruba o loop).
   */
  private async loadHitlResume(
    taskId: string,
  ): Promise<{ prompt: string; answer: string } | null> {
    try {
      const answer = await this.prisma.agentMessage.findFirst({
        where: { cardId: taskId, role: 'user', questionId: { not: null } },
        orderBy: { ts: 'desc' },
        select: { ts: true, text: true, questionId: true },
      });
      if (!answer?.questionId) return null;
      const lastIteration = await this.prisma.iteration.findFirst({
        where: { cardId: taskId },
        orderBy: { ts: 'desc' },
        select: { ts: true },
      });
      // Resposta anterior à última iteração = já consumida (virou handoff).
      if (lastIteration && answer.ts <= lastIteration.ts) return null;
      const question = await this.prisma.agentMessage.findFirst({
        where: { cardId: taskId, role: 'ai', questionId: answer.questionId },
        orderBy: { ts: 'desc' },
        select: { text: true },
      });
      if (!question) return null;
      return { prompt: question.text, answer: answer.text };
    } catch (err) {
      this.logger.warn(
        `Falha ao ler retomada HITL em buildContext: ${(err as Error).message}`,
      );
      return null;
    }
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
    workdir = '',
    recovery = false,
    // US-F3.5 — true quando o runner ativo consome `outputSchema`: as seções
    // de FORMATO (bloco <<<KANBAN_RESULT>>>/<<<KANBAN_QUESTION>>>) saem do
    // prompt (o schema as substitui, com as regras nos `.describe()`); TODO o
    // resto (comportamento, contexto, guardas) permanece. Default false =
    // caminho Copilot/marcador intacto.
    structuredOutput = false,
  ): string {
    const lines: string[] = [];

    lines.push('# Você é um agent autônomo de desenvolvimento no kanban-ai.');
    lines.push(
      'Trabalhe de forma incremental e ENCADEADA: você é uma iteração de um loop. ' +
        'Outras iterações virão depois e lerão o que você registrar. Foque em avançar ' +
        'a task, não em terminar tudo de uma vez. NÃO se perca: siga o profile e o handoff abaixo.',
    );

    // US-OBS2-5 — GUARD DE RECUPERAÇÃO status-only. Injetado SOMENTE quando este
    // é um dispatch de recuperação (recovery=true). NUNCA é adicionado em
    // continuações de trabalho normal (recovery=false ⇒ scrubbed), para não
    // vazar a instrução "não produza entregável" no loop produtivo.
    if (recovery) {
      lines.push(...recoveryGuardLines());
    }

    // US-BUX3 (EP-BUX) — PLAN MODE: quando a story em execução está marcada com
    // `startInPlanMode`, esta iteração é de PLANEJAMENTO apenas. O bloco é
    // injetado de forma PROEMINENTE (logo após o cabeçalho, antes de qualquer
    // instrução de execução) para maximizar a chance de a AI respeitá-lo.
    if (context.startInPlanMode) {
      lines.push('');
      lines.push('## 🛑 MODO PLANEJAMENTO (plan mode) — NÃO ALTERE CÓDIGO NESTA ITERAÇÃO');
      lines.push(
        '- Sua ÚNICA tarefa nesta iteração é INVESTIGAR o repositório e produzir um ' +
          'PLANO de implementação detalhado. **NÃO edite arquivos, NÃO crie/apague ' +
          'arquivos, NÃO rode migrations e NÃO commite nada.**',
      );
      lines.push(
        '- O plano deve conter: arquivos a tocar, abordagem/estratégia, riscos e uma ' +
          'lista ordenada de passos de implementação.',
      );
      lines.push(
        '- Registre o plano completo no `summary` e o próximo passo concreto no ' +
          '`nextStep` do seu resultado. Comandos de LEITURA (listar/ler arquivos, ' +
          'buscar código) são permitidos; qualquer comando que altere o filesystem NÃO é.',
      );
    }

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
    if (context.notes) lines.push(`- Notas / efeitos colaterais: ${context.notes}`);

    // Contexto textual hierárquico do board (épico → story → task).
    // Truncamos descrições para evitar estourar argv/stdin do runner (spawn E2BIG).
    const MAX_CONTEXT_DESCRIPTION = 2_000;
    const truncateContextText = (text: string) =>
      text.length > MAX_CONTEXT_DESCRIPTION
        ? `${text.slice(0, MAX_CONTEXT_DESCRIPTION)}… (truncado)`
        : text;

    const epicTitle = context.epicContext?.title?.trim() ?? '';
    const epicDescription = truncateContextText((context.epicContext?.description ?? '').trim());
    const storyTitle = context.storyContext?.title?.trim() ?? '';
    const storyDescription = truncateContextText((context.storyContext?.description ?? '').trim());
    const taskDescription = truncateContextText((context.taskDescription ?? '').trim());

    if (epicTitle || epicDescription || storyTitle || storyDescription || taskDescription) {
      lines.push('');
      lines.push('## Contexto do trabalho (épico → story → task)');
      if (epicTitle || epicDescription) {
        lines.push(`### Épico: ${epicTitle || '(sem título)'}`);
        if (epicDescription) lines.push(epicDescription);
      }
      if (storyTitle || storyDescription) {
        lines.push(`### Story: ${storyTitle || '(sem título)'}`);
        if (storyDescription) lines.push(storyDescription);
      }
      if (taskDescription) {
        lines.push('### Descrição da task');
        lines.push(taskDescription);
      }
    }

    // Escopo e projeto-alvo — a AI trabalha DIRETO no working tree do repo-alvo
    // (o `cwd` do processo), na branch que já estiver aberta. NÃO há worktree
    // isolado: as mudanças ficam no próprio projeto (comportamento desejado). A
    // colisão entre stories concorrentes é evitada por SERIALIZAÇÃO no engine
    // (uma story por aiProject), então o agent pode e deve editar os arquivos
    // reais do projeto no diretório atual.
    //
    // US-COLAB2 / ADR-0031: quando o profile é `board-only` (orquestrador), a
    // seção de escopo "edite os arquivos" é SUBSTITUÍDA por um mandato de board
    // manager — o agent NÃO coda; ele organiza o board via ferramentas MCP.
    if (profile.toolset === 'board-only') {
      lines.push('');
      lines.push('## 🧭 Você é o ORQUESTRADOR do board (board manager)');
      lines.push(
        '- Seu trabalho é ORGANIZAR o board: criar stories/tasks, atribuí-las aos ' +
          'agents certos e linkar dependências — via as ferramentas MCP do kanban-ai.',
      );
      lines.push(
        '- ❌ Você **NÃO PODE editar, criar ou apagar NENHUM arquivo** do ' +
          'repositório-alvo. Você não coda. Se algo precisa de código, CRIE uma task ' +
          'e atribua a um agent codador (feature/bug/refactor).',
      );
      lines.push(
        '- ❌ NÃO rode comandos de shell que alterem o filesystem. Comandos de LEITURA ' +
          'para entender o board são permitidos.',
      );
      lines.push(
        '- ✅ Ferramentas permitidas: criar card (task/story), atribuir assignee, ' +
          'linkar dependência, mover card entre colunas do board.',
      );
      lines.push(
        '- Tasks só podem ser criadas nas colunas **Backlog** ou **To Do** — respeite ' +
          'essa regra do board ao decompor o escopo.',
      );
    } else {
      lines.push('');
      lines.push('## Escopo e diretório de trabalho (LEIA COM ATENÇÃO)');
      if (workdir) {
        lines.push(
          `- Seu diretório de trabalho (\`cwd\`) é \`${workdir}\` — é o repositório-alvo, na branch ` +
            'que já está aberta. **Faça TODAS as mudanças AQUI, editando os arquivos reais do projeto.**',
        );
        lines.push(
          '- Trabalhe relativo ao `cwd` (ex.: `./ping.js`, `test/x.test.js`). Não rode `cd` para ' +
            'outro caminho nem edite arquivos fora deste diretório. As mudanças devem aparecer no ' +
            '`git diff` do projeto — se você não editar arquivos de fato, o loop não converge.',
        );
      } else {
        lines.push(
          '- Trabalhe apenas no diretório atual (`cwd`). Não crie arquivos fora dele e ' +
            'não invente estrutura. Se faltar contexto, faça UMA pergunta objetiva.',
        );
      }
      lines.push(
        '- NUNCA crie features, arquivos ou pastas no repositório do próprio kanban-ai ' +
          '(este é a ferramenta, não o produto). Entregue estritamente o que a task pede, no projeto-alvo.',
      );
    }

    // Proibição de operações git que ALTERAM estado. O agent deve deixar as
    // mudanças no working tree, NÃO commitadas — o engine não cria branch nem
    // commit; a integração é feita depois pelo humano. Se o agent commitar/trocar
    // de branch, o `git diff` que o gate de validação inspeciona fica
    // dessincronizado do trabalho real e o loop diverge. (Para o board-manager
    // essa seção não se aplica — ele não toca o working tree.)
    if (profile.toolset !== 'board-only') {
      lines.push('');
      lines.push('## ❌ PROIBIDO — operações de git que alteram estado (NÃO NEGOCIÁVEL)');
      lines.push(
        '- Você **NÃO PODE** rodar `git commit`, `git add`, `git branch`, `git checkout`, ' +
          '`git switch`, `git merge`, `git rebase`, `git reset`, `git stash`, `git push`, ' +
          '`git worktree` ou QUALQUER comando git que altere o estado do repositório.',
      );
      lines.push(
        '- **Apenas EDITE os arquivos** no diretório atual (leia/escreva/crie arquivos normalmente). ' +
          'Deixe as mudanças no working tree, NÃO commitadas — a integração é feita depois por um humano.',
      );
      lines.push(
        '- Se você commitar ou criar/trocar branch, o `git diff` que o gate de validação inspeciona ' +
          'fica dessincronizado do seu trabalho real — os arquivos que você declara em `affectedFlows` ' +
          'podem aparecer como "inexistentes" e o sistema deriva tasks de correção em loop.',
      );
      lines.push(
        '- Comandos git de LEITURA (`git status`, `git diff`, `git log`) são permitidos apenas ' +
          'para inspeção — nunca comandos que mudem estado.',
      );
    }

    // DOD real — o ÚNICO checklist do v1. É a AI quem marca os ids concluídos.
    lines.push('');
    lines.push('## Definition of Done (DOD) — único checklist. Marque VOCÊ os ids concluídos:');
    if (context.dodItems.length === 0) {
      lines.push('- (nenhum item de DOD cadastrado)');
      if (phase === 'analysis') {
        lines.push('');
        lines.push(
          '⚠️ Esta task ainda NÃO tem DOD. Como estamos na fase de ANÁLISE, é VOCÊ quem ' +
            'deve DEFINIR o Definition of Done: ' +
            // US-F3.5 — no runner com schema o campo vive no resultado
            // estruturado, não num bloco de marcador.
            (structuredOutput
              ? 'preencha no seu resultado estruturado o campo '
              : 'emita no `KANBAN_RESULT` o campo ') +
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
    // US-F2.5 (EP-F2) — memória recuperada por TRAVESSIA DE GRAFO. Três
    // estados DISTINGUÍVEIS (o recall antigo colapsava todos em "nada"):
    //  - ok com texto  → seção de memória (grafo);
    //  - ok sem texto  → memória VAZIA de verdade: sem seção (como hoje);
    //  - falha         → aviso EXPLÍCITO — uma IA que sabe que a memória está
    //    indisponível age diferente de uma que acha que não há memória.
    if (context.memoryGraph?.ok && context.memoryGraph.text.trim()) {
      lines.push('');
      lines.push('## Memória do projeto (grafo de conhecimento — ADR-0041) — leia antes de agir:');
      lines.push(
        'Contexto recuperado por travessia do grafo do projeto (código + neurônios da colmeia ' +
          'ligados aos arquivos desta task). Use como contexto de trabalho; não repita erros já registrados.',
      );
      lines.push(context.memoryGraph.text.trim());
    } else if (context.memoryGraph?.ok && context.memoryGraph.noVocabMatch) {
      // US-F5.3 — quarto estado: a consulta NÃO rodou porque o vocabulário da
      // task (título/flows em português) não tem NENHUMA interseção com os
      // labels do grafo (identificadores em inglês) e não havia arquivos para
      // semear. Distinto de "não há memória" E de "memória falhou" — a skill
      // do graphify manda dizer isso e PARAR, não fabricar busca.
      lines.push('');
      lines.push('## Memória do projeto: vocabulário da task não casa com o do grafo');
      lines.push(
        'A consulta à memória NÃO foi executada: nenhum termo do título/flows desta task existe ' +
          'no vocabulário dos labels do grafo do projeto, e não há arquivos afetados para semear ' +
          'a busca (US-F5.3 — a busca não é fabricada com termos que o grafo não tem). Isso NÃO ' +
          'significa que não existem aprendizados: eles podem estar registrados sob outros termos. ' +
          'Se precisar de histórico, consulte o grafo usando identificadores REAIS do código ' +
          '(nomes de símbolos e arquivos).',
      );
    } else if (context.memoryGraph && !context.memoryGraph.ok) {
      lines.push('');
      lines.push('## ⚠️ Memória do projeto INDISPONÍVEL nesta iteração');
      lines.push(
        `A consulta à memória falhou (${context.memoryGraph.error}). ` +
          'NÃO conclua que não existem aprendizados anteriores — eles podem existir e estar ' +
          'inacessíveis agora. Prossiga com cautela redobrada em decisões que dependeriam de histórico.',
      );
    }

    // US-F5.5 (EP-F5) — regras canônicas do graphify (always_on/claude-md.md)
    // TRADUZIDAS para a superfície REAL destes agents: tools MCP + Wiki via
    // API. NUNCA os comandos de CLI do texto original (`graphify query/path/
    // explain/update`) — o agent não os tem; instrução que falha queima
    // iteração. Condição = `memoryGraph.ok` (grafo `ready`, resolvido pelo
    // recall da US-F2.5) + projectId: Board legado, grafo indisponível ou
    // integração desligada ⇒ seção OMITIDA (não prometer grafo que não existe).
    if (context.memoryGraph?.ok && context.graphProjectId) {
      const wikiUrl = `http://127.0.0.1:${this.config.apiPort}/projects/${context.graphProjectId}/wiki`;
      lines.push('');
      lines.push('## Grafo de conhecimento do projeto (consulte ANTES de varrer arquivos)');
      lines.push(
        '- Para pergunta sobre o código ("quem chama X?", "o que depende de Y?"), consulte o ' +
          'grafo pelas tools MCP do graphify (`query_graph`, `get_node`, `get_neighbors`, ' +
          '`shortest_path`, `god_nodes`) ANTES de varrer arquivo por arquivo com grep. Grafo ' +
          `DESTE projeto: \`project_path: "${GRAPHIFY_PROJECTS_HOME}/${context.graphProjectId}"\`.`,
      );
      lines.push(
        '- A busca casa IDENTIFICADORES REAIS do código (nome de símbolo, caminho de arquivo), ' +
          'por substring — prosa em português NÃO encontra nada. Monte a consulta com nomes que ' +
          'existem no código.',
      );
      lines.push(
        `- Para orientação ampla ("como isso se encaixa"), leia a Wiki do projeto: \`curl ${wikiUrl}\` ` +
          `(índice por comunidade e god nodes) e \`curl '${wikiUrl}/article?slug=<slug>'\` para um ` +
          'artigo — prefira-a a ler fonte crua quando a dúvida é estrutural.',
      );
      lines.push(
        '- NÃO tente atualizar o grafo após editar código: o loop o reconstrói automaticamente ' +
          'ao fim da iteração.',
      );
    }

    // US-CTX3 (EP-CTX/ADR-0040) — continuação DIRECIONADA. Quando o run anterior
    // foi improdutivo-mas-recuperável (plan_only/empty_response) e re-despachamos
    // dentro do cap, dizemos EXPLICITAMENTE o que fazer agora. Vem antes de tudo
    // do histórico para orientar a próxima ação de imediato.
    if (context.continuationReason) {
      lines.push('');
      lines.push('## ➡️ Continuação direcionada (re-dispatch automático)');
      lines.push(
        'O run anterior NÃO produziu progresso concreto (sem diff/DOD marcado). ' +
          'Este é um re-dispatch para você EXECUTAR o próximo passo agora — não apenas planejar de novo.',
      );
      lines.push(`Motivo: ${context.continuationReason}`);
    }

    // US-CTX1 (EP-CTX/ADR-0040) — TENTATIVA ANTERIOR em re-dispatch (reclaim
    // pós-crash M4 / continuação). Injeta erro e outcome anteriores para a AI
    // não recomeçar "amnésica" após um crash. `null` na 1ª execução.
    if (context.priorAttempt) {
      lines.push('');
      lines.push('## ⚠️ Tentativa anterior (re-dispatch) — leia antes de continuar');
      lines.push(
        'Esta story já esteve em execução e foi re-despachada (crash/reclaim ou continuação). ' +
          'Use o que já foi tentado; NÃO reinicie do zero nem repita o mesmo erro.',
      );
      if (context.priorAttempt.lastOutcome) {
        lines.push(`- Outcome da última iteração: ${context.priorAttempt.lastOutcome}`);
      }
      if (context.priorAttempt.lastError) {
        lines.push(`- Último erro registrado: ${context.priorAttempt.lastError}`);
      }
    }

    // US-CTX2 (EP-CTX/ADR-0040) — HANDOFF ESTRUTURADO das tasks das quais esta
    // depende (irmãs concluídas). Herda changed_files/verification/dependencies/
    // residual_risk do trabalho pai para não começar cega sobre o que já mudou.
    if (context.parentHandoffs?.length) {
      lines.push('');
      lines.push('## 🔗 Handoff estruturado do trabalho anterior (tasks concluídas desta story):');
      for (const h of context.parentHandoffs) {
        const m = h.metadata;
        lines.push('');
        lines.push(`### ${h.key} — ${h.title}`);
        if (m.changed_files?.length) {
          lines.push(`- Arquivos alterados: ${m.changed_files.slice(0, 40).join(', ')}`);
        }
        if (m.verification) lines.push(`- Verificação: ${m.verification}`);
        if (m.dependencies?.length) {
          lines.push(`- Dependências: ${m.dependencies.slice(0, 20).join(', ')}`);
        }
        if (m.retry_notes) lines.push(`- Notas de retry: ${m.retry_notes}`);
        if (m.residual_risk) lines.push(`- Risco residual: ${m.residual_risk}`);
      }
    }

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

    // US-F3.6 (ADR-0042) — retomada HITL pós-restart. Presente APENAS quando a
    // resposta humana chegou pelo caminho de resiliência do ADR-0022 (restart)
    // e nenhuma iteração a consumiu ainda. Vem DEPOIS do histórico: é a palavra
    // mais recente, o mesmo papel do "Decisão humana (HITL)" que o fluxo sem
    // restart injeta via handoffNextStep.
    if (context.hitlResume) {
      lines.push('');
      lines.push('## 🙋 Decisão humana recebida (HITL) — retome a partir dela');
      lines.push(
        'A iteração anterior pausou aguardando resposta humana e foi interrompida ' +
          'antes de consumi-la. A troca abaixo é a informação mais recente desta task — ' +
          'NÃO repita a pergunta; continue o trabalho a partir da resposta.',
      );
      lines.push(`- Pergunta: ${context.hitlResume.prompt}`);
      lines.push(`- Resposta do humano: ${context.hitlResume.answer}`);
    }

    // #2: contexto REAL — diff acumulado do worktree (o que JÁ foi mudado nas
    // iterações anteriores desta task). Dá à AI o estado concreto do código, não
    // só o histórico textual. Truncado no prompt para não estourar o contexto.
    const lastDiff = (context.lastDiff ?? '').trim();
    if (lastDiff.length > 0) {
      const MAX_PROMPT_DIFF = 20_000;
      const shown =
        lastDiff.length > MAX_PROMPT_DIFF
          ? lastDiff.slice(0, MAX_PROMPT_DIFF) + '\n… [diff truncado no prompt]'
          : lastDiff;
      lines.push('');
      lines.push('## Diff acumulado do worktree (o que JÁ foi mudado — NÃO refaça):');
      lines.push(
        'Este é o estado atual do seu trabalho no worktree (unified diff contra o commit base). ' +
          'Continue a partir daqui; não reescreva o que já está correto.',
      );
      lines.push('```diff');
      lines.push(shown);
      lines.push('```');
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
    // US-F3.5 — quando o runner ativo usa `outputSchema`, o FORMATO sai do
    // prompt: as linhas do bloco de marcador e as "Regras do bloco" vivem no
    // schema (constraints + `.describe()`). Tudo que NÃO é formato (verificação
    // antes do done, granularidade, guardas, contexto) permanece nas seções
    // vizinhas, iguais para os dois caminhos.
    lines.push('');
    if (structuredOutput) {
      lines.push('## OBRIGATÓRIO — resultado estruturado da iteração');
      lines.push(
        'Faça o trabalho da fase atual (leia/edite arquivos no diretório atual conforme necessário). ' +
          'Sua resposta final é um OBJETO ESTRUTURADO validado por schema — NÃO emita blocos ' +
          '`<<<KANBAN_RESULT>>>`/`<<<KANBAN_QUESTION>>>` nem texto fora do objeto. ' +
          'As regras de cada campo estão nas descrições do próprio schema; siga-as. ' +
          'Emita EXATAMENTE UMA variante: `result` (progresso desta iteração) OU ' +
          '`question` (decisão humana necessária).',
      );
    } else {
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
    lines.push('  "learnings": [{ "path": "modules/<modulo>.md", "summary": "<aprendizado durável e verdadeiro>", "scope": "<modulo opcional>" }],');
    if (this.config.agent.requireStructuredEvidence) {
      lines.push(
        '  "evidence": { "checks": [{ "name": "test", "passed": true, "output": "12 passed" }], "filesChanged": ["<path>"], "note": "<opcional>" },',
      );
    } else {
      lines.push('  "evidence": "<como você verificou seu trabalho; ex.: \\"npm test: 12 passed, build ok\\">",');
    }
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
    lines.push(
      '- `learnings` (OPCIONAL, memória viva — ADR-0027): se você descobriu algo DURÁVEL e ' +
        'reutilizável (decisão de arquitetura, convenção, armadilha, contrato), registre-o aqui. ' +
        'Cada item é `{ "path": "modules/<modulo>.md", "summary": "<aprendizado conciso>", "scope": "<modulo opcional>" }`. ' +
        'Esses aprendizados são PERSISTIDOS na memória em colmeia e lidos por iterações futuras — ' +
        'é assim que o projeto deixa de recomeçar amnésico. NÃO invente; só registre o que for verdadeiro e útil. Omita se não houver nada durável.',
    );
    lines.push('- `evidence`: obrigatório quando `done: true` — resuma a verificação que você fez (ver seção abaixo).');
    } // fim do formato de marcador (US-F3.5: ausente no runner com schema)

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
    if (this.config.agent.requireStructuredEvidence) {
      lines.push(
        '- ⚠️ Este projeto EXIGE `evidence` ESTRUTURADA: um objeto com `checks` (lista de ' +
          '`{name, passed, output?}`) e opcionalmente `filesChanged`/`note`. Para fechar a task ' +
          '(`done: true`) é OBRIGATÓRIO ao menos UM check com `passed: true`. Uma descrição em ' +
          'texto livre NÃO fecha a task — a validação a tratará como "não verificável" e derivará correção.',
      );
    }
    lines.push('- Se o projeto NÃO tiver como verificar (sem testes/scripts), diga isso explicitamente em `evidence` (ex.: "sem suíte de testes no projeto — verificação manual da lógica").');

    // #6: canal ESTRUTURADO de pergunta (HITL). Substitui a instrução vaga.
    // US-F3.5 — no runner com schema o canal é a variante `question` da união
    // (emitir os dois é impossível por construção — R12); as regras de forma
    // (UMA pergunta, 2–4 options) vivem nos `.describe()` do schema.
    lines.push('');
    lines.push('## Quando precisar de decisão humana (HITL)');
    if (structuredOutput) {
      lines.push(
        'Se você precisar de uma decisão do humano para continuar, responda com a variante ' +
          '`question` do resultado estruturado (em vez de `result`): UMA pergunta objetiva, ' +
          'com 2 a 4 `options` curtas quando houver alternativas (o humano pode sempre ' +
          'responder livremente). A task fica aguardando; a resposta chega no handoff da ' +
          'próxima iteração.',
      );
      return lines.join('\n');
    }
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
