import type { AgentId } from '@kanban-ai/shared';

/**
 * Registro de tokens de agent do control plane de memória (EP-C / US-C2).
 *
 * Abre a colmeia para agents **externos** (via MCP HTTP ou REST direto) fechando
 * o buraco anterior: o `agentId` e o **escopo** deixam de vir de um `sessionId`
 * livre no body e passam a ser derivados de um **token autenticado**. Cada token
 * mapeia para uma identidade estável e um escopo de escrita.
 *
 * Formato de `MEMORY_API_TOKENS` (env): lista separada por vírgula de entradas
 * `token:agentId:scope`, onde:
 * - `token`   — segredo Bearer que o agent envia em `Authorization: Bearer <token>`;
 * - `agentId` — identidade estável do agent (ex.: `ai:claude-1`). Vira o `holder`
 *   dos leases e o autor lógico dos commits;
 * - `scope`   — módulo do escopo de escrita do agent (ex.: `memory`). É o `module`
 *   que alimenta `MemoryPolicyService.scopeFor(...)`/`classifyWrite(...)`: escrita
 *   fora de `modules/<scope>/` vira REVIEW. Use `*` para escopo GLOBAL (o agent
 *   escreve em qualquer neurônio direto, sem enforcement de escopo).
 *
 * Exemplo:
 *   MEMORY_API_TOKENS=tok-abc:ai:claude-1:memory,tok-xyz:ai:cursor-2:*
 *
 * Retrocompat (US-C2): quando `MEMORY_API_TOKENS` está AUSENTE/vazio, o registro
 * fica **vazio** e a auth é considerada **desligada** (modo dev local) — o
 * `MemoryAuthGuard` deixa passar sem exigir token, preservando o loop engine
 * interno que já consome o controller. Basta configurar a env para LIGAR a auth.
 */

/** Identidade + escopo resolvidos a partir de um token válido. */
export interface MemoryAgentIdentity {
  /** Identidade estável do agent (`holder`/autor). */
  readonly agentId: AgentId;
  /**
   * Módulo do escopo de escrita, ou `undefined` quando o token é GLOBAL (`*`):
   * escreve em qualquer neurônio sem enforcement de escopo.
   */
  readonly scope?: string;
}

/**
 * Registro imutável de tokens → identidade. Puro (sem I/O): recebe a string de
 * env crua no construtor. `enabled` é `false` quando não há nenhum token
 * configurado (modo dev local retrocompatível).
 */
export class MemoryTokenRegistry {
  private readonly byToken: Map<string, MemoryAgentIdentity>;

  constructor(raw: string | undefined) {
    this.byToken = parseTokens(raw);
  }

  /** `true` se ao menos um token está configurado → auth LIGADA. */
  get enabled(): boolean {
    return this.byToken.size > 0;
  }

  /** Resolve a identidade de um token (ou `undefined` se inválido/desconhecido). */
  resolve(token: string | undefined | null): MemoryAgentIdentity | undefined {
    if (!token) return undefined;
    return this.byToken.get(token);
  }
}

/**
 * Extrai o token de um header `Authorization: Bearer <token>` (case-insensitive
 * no esquema). Retorna `undefined` se ausente ou malformado.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | undefined {
  if (!authHeader) return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(authHeader);
  return match ? match[1] : undefined;
}

/**
 * Parseia `MEMORY_API_TOKENS` no formato `token:agentId:scope` (csv). Como o
 * `agentId` canônico contém `:` (ex.: `ai:claude-1`), a divisão é feita por
 * **primeiro** e **último** separador: o 1º campo é o token, o último é o scope,
 * e tudo no meio é o agentId. Entradas malformadas são ignoradas com segurança.
 */
function parseTokens(raw: string | undefined): Map<string, MemoryAgentIdentity> {
  const map = new Map<string, MemoryAgentIdentity>();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const first = trimmed.indexOf(':');
    const last = trimmed.lastIndexOf(':');
    if (first === -1 || last === first) continue; // precisa de token:agentId:scope
    const token = trimmed.slice(0, first).trim();
    const agentId = trimmed.slice(first + 1, last).trim();
    const scopeRaw = trimmed.slice(last + 1).trim();
    if (token.length === 0 || agentId.length === 0 || scopeRaw.length === 0) continue;
    const scope = scopeRaw === '*' ? undefined : scopeRaw;
    map.set(token, { agentId: agentId as AgentId, scope });
  }
  return map;
}
