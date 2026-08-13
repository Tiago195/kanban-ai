/**
 * US-OBS2-4 — Detector PURO de "no-comment streak".
 *
 * Uma story cujo agent roda em loop pode encadear MUITAS iterações sem produzir
 * NENHUM sinal voltado ao humano (nenhum resumo, nenhum handoff, nenhuma
 * escalação). Isso é benigno individualmente, mas um streak longo é um cheiro de
 * "agent trabalhando no escuro" — o operador quer VER isso e decidir se olha.
 *
 * Este módulo concentra a lógica PURA (sem I/O, sem DB, sem `Date.now`) de:
 *   1. o que conta como "comentário / handoff voltado ao humano" numa iteração;
 *   2. quantas iterações consecutivas NO FIM do histórico não produziram nada
 *      voltado ao humano (o streak);
 *   3. se esse streak é anômalo (>= threshold).
 *
 * NÃO move/cancela a story e NÃO duplica watchdog (stuck-sla) nem anti-thrash
 * (loop-helpers.isThrashing) — é um sinal de OBSERVABILIDADE, não uma ação de
 * controle de loop.
 */

/**
 * Sinais mínimos, por iteração, necessários para decidir se ela produziu algo
 * voltado ao humano. Espelha as colunas de `Iteration` (`summary`,
 * `handoffNextStep`) mais um sinal derivado de escalação/HITL (`needsHuman`),
 * que o orquestrador resolve a partir da fase/handoff da iteração.
 *
 * Iterações vêm em ORDEM CRONOLÓGICA (mais antiga → mais recente); o streak é
 * contado a partir do FIM (a mais recente).
 */
export interface StreakIteration {
  /** Resumo curto exibível (coluna `Iteration.summary`). */
  summary?: string | null;
  /** Próximo passo declarado no handoff (coluna `Iteration.handoffNextStep`). */
  handoffNextStep?: string | null;
  /**
   * A iteração escalou/perguntou ao humano (HITL / needs-human). Um sinal
   * voltado ao humano por definição — reseta o streak. Derivado no orquestrador
   * (ex.: `handoffState === 'blocked'` ou a task marcada `needsHuman`).
   */
  needsHuman?: boolean | null;
}

/** Opções do detector. */
export interface DetectNoCommentStreakOptions {
  /**
   * Nº de iterações consecutivas sem comentário a partir do qual o streak é
   * considerado anômalo. `<= 0` desliga a detecção (nunca anômalo).
   */
  threshold: number;
}

/** Resultado do detector. */
export interface NoCommentStreakResult {
  /** true quando o streak é `>= threshold` (e `threshold > 0`). */
  anomalous: boolean;
  /** Comprimento do streak: iterações consecutivas sem comentário no FIM. */
  streak: number;
}

/**
 * Define o que conta como "comentário / handoff voltado ao humano" numa
 * iteração. Uma iteração produziu um sinal voltado ao humano quando QUALQUER um:
 *   - `summary` não-vazio (após trim); OU
 *   - `handoffNextStep` não-vazio (após trim); OU
 *   - `needsHuman` (escalação/HITL — voltado ao humano por definição).
 *
 * Caso contrário é "sem comentário" (a AI iterou "no escuro").
 */
export function iterationHasHumanFacingComment(it: StreakIteration): boolean {
  if (it.needsHuman === true) return true;
  if ((it.summary ?? '').trim().length > 0) return true;
  if ((it.handoffNextStep ?? '').trim().length > 0) return true;
  return false;
}

/**
 * Conta o streak de iterações SEM comentário a partir do FIM (a mais recente).
 * Uma iteração com comentário reseta (encerra) a contagem.
 */
export function trailingNoCommentStreak(iterations: readonly StreakIteration[]): number {
  let streak = 0;
  for (let i = iterations.length - 1; i >= 0; i -= 1) {
    if (iterationHasHumanFacingComment(iterations[i])) break;
    streak += 1;
  }
  return streak;
}

/**
 * Detector puro do "no-comment streak".
 *
 * Regras:
 *   - `threshold <= 0` → detecção desligada (`anomalous=false`).
 *   - histórico vazio → `streak=0`, `anomalous=false`.
 *   - `anomalous = streak >= threshold`.
 */
export function detectNoCommentStreak(
  iterations: readonly StreakIteration[],
  options: DetectNoCommentStreakOptions,
): NoCommentStreakResult {
  const threshold = options.threshold;
  const streak = trailingNoCommentStreak(iterations);
  const anomalous = threshold > 0 && streak >= threshold;
  return { anomalous, streak };
}
