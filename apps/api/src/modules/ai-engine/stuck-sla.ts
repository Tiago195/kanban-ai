/**
 * US-HARD1 · SLA adaptativo de container travado.
 *
 * Refina o watchdog de intervalo FIXO numa DECISÃO adaptativa: uma sessão está
 * "travada" (stuck) quando seu heartbeat envelheceu além de um teto — mas esse
 * teto ALARGA enquanto uma operação longa está DECLARADA (via
 * `toolDeclaredTimeoutMs`, US-HARD5). Assim uma operação legítima e longa (ex.:
 * um `Bash`/build declarado) NÃO é morta cedo, enquanto um hang real continua
 * detectável pela expiração do lease.
 *
 * Esta é uma função **pura** (invariante 7 — SEM Redis, SEM I/O, SEM `Date.now`
 * interno): todo o tempo entra por parâmetro (`now`), o que a torna trivial de
 * testar em cima de casos determinísticos.
 */

/** Entrada da decisão de "travado". Todos os instantes são epoch-ms. */
export interface StuckDecisionInput {
  /** Instante corrente (epoch-ms) — injetado, nunca lido de `Date.now()` aqui. */
  now: number;
  /**
   * Instante do último heartbeat da sessão (epoch-ms) — mtime do tmpfile de
   * heartbeat ou timestamp persistido. `null`/`undefined` = heartbeat ausente
   * (sessão nunca bateu): tratado como starvation total (`now - 0`).
   */
  lastHeartbeatAt: number | null | undefined;
  /** Teto BASE de silêncio do heartbeat (ms). Deriva de config (ver knob). */
  baseCeilingMs: number;
  /**
   * Timeout DECLARADO da operação longa em curso (ms) — US-HARD5
   * `toolDeclaredTimeoutMs`. `0`/`null` = nenhuma operação longa declarada. Quando
   * presente, ALARGA o teto efetivo para não matar a operação cedo.
   */
  declaredTimeoutMs?: number | null;
  /**
   * Expiração do lease/claim (epoch-ms) — `AgentRuntimeState.claimExpiresAt`.
   * `null`/`undefined` = sem claim (claim desligado ou já solto).
   */
  claimExpiresAt?: number | null;
}

/** Resultado da decisão de "travado". */
export interface StuckDecision {
  /** `true` quando a sessão deve ser recuperada como stalled. */
  stuck: boolean;
  /** Motivo legível (para log/telemetria). */
  reason: string;
}

/**
 * Decide se uma sessão está travada.
 *
 * Regras:
 *  - `effectiveCeiling = max(baseCeilingMs, declaredTimeoutMs ?? 0)` — uma
 *    operação longa DECLARADA alarga a janela.
 *  - `heartbeatStarved = (now - lastHeartbeatAt) > effectiveCeiling`.
 *  - `claimExpired = claimExpiresAt != null && claimExpiresAt <= now`.
 *  - **stuck** quando `heartbeatStarved` (o heartbeat, já alargado pela janela
 *    declarada, envelheceu) OU quando o claim venceu E o heartbeat também está
 *    faminto (dupla confirmação — evita matar um claim recém-vencido que ainda
 *    está batendo heartbeat dentro da janela declarada).
 *  - Uma operação DENTRO da janela declarada NUNCA é considerada travada.
 */
export function decideStuck(input: StuckDecisionInput): StuckDecision {
  const { now, baseCeilingMs, claimExpiresAt } = input;
  const declared = Math.max(0, input.declaredTimeoutMs ?? 0);
  const base = Math.max(0, baseCeilingMs);
  const effectiveCeiling = Math.max(base, declared);

  const lastHeartbeatAt = input.lastHeartbeatAt ?? 0;
  const silenceMs = now - lastHeartbeatAt;
  const heartbeatStarved = silenceMs > effectiveCeiling;

  const claimExpired =
    typeof claimExpiresAt === 'number' && claimExpiresAt <= now;

  if (heartbeatStarved) {
    return {
      stuck: true,
      reason:
        `heartbeat starved: ${silenceMs}ms sem batida > teto efetivo ` +
        `${effectiveCeiling}ms (base=${base}ms, declared=${declared}ms)`,
    };
  }

  if (claimExpired && silenceMs > base) {
    return {
      stuck: true,
      reason:
        `claim vencido (claimExpiresAt=${claimExpiresAt} <= now=${now}) e ` +
        `heartbeat faminto (${silenceMs}ms > base=${base}ms)`,
    };
  }

  return {
    stuck: false,
    reason:
      declared > base
        ? `dentro da janela declarada (silêncio=${silenceMs}ms <= ${effectiveCeiling}ms)`
        : `heartbeat saudável (silêncio=${silenceMs}ms <= ${effectiveCeiling}ms)`,
  };
}
