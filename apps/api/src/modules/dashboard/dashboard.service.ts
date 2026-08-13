import { Inject, Injectable } from '@nestjs/common';
import {
  BOARD_COLUMNS,
  type FleetColumnCount,
  type FleetCostSummary,
  type FleetDashboard,
  type FleetStaleStory,
  type LoopMetrics,
} from '@kanban-ai/shared';

import { PrismaService } from '../../shared/db/prisma.service';
import { Orchestrator } from '../ai-engine/orchestrator';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';

/**
 * US-OBS1 — Read-model agregado da frota de agents.
 *
 * Consolida três leituras (todas READ-ONLY, sem migration):
 *  1. Contagem de cards por coluna do board (`FleetColumnCount[]`).
 *  2. Stories "stale" em `In Progress` sem iteração recente (`FleetStaleStory[]`).
 *  3. Burn/cost agregado das stories ativas (`FleetCostSummary`), reusando
 *     `Orchestrator.computeStoryMetrics` (sem alterar sua assinatura).
 *
 * INVARIANTES: não move epic (inv. 2), não cria task (inv. 3) — só lê.
 *
 * SANITIZAÇÃO (obrigatória): nenhum select/retorno inclui `aiProject` (caminho
 * de FS do usuário), env, credenciais ou transcript bruto. O objeto retornado
 * jamais contém a string do repo-alvo.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: Orchestrator,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Monta o read-model agregado completo da frota. */
  async getFleetDashboard(): Promise<FleetDashboard> {
    const [columns, staleStories, cost] = await Promise.all([
      this.buildColumns(),
      this.buildStaleStories(),
      this.buildCost(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      columns,
      staleStories,
      cost,
    };
  }

  /**
   * Contagem de cards por coluna do board, ordenada como `BOARD_COLUMNS`.
   *
   * A coluna de um card vem via `boardColumn` (epic/story) OU `taskColumn`
   * (task); a Column tem o nome em `title`. Selecionamos só o mínimo (type +
   * títulos das duas relações) — nenhum campo sensível.
   */
  private async buildColumns(): Promise<FleetColumnCount[]> {
    const cards = await this.prisma.card.findMany({
      select: {
        type: true,
        boardColumn: { select: { title: true } },
        taskColumn: { select: { title: true } },
      },
    });

    const empty = (): { epics: number; stories: number; tasks: number } => ({
      epics: 0,
      stories: 0,
      tasks: 0,
    });
    const byColumn = new Map<string, { epics: number; stories: number; tasks: number }>();
    for (const title of BOARD_COLUMNS) byColumn.set(title, empty());

    for (const card of cards) {
      const columnTitle =
        card.type === 'task' ? card.taskColumn?.title : card.boardColumn?.title;
      if (!columnTitle) continue;
      const bucket = byColumn.get(columnTitle);
      if (!bucket) continue; // coluna fora de BOARD_COLUMNS: ignorada
      if (card.type === 'epic') bucket.epics += 1;
      else if (card.type === 'story') bucket.stories += 1;
      else if (card.type === 'task') bucket.tasks += 1;
    }

    return BOARD_COLUMNS.map((column) => {
      const b = byColumn.get(column) ?? empty();
      return {
        column,
        epics: b.epics,
        stories: b.stories,
        tasks: b.tasks,
        total: b.epics + b.stories + b.tasks,
      };
    });
  }

  /** Stories em `In Progress`; carrega só o mínimo (sem `aiProject`). */
  private async loadActiveStories(): Promise<
    Array<{ id: string; key: string; title: string; execState: string | null; updatedAt: Date }>
  > {
    const stories = await this.prisma.card.findMany({
      where: { type: 'story', boardColumn: { title: 'In Progress' } },
      select: {
        id: true,
        key: true,
        title: true,
        execState: true,
        updatedAt: true,
      },
    });
    return stories;
  }

  /**
   * Stories `In Progress` sem progresso recente. Para cada uma pega a última
   * `Iteration` (`orderBy index desc, take 1`) e calcula `staleMinutes` a partir
   * do timestamp da iteração (ou do `updatedAt` da story quando nunca iterou).
   * Só entram as que ultrapassam o threshold; ordenadas desc por `staleMinutes`.
   */
  private async buildStaleStories(): Promise<FleetStaleStory[]> {
    const stories = await this.loadActiveStories();
    if (stories.length === 0) return [];

    const now = Date.now();
    const thresholdMinutes = this.config.dashboard.staleMinutes;

    const rows = await Promise.all(
      stories.map(async (story) => {
        // A última iteração de qualquer task da story (tasks são filhas da story).
        const lastIteration = await this.prisma.iteration.findFirst({
          where: { card: { parentId: story.id, type: 'task' } },
          orderBy: { index: 'desc' },
          select: { ts: true },
        });

        const referenceDate = lastIteration?.ts ?? story.updatedAt;
        const staleMinutes = Math.max(
          0,
          Math.floor((now - referenceDate.getTime()) / 60_000),
        );

        const result: FleetStaleStory = {
          storyId: story.id,
          key: story.key,
          title: story.title,
          execState: story.execState ?? 'idle',
          lastIterationAt: lastIteration ? lastIteration.ts.toISOString() : null,
          staleMinutes,
        };
        return result;
      }),
    );

    return rows
      .filter((row) => row.staleMinutes >= thresholdMinutes)
      .sort((a, b) => b.staleMinutes - a.staleMinutes);
  }

  /**
   * Burn/cost agregado: para cada story ativa reusa
   * `Orchestrator.computeStoryMetrics` e soma tokens/iterações. As taxas
   * (`derivedTaskRate`/`okIterationRate`) são média PONDERADA por `iterationCount`.
   */
  private async buildCost(): Promise<FleetCostSummary> {
    const stories = await this.loadActiveStories();

    const metrics: LoopMetrics[] = await Promise.all(
      stories.map((story) => this.orchestrator.computeStoryMetrics(story.id)),
    );

    let totalIterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let weightedDerived = 0;
    let weightedOk = 0;

    for (const m of metrics) {
      totalIterations += m.iterationCount;
      totalInputTokens += m.totalInputTokens;
      totalOutputTokens += m.totalOutputTokens;
      weightedDerived += m.derivedTaskRate * m.iterationCount;
      weightedOk += m.okIterationRate * m.iterationCount;
    }

    const derivedTaskRate = totalIterations
      ? Number((weightedDerived / totalIterations).toFixed(2))
      : 0;
    const okIterationRate = totalIterations
      ? Number((weightedOk / totalIterations).toFixed(2))
      : 0;

    return {
      activeStories: stories.length,
      totalIterations,
      totalInputTokens,
      totalOutputTokens,
      derivedTaskRate,
      okIterationRate,
    };
  }
}
