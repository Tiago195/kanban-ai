import type { ToolPolicy } from '../../../shared/config/config';

/**
 * US-HARD5 — tradutor PURO da `ToolPolicy` (config) para as flags NATIVAS da
 * Copilot CLI. Isola a decisão "que flags de permissão passar ao `copilot`" num
 * único ponto testável, substituindo o `--allow-all` cru por um contrato
 * granular (tools/paths/urls) sem inventar hooks (não há "PreToolUse" aqui — é
 * um conceito de outra CLI). Ver `docker/copilot-cli-adapter.mjs` (o bridge que
 * consome estas flags no spawn) e ADR-0016/0019.
 *
 * Flags nativas cobertas (verificadas via `copilot --help`):
 *   --allow-all                       (atalho para tools+paths+urls)
 *   --allow-all-tools / --allow-all-paths / --allow-all-urls
 *   --available-tools=<csv>           (allowlist — só estas ficam disponíveis)
 *   --deny-tool=<csv>                 (negadas)
 *   --excluded-tools=<csv>            (removidas do catálogo)
 *   --add-dir <dir>                   (sandbox de paths; um por dir)
 *   --deny-url=<csv>                  (negadas)
 *   --disallow-temp-dir               (nega escrita em tmp)
 *
 * Regra de backwards-compat: `allowAll=true` E sem NENHUMA restrição
 * (deny/available/excluded/urls/dirs/tmp) → emite apenas `['--allow-all']`,
 * idêntico ao comportamento anterior.
 */

/**
 * Deny "hard" padrão (invariante 6): a `WakeupQueue` durável é o ÚNICO mecanismo
 * de auto-agendamento do loop. Se a Copilot CLI expuser uma tool de cron/agenda
 * própria, ela poderia burlar a fila. Não há, hoje, um nome de tool conhecido/
 * estável para isso no `copilot` — então mantemos a lista VAZIA (conservador) e
 * deixamos o bloqueio configurável via `AGENT_TOOL_DENY`. Se um nome canônico
 * surgir, acrescente-o aqui. Documentado no AGENTS.md do módulo.
 */
const WAKEUP_BYPASS_DENY: readonly string[] = [];

/**
 * `true` quando a política tem ALGUMA restrição explícita — nesse caso, mesmo
 * com `allowAll`, não emitimos o `--allow-all` cru (senão a restrição seria
 * ignorada).
 */
function hasAnyRestriction(policy: ToolPolicy): boolean {
  return (
    effectiveDenyTools(policy).length > 0 ||
    policy.availableTools.length > 0 ||
    policy.excludedTools.length > 0 ||
    policy.denyUrls.length > 0 ||
    policy.addDirs.length > 0 ||
    policy.disallowTempDir
  );
}

/** Deny efetivo = deny da config ∪ deny "hard" padrão (dedup, ordem estável). */
function effectiveDenyTools(policy: ToolPolicy): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...WAKEUP_BYPASS_DENY, ...policy.denyTools]) {
    const v = t.trim();
    if (v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Traduz a política num array ORDENADO de flags para o `copilot`.
 *
 * @param policy       política resolvida da config (`config.agent.toolPolicy`).
 * @param worktreeCwd  cwd da execução (worktree isolado). Quando presente e o
 *                     sandbox de paths está ativo, é incluído como `--add-dir`
 *                     (a intenção da story: o worktree é a raiz do sandbox).
 */
export function buildToolPolicyFlags(
  policy: ToolPolicy,
  worktreeCwd?: string,
): string[] {
  const restricted = hasAnyRestriction(policy);

  // Backwards-compat: allow-all sem restrições → exatamente `--allow-all`.
  if (policy.allowAll && !restricted) {
    return ['--allow-all'];
  }

  const flags: string[] = [];
  const deny = effectiveDenyTools(policy);

  // --- Tools ---
  if (policy.availableTools.length > 0) {
    // Allowlist explícita ganha do allow-all-tools (mutuamente exclusivos).
    flags.push(`--available-tools=${policy.availableTools.join(',')}`);
  } else if (policy.allowAll) {
    flags.push('--allow-all-tools');
  }
  if (deny.length > 0) {
    flags.push(`--deny-tool=${deny.join(',')}`);
  }
  if (policy.excludedTools.length > 0) {
    flags.push(`--excluded-tools=${policy.excludedTools.join(',')}`);
  }

  // --- Paths ---
  // Sandbox de paths ativo quando há dirs explícitos, um worktree para incluir,
  // ou tmp negado. Sem nada disso e com allowAll, liberamos todos os paths para
  // não regredir (o worktree do repo-alvo fica fora do dir default do CLI).
  const addDirs = [...policy.addDirs];
  if (worktreeCwd && worktreeCwd.trim().length > 0) {
    addDirs.unshift(worktreeCwd.trim());
  }
  const pathSandbox = addDirs.length > 0 || policy.disallowTempDir;
  if (!pathSandbox && policy.allowAll) {
    flags.push('--allow-all-paths');
  }
  for (const dir of dedup(addDirs)) {
    flags.push('--add-dir', dir);
  }
  if (policy.disallowTempDir) {
    flags.push('--disallow-temp-dir');
  }

  // --- URLs ---
  if (policy.denyUrls.length > 0) {
    flags.push(`--deny-url=${policy.denyUrls.join(',')}`);
    // Deny-list de urls só faz sentido com o resto liberado; mantém allow-all-urls
    // quando allowAll para não bloquear tudo silenciosamente.
    if (policy.allowAll) flags.push('--allow-all-urls');
  } else if (policy.allowAll) {
    flags.push('--allow-all-urls');
  }

  return flags;
}

function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const v = it.trim();
    if (v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
