/**
 * US-OBS2-4 — Contrato compartilhado de REVIEW ACTIONS.
 *
 * Uma review action é um sinal de anomalia detectado por um scan periódico e
 * surfaçado ao operador de forma VISÍVEL mas NÃO-INTRUSIVA. Ela NÃO move nem
 * cancela a story — apenas registra "vale a pena um humano olhar isto". É
 * observabilidade; não reintroduz DOR/acceptance (ADR-0007).
 *
 * O v1 tem UM único `kind`: `no_comment_streak` — o agent rodou N iterações
 * consecutivas sem produzir nenhum comentário/handoff voltado ao humano.
 */

/** Tipos de review action. `no_comment_streak` é o único net-new do v1. */
export const REVIEW_ACTION_KINDS = ['no_comment_streak'] as const;

/** União tipada dos `kind` de review action. */
export type ReviewActionKind = (typeof REVIEW_ACTION_KINDS)[number];

/**
 * Uma review action como exposta pela API e pelo WS. `snoozedUntil` é `null`
 * quando não há snooze ativo; `detail` carrega contexto legível (ex.: o
 * comprimento do streak) sem shape rígido.
 */
export interface ReviewActionDTO {
  id: string;
  cardId: string;
  kind: ReviewActionKind;
  /** Detalhe estruturado do sinal (ex.: `{ streak, threshold }`). */
  detail: unknown;
  /** Instante do sinal em ISO 8601. */
  ts: string;
  /** Instante (ISO 8601) até o qual está snoozed, ou `null`. */
  snoozedUntil: string | null;
}

/** Payload de detalhe de `no_comment_streak`. */
export interface NoCommentStreakDetail {
  /** Comprimento do streak observado. */
  streak: number;
  /** Threshold configurado que disparou o sinal. */
  threshold: number;
  /** Story (card) cujo agent está no escuro. */
  storyId: string;
}
