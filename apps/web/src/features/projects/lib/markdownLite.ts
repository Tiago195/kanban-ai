/**
 * US-F4.2 — markdown "lite" para o Memory Viewer (débito da US-F2.8: o detalhe
 * do neurônio mostrava o markdown CRU, com o `---` do frontmatter à vista).
 *
 * Decisão: NENHUMA lib de markdown. O conteúdo dos neurônios é gerado pelos
 * agents (headings, listas, code fences, negrito) — um parser de blocos de ~60
 * linhas cobre isso, é puro (testável sem DOM) e não injeta HTML (o render é
 * feito em elementos React, nunca `dangerouslySetInnerHTML` → sem superfície
 * de XSS mesmo com conteúdo vindo do repo-alvo).
 */

/** Separa o frontmatter YAML (`---\n...\n---`) do corpo do markdown. */
export function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { frontmatter: null, body: md };
  return { frontmatter: m[1], body: md.slice(m[0].length) };
}

/** Segmento inline: texto puro, `code`, **negrito**, [link](url) ou *itálico*. */
export type InlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'link'; text: string; href: string }
  /**
   * US-UX.5 — itálico (`*x*`/`_x_`); o rodapé graphify de TODOS os artigos é
   * `*Part of ... See [index](index.md) to navigate.*` — o link vive DENTRO
   * do itálico, então o conteúdo é parseado recursivamente em segmentos.
   */
  | { kind: 'em'; segments: InlineSegment[] };

/** Bloco do markdown lite. */
export type MarkdownBlock =
  | { kind: 'heading'; level: number; segments: InlineSegment[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; items: InlineSegment[][] }
  | { kind: 'quote'; segments: InlineSegment[] }
  | { kind: 'rule' }
  | { kind: 'para'; segments: InlineSegment[] };

/** US-UX.5 — régua horizontal (`---`/`***`/`___`), débito declarado da F4.2. */
const RULE_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** US-UX.5 — linha de citação (`> texto`), débito declarado da F4.2. */
const QUOTE_RE = /^\s*>/;

// US-UX.5 — itálico entrou por ÚLTIMO na alternância: `**negrito**` casa antes
// de `*itálico*` (nunca vira <em>*a*</em>); o conteúdo não pode começar/terminar
// em espaço; `_` só delimita em fronteira de palavra — `snake_case_name` e os
// identificadores dos artigos/neurônios (`index_arraymovemutable`) ficam intactos.
const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<!\w)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g;

/** Quebra uma linha em segmentos inline (`code`, **bold**, [t](url), *em*, texto). */
export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) });
    if (m[1] != null) out.push({ kind: 'code', text: m[1] });
    else if (m[2] != null) out.push({ kind: 'bold', text: m[2] });
    else if (m[3] != null) out.push({ kind: 'link', text: m[3], href: m[4] });
    // US-UX.5 — itálico: conteúdo re-parseado (o rodapé graphify tem link
    // dentro do itálico, que precisa continuar navegável). Termina sempre:
    // o texto interno é estritamente menor.
    else out.push({ kind: 'em', segments: parseInline((m[5] ?? m[6]) as string) });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * Parser de blocos: headings (#..######), code fences (```), listas
 * (marcadores `-`, `*` ou `1.`) e parágrafos. Linhas consecutivas de
 * parágrafo são unidas com espaço.
 */
export function parseMarkdownBlocks(body: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // consome o ``` de fechamento (ou o fim do arquivo)
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: buf.join('\n') });
      continue;
    }
    // US-UX.5 — `---` virava parágrafo literal na tela (visível na Wiki).
    if (RULE_RE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    // US-UX.5 — `> citação` também saía crua; linhas consecutivas viram UM bloco.
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', segments: parseInline(buf.join(' ')) });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, segments: parseInline(heading[2]) });
      i += 1;
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const items: InlineSegment[][] = [];
      while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, '')));
        i += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      // US-UX.5 — citação e régua também encerram o parágrafo corrente.
      !/^(#{1,6})\s|^```|^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !RULE_RE.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: 'para', segments: parseInline(buf.join(' ')) });
  }
  return blocks;
}
