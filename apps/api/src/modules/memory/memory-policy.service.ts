import { Injectable } from '@nestjs/common';
import type { AgentId } from '@kanban-ai/shared';

/**
 * Prefixo default do módulo dentro da colmeia (ADR-0027). Os neurônios de um
 * módulo vivem sob `modules/<modulo>/…`. Configurável por projeto.
 */
export const MEMORY_MODULE_PREFIX = 'modules';

/** Classificação de uma escrita quanto ao escopo do agent (ver US-212). */
export type MemoryWriteScope = 'in-scope' | 'out-of-scope';

/**
 * Política de **identidade e escopo** da memória (ADR-0027, **EP-83**).
 *
 * Serviço **puro** (sem I/O): concentra as três decisões de governança da
 * colmeia sem reimplementar regra de git/lock/review:
 *
 * - **agentId estável** (US-210): deriva o `holder`/autor a partir da sessão do
 *   loop. Estável dentro da execução da story → atribuição/auditoria coerentes
 *   nos leases (EP-78) e commits (EP-79).
 * - **escopo de escrita** (US-211): os neurônios do **módulo da story** do agent.
 *   Base para decidir dentro-do-escopo (escreve direto) vs fora-do-escopo.
 * - **enforcement** (US-212): **leitura sempre global**; **escrita** dentro do
 *   escopo aplica direto, fora do escopo vira proposta em REVIEW (ponte EP-80).
 *
 * A **política padrão** é recomendada; um projeto pode sobrescrever
 * (`MEMORY_WRITE_SCOPE_ENFORCED=false` desliga o enforcement de escopo de escrita
 * — tudo passa a ser `in-scope`).
 */
@Injectable()
export class MemoryPolicyService {
  private readonly scopeEnforced: boolean;

  constructor(scopeEnforced: boolean = readScopeEnforcedFromEnv()) {
    this.scopeEnforced = scopeEnforced;
  }

  /**
   * US-210 — agentId ESTÁVEL a partir da sessão do loop, usado como `holder` nos
   * leases e como autor lógico nos commits (`ai:<sessao>`). `storyKey` é
   * opcional e serve só para auditoria; a identidade não muda dentro da execução
   * da story porque a sessão é fixa.
   */
  agentIdFor(input: { sessionId: string; storyKey?: string }): AgentId {
    const session = sanitizeSegment(input.sessionId);
    return `ai:${session}`;
  }

  /**
   * US-211 — o **escopo** (prefixo de path) dos neurônios do módulo da story.
   * `modules/<modulo>/`. `module` é resolvido por projeto (label/campo da story);
   * este serviço só materializa o prefixo canônico.
   */
  scopeFor(module: string): string {
    const mod = sanitizeSegment(module);
    return `${MEMORY_MODULE_PREFIX}/${mod}/`;
  }

  /**
   * US-212 — a leitura é **sempre global**: não passa por lock nem escopo.
   * Existe como ponto de decisão explícito para deixar a política auditável.
   */
  canRead(): true {
    return true;
  }

  /**
   * US-212 — classifica uma escrita: `in-scope` (path sob o prefixo do módulo do
   * agent → aplica direto) ou `out-of-scope` (→ proposta em REVIEW, EP-80).
   * Quando o enforcement está desligado por projeto, tudo é `in-scope`.
   */
  classifyWrite(input: { scopePrefix: string; path: string }): MemoryWriteScope {
    if (!this.scopeEnforced) {
      return 'in-scope';
    }
    const path = normalize(input.path);
    const prefix = normalize(input.scopePrefix);
    return path.startsWith(prefix) ? 'in-scope' : 'out-of-scope';
  }

  /** `true` se o enforcement de escopo de escrita está ativo neste projeto. */
  get isScopeEnforced(): boolean {
    return this.scopeEnforced;
  }
}

function readScopeEnforcedFromEnv(): boolean {
  // Política padrão recomendada: enforcement LIGADO. Só desliga com
  // MEMORY_WRITE_SCOPE_ENFORCED explicitamente "false"/"0".
  const raw = process.env.MEMORY_WRITE_SCOPE_ENFORCED;
  if (raw === undefined) return true;
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '-');
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}
