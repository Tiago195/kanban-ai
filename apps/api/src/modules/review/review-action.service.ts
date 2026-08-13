import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ReviewActionDTO, ReviewActionKind } from '@kanban-ai/shared';

import { PrismaService } from '../../shared/db/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { decideReviewFlag, type FlagDecision } from './review-action.logic';

/** Linha crua do Prisma para `ReviewAction`. */
type ReviewActionRow = {
  id: string;
  cardId: string;
  kind: string;
  detail: unknown;
  ts: Date;
  snoozedUntil: Date | null;
};

/** Entrada para registrar uma review action. */
export interface RecordReviewActionInput {
  cardId: string;
  kind: ReviewActionKind;
  detail: unknown;
}

/**
 * US-OBS2-4 — Registro RATE-LIMITADO e SNOOZE-AWARE de REVIEW ACTIONS.
 *
 * Uma review action é um sinal de anomalia (v1: `no_comment_streak`) surfaçado
 * ao operador de forma VISÍVEL mas NÃO-INTRUSIVA — NÃO move nem cancela a story.
 *
 * A DECISÃO de sinalizar é PURA (`decideReviewFlag`, testável sem DB); este
 * serviço só faz o I/O: lê o estado prévio (última action + snooze), decide,
 * persiste e emite `review.action_flagged`. Reusa o mesmo hub WS dos demais
 * eventos. Observabilidade — não reintroduz DOR/acceptance (ADR-0007).
 */
@Injectable()
export class ReviewActionService {
  private readonly logger = new Logger(ReviewActionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Registra uma review action se o rate-limit/snooze permitir. Retorna a action
   * criada, ou `null` quando suprimida (cooldown/snooze). Best-effort quanto ao
   * WS (o broadcast nunca derruba a persistência).
   */
  async record(
    input: RecordReviewActionInput,
    nowMs: number = Date.now(),
  ): Promise<ReviewActionDTO | null> {
    const last = (await this.prisma.reviewAction.findFirst({
      where: { cardId: input.cardId, kind: input.kind },
      orderBy: { ts: 'desc' },
    })) as ReviewActionRow | null;

    const decision: FlagDecision = decideReviewFlag({
      nowMs,
      cooldownMs: this.config.agent.reviewActionCooldownMs,
      state: {
        lastFlaggedAtMs: last ? last.ts.getTime() : null,
        snoozedUntilMs: last?.snoozedUntil ? last.snoozedUntil.getTime() : null,
      },
    });

    if (!decision.shouldFlag) {
      this.logger.debug?.(
        `review action suprimida (${decision.reason}) card=${input.cardId} kind=${input.kind}`,
      );
      return null;
    }

    const row = (await this.prisma.reviewAction.create({
      data: {
        cardId: input.cardId,
        kind: input.kind,
        detail: input.detail as object,
        ts: new Date(nowMs),
      },
    })) as ReviewActionRow;

    const action = this.map(row);
    this.realtime.broadcast({
      type: 'review.action_flagged',
      cardId: action.cardId,
      action,
    });
    return action;
  }

  /** Lista as review actions de um card (mais recentes primeiro). */
  async listByCard(cardId: string): Promise<ReviewActionDTO[]> {
    const rows = (await this.prisma.reviewAction.findMany({
      where: { cardId },
      orderBy: { ts: 'desc' },
    })) as ReviewActionRow[];
    return rows.map((r) => this.map(r));
  }

  /**
   * Snooza uma review action até `untilMs` (epoch-ms). Enquanto snoozed, o
   * rate-limit puro (`decideReviewFlag`) suprime novos sinais do mesmo
   * (card, kind). Idempotente.
   */
  async snooze(actionId: string, untilMs: number): Promise<ReviewActionDTO> {
    const existing = (await this.prisma.reviewAction.findUnique({
      where: { id: actionId },
    })) as ReviewActionRow | null;
    if (!existing) {
      throw new NotFoundException(`ReviewAction ${actionId} não encontrada`);
    }
    const row = (await this.prisma.reviewAction.update({
      where: { id: actionId },
      data: { snoozedUntil: new Date(untilMs) },
    })) as ReviewActionRow;
    return this.map(row);
  }

  private map(row: ReviewActionRow): ReviewActionDTO {
    return {
      id: row.id,
      cardId: row.cardId,
      kind: row.kind as ReviewActionKind,
      detail: row.detail,
      ts: row.ts instanceof Date ? row.ts.toISOString() : new Date(row.ts).toISOString(),
      snoozedUntil: row.snoozedUntil
        ? row.snoozedUntil instanceof Date
          ? row.snoozedUntil.toISOString()
          : new Date(row.snoozedUntil).toISOString()
        : null,
    };
  }
}
