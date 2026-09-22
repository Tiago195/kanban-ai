/**
 * US-F5.4 — helpers PUROS da aba "Wiki" (máquina de estados da tela e
 * resolução dos links internos entre artigos). Sem dependência e sem DOM —
 * mesmo padrão das US-F4.2/F4.3 (`graphView.ts`/`fileCards.ts`): a lógica
 * fica testável aqui e o componente só projeta o estado.
 */

import type { ProjectWikiArticleResponse, ProjectWikiIndexResponse } from '@kanban-ai/shared';

/**
 * Resolve o `href` de um link do markdown da wiki para um slug de artigo
 * interno, ou `null` quando o link NÃO é um artigo (externo/anchor/path):
 * o `to_wiki` do graphify emite links `[label](slug.md)` cujo destino é o
 * nome do arquivo VERBATIM — relativo, segmento único, terminado em `.md`.
 * Qualquer outra coisa (http(s), `//`, separador de path, `..`) não navega.
 */
export function wikiSlugFromHref(href: string): string | null {
  if (!href || !href.endsWith('.md')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null; // URL absoluta
  if (href.includes('/') || href.includes('\\')) return null; // nunca path
  const slug = href.slice(0, -'.md'.length);
  if (!slug || slug === '.' || slug === '..') return null;
  return slug;
}

/**
 * US-UX.5 — o slug vindo da URL (deep link) é seguro para consultar a API?
 * Mesmas regras da validação do controller (que devolve 400 e o fetch
 * estoura): sem separador de path, sem espaço, sem `.`/`..`. Inválido → a UI
 * mostra erro honesto SEM bater na API.
 */
export function isSafeWikiSlug(slug: string): boolean {
  if (!slug || slug === '.' || slug === '..') return false;
  return !/[/\\ ]/.test(slug);
}

/**
 * US-UX.5 — cabeçalhos estruturais do graphify (conjunto pequeno e FECHADO,
 * levantado dos artigos reais) traduzidos no render. Cabeçalho fora da lista
 * passa INTACTO — nunca some conteúdo desconhecido. A prosa não é traduzida.
 */
const WIKI_HEADING_PT: Record<string, string> = {
  'Knowledge Graph Index': 'Índice do grafo de conhecimento',
  Communities: 'Comunidades',
  'God Nodes': 'Nós centrais (god nodes)',
  'Key Concepts': 'Conceitos-chave',
  Relationships: 'Relações',
  'Source Files': 'Arquivos-fonte',
  'Audit Trail': 'Trilha de auditoria',
  'Connections by Relation': 'Conexões por relação',
  // Relações do grafo usadas como sub-cabeçalho (### contains etc.).
  contains: 'contém',
  extends: 'estende',
  imports: 'importa',
  calls: 'chama',
};

/** Traduz UM texto de cabeçalho; desconhecido volta como veio. */
export function localizeWikiHeading(text: string): string {
  return WIKI_HEADING_PT[text.trim()] ?? text;
}

/**
 * US-UX.5 — aplica a tradução SOMENTE em linhas de heading (`#`..`######`),
 * fora de code fences. O resto do markdown passa byte a byte.
 */
export function localizeWikiMarkdown(content: string): string {
  let inFence = false;
  return content
    .split(/\r?\n/)
    .map((line) => {
      if (/^```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!m) return line;
      return `${m[1]} ${localizeWikiHeading(m[2])}`;
    })
    .join('\n');
}

/** US-UX.5 — entrada da navegação lateral derivada do `index.md`. */
export interface WikiNavEntry {
  slug: string;
  title: string;
  /** nós (comunidade) ou conexões (god node); `null` se o índice não disser. */
  count: number | null;
}

export interface WikiNav {
  /** `**N nodes · M edges · K communities**` do índice, se presente. */
  stats: { nodes: number; edges: number; communities: number } | null;
  communities: WikiNavEntry[];
  godNodes: WikiNavEntry[];
}

/**
 * US-UX.5 — deriva a navegação (lista de artigos AO LADO do documento, não
 * dentro dele) do markdown do `index.md` gerado pelo graphify: seções
 * `## Communities` e `## God Nodes` com itens `- [título](slug.md) — N …`.
 * Formato fora do esperado → listas vazias (a UI cai para a lista plana de
 * `articles` do índice estruturado — nunca some artigo).
 */
export function parseWikiNav(indexContent: string): WikiNav {
  const nav: WikiNav = { stats: null, communities: [], godNodes: [] };
  let section: 'communities' | 'godNodes' | null = null;
  for (const line of indexContent.split(/\r?\n/)) {
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      section =
        title === 'Communities' ? 'communities' : title === 'God Nodes' ? 'godNodes' : null;
      continue;
    }
    const stats = /\*\*(\d+) nodes · (\d+) edges · (\d+) communities\*\*/.exec(line);
    if (stats) {
      nav.stats = { nodes: +stats[1], edges: +stats[2], communities: +stats[3] };
      continue;
    }
    if (!section) continue;
    const item = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(?:\s*[—–-]+\s*(\d+))?/.exec(line);
    if (!item) continue;
    const slug = wikiSlugFromHref(item[2]);
    if (!slug) continue;
    nav[section].push({ slug, title: item[1], count: item[3] != null ? +item[3] : null });
  }
  return nav;
}

/** Estado projetado da aba Wiki — a UI só faz switch sobre ele. */
export type WikiViewState =
  | { kind: 'loading' }
  /** Sidecar fora / integração desligada — falha VISÍVEL, nunca tela muda. */
  | { kind: 'unavailable'; error: string }
  /** Wiki ainda não gerada (grafo não pronto ou geração pendente/falhou). */
  | { kind: 'empty' }
  | { kind: 'article-loading'; slug: string }
  | { kind: 'article-error'; slug: string; error: string }
  | { kind: 'article'; slug: string; title: string; content: string };

/**
 * Deriva o estado da tela a partir das duas queries (índice + artigo).
 * O "índice navegável" É um artigo (`index.md` — catálogo de comunidades e
 * god nodes com links), então a leitura de artigo cobre também a home da
 * wiki; o índice estruturado (`articles`) alimenta o cabeçalho/contagem.
 */
export function deriveWikiView(args: {
  indexLoading: boolean;
  index: ProjectWikiIndexResponse | undefined;
  slug: string;
  articleLoading: boolean;
  article: ProjectWikiArticleResponse | undefined;
}): WikiViewState {
  const { indexLoading, index, slug, articleLoading, article } = args;
  if (indexLoading) return { kind: 'loading' };
  if (!index) return { kind: 'unavailable', error: 'sem resposta do servidor' };
  if (!index.ok) return { kind: 'unavailable', error: index.error };
  if (!index.generated) return { kind: 'empty' };
  if (articleLoading || !article) return { kind: 'article-loading', slug };
  if (!article.ok) return { kind: 'article-error', slug, error: article.error };
  return { kind: 'article', slug: article.slug, title: article.title, content: article.content };
}
