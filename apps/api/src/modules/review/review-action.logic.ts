/**
 * US-OBS2-4 — Lógica PURA de rate-limit + snooze de REVIEW ACTIONS.
 *
 * Uma "review action" é um sinal de anomalia (ex.: `no_comment_streak`) surfaçado
 * ao operador de forma VISÍVEL mas NÃO-INTRUSIVA. Para não spammar o mesmo card:
 *   - RATE-LIMIT (cooldown): não re-sinaliza o MESMO card/kind mais de uma vez
 *     dentro de uma janela de cooldown;
 *   - SNOOZE: o operador pode silenciar um card/kind até um instante futuro;
 *     enquanto snoozed, o sinal é suprimido (mesmo fora do cooldown).
 *
 * A DECISÃO é pura (sem I/O, sem `Date.now` interno — `nowMs` entra por
 * parâmetro), para ser 100% testável sem banco. O I/O (persistir/emitir) fica no
 * `ReviewActionService`.
 */

import type { ReviewActionKind } from '@kanban-ai/shared';

/**
 * Estado prévio conhecido de um (card, kind) — a última review action registrada
 * e o snooze corrente, se houver. `null`/`undefined` = nunca sinalizado / sem
 * snooze.
 */
export interface ReviewActionState {
  /** Instante (epoch-ms) da ÚLTIMA review action deste (card, kind). */
  lastFlaggedAtMs?: number | null;
  /** Instante (epoch-ms) até o qual este (card, kind) está snoozed. */
  snoozedUntilMs?: number | null;
}

/** Parâmetros da decisão de flag. */
export interface FlagDecisionInput {
  /** "Agora" em epoch-ms (injetado — sem `Date.now` interno). */
  nowMs: number;
  /** Janela de cooldown (ms). `<= 0` desliga o rate-limit. */
  cooldownMs: number;
  /** Estado prévio conhecido do (card, kind). */
  state?: ReviewActionState | null;
}

/** Por que um flag foi suprimido (para logar/observar). */
export type FlagSuppressedReason = 'snoozed' | 'cooldown';

/** Resultado da decisão de flag. */
export interface FlagDecision {
  /** true quando a review action DEVE ser criada/emitida agora. */
  shouldFlag: boolean;
  /** Motivo da supressão quando `shouldFlag=false`. */
  reason?: FlagSuppressedReason;
}

/**
 * Decide se uma nova review action deve ser criada para um (card, kind).
 *
 * Ordem de precedência:
 *   1. SNOOZE ativo (`snoozedUntilMs > nowMs`) → suprime (`reason='snoozed'`).
 *   2. COOLDOWN ativo (`nowMs - lastFlaggedAtMs < cooldownMs`) → suprime
 *      (`reason='cooldown'`). `cooldownMs <= 0` desliga o rate-limit.
 *   3. Caso contrário → `shouldFlag=true`.
 *
 * Snooze EXPIRADO (`snoozedUntilMs <= nowMs`) não suprime — o flag volta a poder
 * ocorrer (respeitando o cooldown).
 */
export function decideReviewFlag(input: FlagDecisionInput): FlagDecision {
  const { nowMs, cooldownMs } = input;
  const state = input.state ?? {};

  const snoozedUntil = state.snoozedUntilMs ?? null;
  if (snoozedUntil !== null && snoozedUntil > nowMs) {
    return { shouldFlag: false, reason: 'snoozed' };
  }

  const lastFlaggedAt = state.lastFlaggedAtMs ?? null;
  if (cooldownMs > 0 && lastFlaggedAt !== null && nowMs - lastFlaggedAt < cooldownMs) {
    return { shouldFlag: false, reason: 'cooldown' };
  }

  return { shouldFlag: true };
}

/** Chave estável de dedup/rate-limit de um sinal. */
export function reviewActionKey(cardId: string, kind: ReviewActionKind): string {
  return `${cardId}::${kind}`;
}
