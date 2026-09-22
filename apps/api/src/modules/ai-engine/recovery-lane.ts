/**
 * US-OBS2-5 — Cheap recovery model-profile lane.
 *
 * Wakes de RECUPERAÇÃO / status-only (as que apenas normalizam o estado, limpam
 * o lock e pedem intervenção humana — NÃO produzem trabalho entregável) devem
 * rodar com um modelo BARATO configurável e um guard explícito para a AI NÃO
 * produzir deliverable. Wakes de trabalho NORMAL mantêm o modelo normal e NÃO
 * carregam esse guard.
 *
 * Este módulo concentra a lógica PURA (sem I/O, sem DB) usada pelo orquestrador,
 * para que os specs consigam cobri-la sem banco.
 */

/**
 * Marca o guard de recuperação status-only injetado no prompt. Usada nos specs
 * para asseverar presença (recovery) / ausência (trabalho normal / scrub).
 */
export const RECOVERY_GUARD_MARKER = '⚠️ Recovery status-only';

/**
 * Resolve o modelo EFETIVO de um dispatch.
 *
 *  - Trabalho normal (`recovery=false`): SEMPRE o modelo normal resolvido em
 *    cascata (task → parents → agent → board → default). O `cheapModelId` é
 *    ignorado.
 *  - Recuperação status-only (`recovery=true`): usa `cheapModelId` quando
 *    definido (não-vazio); caso contrário cai no modelo normal (sem override).
 *
 * `cheapModelId` vazio/whitespace ("fall back to normal model / no override")
 * significa "sem lane barata" — retrocompatível.
 */
export function resolveDispatchModel(
  normalModel: string,
  cheapModelId: string | null | undefined,
  recovery: boolean,
): string {
  if (!recovery) return normalModel;
  const cheap = (cheapModelId ?? '').trim();
  return cheap.length > 0 ? cheap : normalModel;
}

/**
 * US-F3.10 — Resolve o adapter EFETIVO de um dispatch (cascata × recovery lane).
 *
 *  - Trabalho normal (`recovery=false`): o adapter resolvido em cascata
 *    (task → story → epic → board.defaultAdapter → global) VENCE.
 *  - Recuperação status-only (`recovery=true`): a lane VENCE e usa o adapter
 *    GLOBAL (`config.agentAdapter`). Racional: o `AGENT_CHEAP_MODEL_ID` é um id
 *    no namespace de modelos do adapter global — mandá-lo para o adapter do
 *    card seria 404 garantido em outro vendor; e a recuperação é status-only e
 *    barata por princípio: rodar no caminho de hoje (global + modelo barato)
 *    garante que uma task pinada num adapter caro NUNCA fica mais cara
 *    justamente na recuperação. Comportamento idêntico ao pré-F3.10.
 */
export function resolveDispatchAdapter<T>(
  cascadeAdapter: T,
  globalAdapter: T,
  recovery: boolean,
): T {
  return recovery ? globalAdapter : cascadeAdapter;
}

/**
 * Bloco de guard injetado no prompt SOMENTE no caminho de recuperação. Instrui a
 * AI a NÃO produzir trabalho entregável — apenas normalizar o estado/limpar o
 * lock e pedir intervenção humana se necessário.
 */
export function recoveryGuardLines(): string[] {
  return [
    '',
    `## ${RECOVERY_GUARD_MARKER} — NÃO produza trabalho entregável`,
    '- Esta iteração é de RECUPERAÇÃO/status-only: a sessão anterior travou e o ' +
      'estado precisa ser normalizado. **NÃO implemente features, NÃO edite código ' +
      'de produto, NÃO feche o DOD e NÃO commite nada.**',
    '- Sua ÚNICA tarefa é normalizar o estado (limpar o lock/heartbeat residual) e, ' +
      'se algo continuar bloqueando o progresso, PEÇA intervenção humana com um ' +
      'resumo curto do que está travado.',
    '- Reporte no `summary` o que foi normalizado e no `nextStep` o que um humano ' +
      'precisa decidir. `allowDeliverableWork:false`.',
  ];
}
