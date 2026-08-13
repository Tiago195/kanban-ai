import type { BlockKind } from '@kanban-ai/shared';

/**
 * US-HARD4 — Catálogo TIPADO de ações guardadas (fail-closed).
 *
 * Objetivo: dar às ações privilegiadas do loop engine (auto-commit/PR, avanço de
 * epic, transição de story, etc.) um gate uniforme `allow | hold | deny` **sem**
 * criar um subsistema novo de aprovações. O `hold` REUSA a máquina de HITL que já
 * existe no `Orchestrator` (`escalateToHuman`/`needsHuman` + `card.needs_human`).
 *
 * Duas garantias de tipo:
 *  1. **Marca (brand) opaca** — `GuardedAction<Name, Input>` é uma marca de tipo,
 *     não construível à mão. A ÚNICA forma de obter uma é via `defineGuardedAction`,
 *     que exige um `guardFn`. Chamar `runGuarded` com qualquer outra coisa é erro
 *     de compilação → "sem wiring = build error".
 *  2. **Fail-closed** — um guard que lança é tratado como `deny` (a ação NÃO roda).
 *
 * Boundaries: este arquivo NÃO importa nada do `Orchestrator`. O caminho de HITL
 * é injetado como uma interface (`GuardedActionContext.escalate`), então o
 * catálogo permanece desacoplado dos internals do orquestrador.
 */

/** Decisão que um guard pode devolver. */
export type GuardResult =
  | { decision: 'allow' }
  | { decision: 'hold'; reason: string }
  | { decision: 'deny'; reason: string };

/** Marca de tipo única para impedir construção de `GuardedAction` fora daqui. */
declare const guardedActionBrand: unique symbol;

/**
 * Ação guardada TIPADA e OPACA. Só `defineGuardedAction` a produz; consumidores
 * a tratam como um handle imutável. `name` e `Input` viajam no tipo para manter
 * o registry e o `runGuarded` type-safe.
 */
export interface GuardedAction<Name extends string, Input> {
  readonly name: Name;
  readonly guard: (input: Input, ctx: GuardedActionContext) => GuardResult | Promise<GuardResult>;
  /** Marca opaca (erased em runtime): só `defineGuardedAction` produz o tipo. */
  readonly [guardedActionBrand]: true;
}

/**
 * Contexto injetado no `runGuarded`. O `escalate` é o adaptador para o HITL
 * existente — mantém o catálogo sem dependência dos internals do orquestrador.
 */
export interface GuardedActionContext {
  /** Reusa o HITL existente (`escalateToHuman` → `needsHuman`/`card.needs_human`). */
  escalate: (reason: string, kind?: BlockKind) => void | Promise<void>;
}

/** Erro tipado lançado quando um guard nega (ou lança) — o chamador o surfaça. */
export class GuardedActionDeniedError extends Error {
  readonly actionName: string;
  readonly reason: string;
  constructor(actionName: string, reason: string) {
    super(`Ação guardada "${actionName}" negada: ${reason}`);
    this.name = 'GuardedActionDeniedError';
    this.actionName = actionName;
    this.reason = reason;
  }
}

/**
 * Registra uma ação guardada. Retornar isto é a ÚNICA maneira de obter um
 * `GuardedAction`; qualquer chamada a `runGuarded` exige um objeto produzido
 * aqui. Esquecer de declarar o guard ⇒ erro de compilação no ponto de uso.
 */
export function defineGuardedAction<Name extends string, Input>(
  name: Name,
  guard: (input: Input, ctx: GuardedActionContext) => GuardResult | Promise<GuardResult>,
): GuardedAction<Name, Input> {
  return { name, guard } as unknown as GuardedAction<Name, Input>;
}

/** Resultado de `runGuarded` quando a ação é liberada. */
export type GuardedRunResult<T> =
  | { ran: true; value: T }
  | { ran: false; held: true; reason: string };

