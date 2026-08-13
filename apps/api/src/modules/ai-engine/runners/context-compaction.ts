/**
 * US-BUX5 — Context-overflow compaction.
 *
 * Funções PURAS (sem estado, sem I/O, determinísticas) usadas pelo
 * `CopilotCliRunner` para recuperar automaticamente de um estouro de janela de
 * contexto: detectar o erro na saída da CLI e compactar o prompt antes de UM
 * retry (bounded a 1 tentativa — ver copilot-cli.runner.ts).
 *
 * Mantidas isoladas de qualquer dependência de framework para serem testáveis
 * sem spawnar processo (context-compaction.spec.ts).
 */

/**
 * Sinais textuais de que a falha foi por estouro de contexto/tokens. O conjunto
 * é abrangente (cobre variações comuns de provedores/CLIs) mas conservador — só
 * casa mensagens que claramente falam de limite de contexto/tokens, para não
 * disparar retry em erros não relacionados (ex.: rede, auth, spawn).
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[\s_-]*(?:length|window|limit|size)/i,
  /maximum context/i,
  /too many tokens/i,
  /token[s]?\s*limit/i,
  /exceed(?:s|ed)?\s+.*(?:context|token)/i,
  /prompt is too long/i,
];

/**
 * Retorna `true` quando `errText` casa algum sinal conhecido de estouro de
 * contexto/tokens. Tolerante a entrada vazia/não-string.
 */
export function isContextOverflowError(errText: string): boolean {
  if (typeof errText !== 'string' || errText.trim().length === 0) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(errText));
}

/** Nota prefixada ao prompt compactado, para a AI saber que houve corte. */
export const COMPACTION_NOTE =
  '[contexto compactado automaticamente: metade mais recente removida para caber no limite]';

/**
 * Limiar (em caracteres) abaixo do qual compactar não vale a pena: um prompt já
 * pequeno não é a causa do estouro, então retornamos ele intacto (no-op).
 */
const MIN_COMPACTABLE_LENGTH = 200;

/**
 * Compacta `prompt` removendo determinísticamente a **metade mais recente** do
 * conteúdo (as linhas do fim, que num handoff correspondem ao histórico mais
 * novo/volumoso) e prefixando `COMPACTION_NOTE`.
 *
 * Determinístico: a mesma entrada sempre produz a mesma saída. Preserva a
 * primeira metade (instruções/lastro mais antigo) e descarta a segunda. Se o
 * prompt já é pequeno (< MIN_COMPACTABLE_LENGTH), é um no-op razoável (retorna
 * o original inalterado — não há o que compactar).
 */
export function compactPrompt(prompt: string): string {
  if (typeof prompt !== 'string') return prompt;
  if (prompt.length < MIN_COMPACTABLE_LENGTH) return prompt;

  const lines = prompt.split('\n');
  if (lines.length >= 2) {
    // Mantém a METADE MAIS ANTIGA das linhas (arredonda pra cima para nunca
    // descartar tudo num prompt de 2-3 linhas).
    const keep = Math.ceil(lines.length / 2);
    const kept = lines.slice(0, keep).join('\n');
    return `${COMPACTION_NOTE}\n${kept}`;
  }

  // Prompt de linha única: corta pela metade dos caracteres.
  const keep = Math.ceil(prompt.length / 2);
  return `${COMPACTION_NOTE}\n${prompt.slice(0, keep)}`;
}
