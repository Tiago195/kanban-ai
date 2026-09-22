import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { useProjectWiki, useProjectWikiArticle } from "../hooks/useProjectExplorer";
import { wikiArticlePath } from "../lib/explorerShell";
import {
  deriveWikiView,
  isSafeWikiSlug,
  localizeWikiMarkdown,
  parseWikiNav,
  wikiSlugFromHref,
  type WikiNavEntry,
} from "../lib/wikiView";
import { MarkdownLite } from "./MarkdownLite";

/**
 * US-UX.5 — a Wiki ganha NAVEGAÇÃO de verdade: a lista de artigos
 * (comunidades + nós centrais, com contagem) fica AO LADO do artigo — não
 * dentro do documento de índice — e o artigo aberto entra na URL
 * (`/explorer/:projectId/wiki/:slug`): F5 e colar o link reabrem o MESMO
 * artigo. Os cabeçalhos estruturais do graphify (inglês) são traduzidos no
 * render (`localizeWikiMarkdown`); a prosa gerada segue como veio.
 * Estados de erro/vazio continuam VISÍVEIS e honestos (padrão da US-F5.4).
 */
export function ProjectWikiTab({
  projectId,
  articleSlug,
}: {
  projectId: string | null;
  /** slug vindo da URL (deep link); `null` = home da wiki. */
  articleSlug: string | null;
}) {
  const navigate = useNavigate();
  const goTo = (slug: string | null) => {
    if (projectId) navigate(wikiArticlePath(projectId, slug === "index" ? null : slug));
  };

  // US-UX.5 — slug colado na URL fora das regras do controller (path/espaço/
  // `..`) nem consulta a API: erro honesto direto (a defesa do servidor — 400
  // — continua de pé para quem bater nela por fora).
  const badSlug = articleSlug != null && !isSafeWikiSlug(articleSlug);
  const slug = !articleSlug || badSlug ? "index" : articleSlug;

  const wikiQuery = useProjectWiki(projectId);
  const index = wikiQuery.data;
  const generated = index?.ok === true && index.generated;
  // O `index.md` alimenta a navegação lateral SEMPRE (mesmo com artigo aberto).
  const indexArticleQuery = useProjectWikiArticle(projectId, "index", generated);
  const articleQuery = useProjectWikiArticle(projectId, slug, generated && !badSlug);

  const view = deriveWikiView({
    indexLoading: wikiQuery.isLoading,
    index,
    slug,
    articleLoading: articleQuery.isLoading,
    article: articleQuery.data,
  });

  const nav = useMemo(() => {
    const content =
      indexArticleQuery.data?.ok === true ? indexArticleQuery.data.content : "";
    return parseWikiNav(content);
  }, [indexArticleQuery.data]);

  // Resolver dos links do markdown: href interno (`slug.md`) vira navegação —
  // agora via URL (deep link), não mais estado local.
  const linkResolver = useMemo(
    () => (href: string) => {
      const target = wikiSlugFromHref(href);
      if (!target) return null;
      return () => {
        if (projectId)
          navigate(wikiArticlePath(projectId, target === "index" ? null : target));
      };
    },
    [projectId, navigate],
  );

  if (view.kind === "loading") {
    return <div data-testid="wiki-tab" style={{ color: "var(--text-muted)" }}>Carregando wiki…</div>;
  }
  if (view.kind === "unavailable") {
    return (
      <div data-testid="wiki-tab">
        <WikiEmptyState
          title="Wiki indisponível"
          hint={`Não foi possível consultar a wiki: ${view.error}`}
        />
      </div>
    );
  }
  if (view.kind === "empty") {
    return (
      <div data-testid="wiki-tab">
        <WikiEmptyState
          title="A wiki ainda não foi gerada"
          hint="Ela é derivada do grafo de conhecimento — assim que o grafo deste projeto for construído, o índice e os artigos aparecem aqui."
        />
      </div>
    );
  }

  const articles = index?.ok === true ? index.articles : [];
  const hasNav = nav.communities.length > 0 || nav.godNodes.length > 0;

  return (
    <div data-testid="wiki-tab" className="wiki-layout">
      {/* A navegação: comunidades + nós centrais derivados do index.md; se o
          formato do índice mudar, cai para a lista plana de artigos. */}
      <nav className="wiki-nav" data-testid="wiki-nav" aria-label="Artigos da wiki">
        <button
          type="button"
          className="wiki-nav-item"
          data-testid="wiki-nav-home"
          aria-current={!articleSlug ? "page" : undefined}
          onClick={() => goTo(null)}
        >
          <span>📖 Visão geral</span>
        </button>
        {hasNav ? (
          <>
            <WikiNavSection
              title={`Comunidades (${nav.communities.length})`}
              entries={nav.communities}
              unit="nós"
              active={articleSlug}
              onOpen={goTo}
            />
            <WikiNavSection
              title={`Nós centrais (${nav.godNodes.length})`}
              entries={nav.godNodes}
              unit="conexões"
              active={articleSlug}
              onOpen={goTo}
            />
          </>
        ) : (
          <WikiNavSection
            title={`Artigos (${articles.length})`}
            entries={articles.map((a) => ({ slug: a.slug, title: a.title, count: null }))}
            unit=""
            active={articleSlug}
            onOpen={goTo}
          />
        )}
      </nav>

      <div className="wiki-article-pane">
        {badSlug ? (
          <WikiEmptyState
            title={`Artigo "${articleSlug}" inválido`}
            hint="O endereço não aponta para um artigo desta wiki — escolha um na lista."
          />
        ) : !articleSlug ? (
          <WikiHome
            stats={nav.stats}
            articleCount={articles.length}
            generatedAt={index?.ok === true ? index.generatedAt : null}
          />
        ) : view.kind === "article-loading" ? (
          <div style={{ color: "var(--text-muted)" }}>Carregando artigo…</div>
        ) : view.kind === "article-error" ? (
          <WikiEmptyState
            title={`Artigo "${view.slug}" indisponível`}
            hint={`${view.error} — a wiki pode ter sido regenerada; escolha outro artigo na lista.`}
          />
        ) : (
          <div style={{ maxHeight: "70vh", overflow: "auto" }} data-testid="wiki-article">
            <MarkdownLite text={localizeWikiMarkdown(view.content)} onLinkClick={linkResolver} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Uma seção da navegação (título + lista de artigos com contagem). */
function WikiNavSection({
  title,
  entries,
  unit,
  active,
  onOpen,
}: {
  title: string;
  entries: WikiNavEntry[];
  unit: string;
  active: string | null;
  onOpen: (slug: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section>
      <div className="wiki-nav-section-title">{title}</div>
      {entries.map((entry) => (
        <button
          key={entry.slug}
          type="button"
          className="wiki-nav-item"
          data-testid="wiki-nav-item"
          aria-current={entry.slug === active ? "page" : undefined}
          title={entry.count != null ? `${entry.title} — ${entry.count} ${unit}` : entry.title}
          onClick={() => onOpen(entry.slug)}
        >
          <span className="wiki-nav-item-title">{entry.title}</span>
          {entry.count != null ? <span className="wiki-nav-count">{entry.count}</span> : null}
        </button>
      ))}
    </section>
  );
}

/**
 * Home da wiki (sem artigo na URL): resumo do grafo + convite à navegação.
 * Substitui a exibição do `index.md` cru — as listas de comunidades/nós já
 * estão na navegação ao lado (era a TERCEIRA repetição delas em outro formato).
 */
function WikiHome({
  stats,
  articleCount,
  generatedAt,
}: {
  stats: { nodes: number; edges: number; communities: number } | null;
  articleCount: number;
  generatedAt: string | null;
}) {
  return (
    <div data-testid="wiki-home" className="modal-section" style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>📖 Wiki do projeto</div>
      <div style={{ fontSize: 13 }}>
        Base de conhecimento derivada do grafo — {articleCount} artigos gerados
        automaticamente. Escolha um artigo na lista ao lado: as{" "}
        <strong>comunidades</strong> dão o contexto; os <strong>nós centrais</strong>{" "}
        detalham os conceitos mais conectados.
      </div>
      {stats ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span className="chip">{stats.nodes} nós</span>
          <span className="chip">{stats.edges} arestas</span>
          <span className="chip">{stats.communities} comunidades</span>
        </div>
      ) : null}
      {generatedAt ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          gerada em {new Date(generatedAt).toLocaleString()}
        </div>
      ) : null}
    </div>
  );
}

/** Estado vazio/erro honesto (mesmo visual do EmptyState do Explorer). */
function WikiEmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div
      data-testid="wiki-empty-state"
      style={{
        textAlign: "center",
        padding: "32px 16px",
        color: "var(--text-muted)",
        border: "1px dashed var(--border)",
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12, marginTop: 6 }}>{hint}</div>
    </div>
  );
}