/**
 * Executa uma ação guardada FAIL-CLOSED:
 *  - `allow` → roda `perform` e devolve `{ ran: true, value }`.
 *  - `hold`  → chama `ctx.escalate(reason)` (reusa o HITL) e devolve
 *              `{ ran: false, held: true, reason }`. NÃO roda `perform`.
 *  - `deny`  → lança `GuardedActionDeniedError` (o chamador surfaça).
 *  - guard lança → tratado como `deny` (fail-closed): NÃO roda `perform`.
 *
 * Só aceita um `GuardedAction` de marca — chamar com algo não registrado é erro
 * de compilação (a garantia "sem guard = build error").
 */
export async function runGuarded<Name extends string, Input, T>(
  action: GuardedAction<Name, Input>,
  input: Input,
  ctx: GuardedActionContext,
  perform: (input: Input) => Promise<T> | T,
): Promise<GuardedRunResult<T>> {
  let result: GuardResult;
  try {
    result = await action.guard(input, ctx);
  } catch (err) {
    // Fail-closed: qualquer erro no guard nega a ação.
    const reason = err instanceof Error ? err.message : String(err);
    throw new GuardedActionDeniedError(action.name, `guard falhou (fail-closed): ${reason}`);
  }

  switch (result.decision) {
    case 'allow': {
      const value = await perform(input);
      return { ran: true, value };
    }
    case 'hold': {
      await ctx.escalate(result.reason, 'needs_input');
      return { ran: false, held: true, reason: result.reason };
    }
    case 'deny':
      throw new GuardedActionDeniedError(action.name, result.reason);
  }
}

/**
 * Registry central — nome → definição. Serve de âncora de compilação: se uma
 * ação privilegiada some daqui, o caminho que a consome via `GUARDED_ACTIONS.<x>`
 * deixa de compilar (a prova "sem guard = build error").
 */
export const GUARDED_ACTIONS = {
  /**
   * Auto-commit do worktree isolado (US-OBS3/ADR-0037). Privilegiada: escreve no
   * git do repo-alvo (via ENGINE). O guard é o portão fail-closed; a lógica de
   * SKIP benigno (opt-in off, evidência não verificável, sem worktree) fica no
   * `perform` (`performAutoCommit`) e é preservada como allow.
   *
   * O `hold` (reusa HITL) dispara SÓ quando a ação REALMENTE iria escrever no
   * git — opt-in ligado + evidência verificável — mas há uma exigência explícita
   * de aprovação humana antes de commitar (`requireHumanApproval`). Assim o gate
   * não altera os skips benignos existentes; ele intercepta apenas o momento
   * privilegiado (o commit de fato).
   */
  autoCommit: defineGuardedAction<'autoCommit', AutoCommitGuardInput>(
    'autoCommit',
    (input) => {
      // Skips benignos seguem para o `perform` (que devolve o skippedReason
      // correto: 'disabled' / 'not-verified' / 'no-isolated-worktree' / ...).
      if (!input.autoCommitEnabled) return { decision: 'allow' };
      if (!input.evidenceVerified) return { decision: 'allow' };
      // Chegou aqui = a ação PRIVILEGIADA (write no git) está prestes a rodar.
      if (input.requireHumanApproval) {
        return {
          decision: 'hold',
          reason:
            'auto-commit verificado, mas a aprovação humana é obrigatória antes ' +
            'de escrever no repositório — segurando para revisão.',
        };
      }
      return { decision: 'allow' };
    },
  ),
} as const;

/** Entrada do guard de auto-commit (sinais vivos, avaliados no momento da ação). */
export interface AutoCommitGuardInput {
  autoCommitEnabled: boolean;
  evidenceVerified: boolean;
  /**
   * Exige aprovação humana ANTES do commit (mesmo verificado). Quando true e a
   * ação iria de fato escrever no git, o guard SEGURA (hold) e reusa o HITL.
   */
  requireHumanApproval: boolean;
}
