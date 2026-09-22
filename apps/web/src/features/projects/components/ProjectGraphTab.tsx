import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import type {
  GraphFileCard,
  GraphProjection,
  GraphProjectionNode,
  ProjectGraphState,
} from "@kanban-ai/shared";

import { useBoardUiStore } from "@/features/board";

import { useGraphFileCards, useProjectGraph } from "../hooks/useProjectExplorer";
import { fileCardTarget, fileCardsView } from "../lib/fileCards";
import {
  clusterLayout,
  communityBar,
  communityColor,
  groupNodesByCommunity,
  nodeRadius,
  partitionDocumentNoise,
  radialLayout,
  type ClusterLayout,
} from "../lib/graphView";

/**
 * US-F4.2 — aba "Grafo" do Project Explorer: o humano vê o que a AI sabe.
 *
 * DECISÃO VISUAL (US-UX.2 — grafo-primeiro): quem abre a aba vê a FORMA do
 * repositório, não uma lista. A visão padrão é (1) o mapa proporcional de
 * comunidades (largura ∝ nº de nós no grafo completo — "Change Log domina"
 * fica visível de relance) e (2) o esqueleto desenhado: uma bolha por
 * comunidade com os nós em phyllotaxis e as arestas por cima — tudo SVG puro
 * e layout determinístico (`clusterLayout`), zero lib. O ruído documental
 * (`type === 'document'`: headings de CHANGELOG/README) sai do esqueleto POR
 * PADRÃO, com filtro visível e reversível — nada some em silêncio. A lista
 * agrupada virou detalhe (`<details>`). Fluxo da US-F4.1 preservado:
 * overview → comunidade → busca → focus/expand (clicar em qualquer nó re-foca).
 */

type GraphNav =
  | { kind: "overview" }
  | { kind: "community"; id: number; name: string | null }
  | { kind: "focus"; seed: string; label: string; depth: number };

export function ProjectGraphTab({ projectId }: { projectId: string | null }) {
  const [nav, setNav] = useState<GraphNav>({ kind: "overview" });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce da busca (typeahead): 1 request a cada pausa de digitação.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset da navegação ao trocar de Project (o estado é por-projeto).
  useEffect(() => {
    setNav({ kind: "overview" });
    setSearch("");
  }, [projectId]);

  const params = useMemo(() => {
    if (debouncedSearch) return { search: debouncedSearch };
    if (nav.kind === "focus") return { focus: nav.seed, depth: nav.depth };
    if (nav.kind === "community") return { community: nav.id };
    return {};
  }, [debouncedSearch, nav]);

  const graphQuery = useProjectGraph(projectId, params);
  const data = graphQuery.data;

  const focusOn = (node: GraphProjectionNode) => {
    setSearch("");
    setNav({
      kind: "focus",
      seed: node.id,
      label: node.label,
      depth: nav.kind === "focus" ? nav.depth : 1,
    });
  };

  return (
    <div data-testid="graph-tab" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {nav.kind !== "overview" || debouncedSearch ? (
          <button
            className="kb-btn kb-btn-ghost kb-btn-sm"
            data-testid="graph-back"
            onClick={() => {
              setSearch("");
              setNav({ kind: "overview" });
            }}
          >
            ← Visão geral
          </button>
        ) : null}
        <input
          className="card-desc-input"
          placeholder="Buscar nó por nome ou arquivo…"
          data-testid="graph-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ flex: 1, minWidth: 200, margin: 0 }}
        />
        {graphQuery.isFetching ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>atualizando…</span>
        ) : null}
      </div>

      {graphQuery.isLoading ? (
        <div style={{ color: "var(--text-muted)" }}>Carregando grafo…</div>
      ) : graphQuery.isError ? (
        <GraphErrorBox
          message={(graphQuery.error as Error)?.message ?? "erro desconhecido"}
          onRetry={() => void graphQuery.refetch()}
        />
      ) : !data ? null : !data.ok ? (
        <GraphUnavailable state={data.graphState} error={data.error} />
      ) : (
        <GraphProjectionView
          projectId={projectId}
          data={data}
          nav={nav}
          searchTerm={debouncedSearch}
          onFocus={focusOn}
          onCommunity={(id, name) => {
            setSearch("");
            setNav({ kind: "community", id, name });
          }}
          onDepth={(depth) => {
            if (nav.kind === "focus") setNav({ ...nav, depth });
          }}
        />
      )}
    </div>
  );
}

// ── Estados de indisponibilidade (falha VISÍVEL e legível — nunca tela branca) ─

const GRAPH_STATE_LABEL: Record<ProjectGraphState, string> = {
  pending: "ainda não construído",
  building: "em construção",
  // `ready` + `{ok:false}` = o grafo existe mas a CONSULTA falhou (sidecar
  // graphify fora do ar / timeout) — o badge diz isso, não "pronto".
  ready: "indisponível (sidecar fora do ar?)",
  failed: "falhou",
};

function GraphUnavailable({ state, error }: { state: ProjectGraphState; error: string }) {
  const tone = state === "failed" || state === "ready" ? "chip-danger" : "chip-warn";
  return (
    <div
      data-testid="graph-unavailable"
      style={{
        border: "1px dashed var(--border)",
        borderRadius: 8,
        padding: "24px 16px",
        display: "grid",
        gap: 8,
        justifyItems: "center",
        textAlign: "center",
      }}
    >
      <span className={"chip " + tone}>grafo {GRAPH_STATE_LABEL[state]}</span>
      <div style={{ fontSize: 13 }}>{error}</div>
      {state === "building" ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Esta tela atualiza sozinha quando o build terminar.
        </div>
      ) : state === "pending" ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          O grafo é construído automaticamente após o clone/sync do projeto.
        </div>
      ) : null}
    </div>
  );
}

function GraphErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      data-testid="graph-error"
      style={{
        border: "1px dashed var(--border)",
        borderRadius: 8,
        padding: "24px 16px",
        display: "grid",
        gap: 8,
        justifyItems: "center",
        textAlign: "center",
      }}
    >
      <span className="chip chip-danger">falha ao consultar o grafo</span>
      <div style={{ fontSize: 13 }}>{message}</div>
      <button className="kb-btn kb-btn-ghost kb-btn-sm" onClick={onRetry}>
        Tentar de novo
      </button>
    </div>
  );
}

// ── Projeção ok: as quatro visões ────────────────────────────────────────────

function GraphProjectionView({
  projectId,
  data,
  nav,
  searchTerm,
  onFocus,
  onCommunity,
  onDepth,
}: {
  projectId: string | null;
  data: GraphProjection;
  nav: GraphNav;
  searchTerm: string;
  onFocus: (node: GraphProjectionNode) => void;
  onCommunity: (id: number, name: string | null) => void;
  onDepth: (depth: number) => void;
}) {
  return (
    <>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }} data-testid="graph-stats">
        Exibindo {data.nodes.length} de {data.totalNodes} nós · {data.edges.length} de{" "}
        {data.totalEdges} arestas · {data.communities.length} comunidades
      </div>
      {data.truncated ? (
        <div
          data-testid="graph-truncated"
          className="chip chip-warn"
          style={{ justifySelf: "start" }}
        >
          ⚠️ Projeção truncada no servidor — refine com busca ou drill-down.
        </div>
      ) : null}

      {data.mode === "search" ? (
        <SearchView data={data} term={searchTerm} onFocus={onFocus} />
      ) : data.mode === "focus" ? (
        <FocusView
          projectId={projectId}
          data={data}
          depth={nav.kind === "focus" ? nav.depth : 1}
          seedLabel={nav.kind === "focus" ? nav.label : ""}
          onFocus={onFocus}
          onDepth={onDepth}
        />
      ) : data.mode === "community" ? (
        <CommunityView
          data={data}
          name={nav.kind === "community" ? nav.name : null}
          onFocus={onFocus}
        />
      ) : (
        <OverviewView data={data} onFocus={onFocus} onCommunity={onCommunity} />
      )}
    </>
  );
}

const COMMUNITY_PAGE = 24;

function OverviewView({
  data,
  onFocus,
  onCommunity,
}: {
  data: GraphProjection;
  onFocus: (node: GraphProjectionNode) => void;
  onCommunity: (id: number, name: string | null) => void;
}) {
  // US-F4.1: 255 comunidades — paginação obrigatória, nunca renderizar tudo.
  const [visible, setVisible] = useState(COMMUNITY_PAGE);
  // US-UX.2 — ruído documental fora do esqueleto POR PADRÃO, mas reversível:
  // o toggle abaixo mostra QUANTOS nós estão ocultos e devolve todos num clique.
  const [showDocs, setShowDocs] = useState(false);
  const noise = useMemo(() => partitionDocumentNoise(data.nodes), [data.nodes]);
  const shown = showDocs ? data.nodes : noise.visible;
  const layout = useMemo(() => clusterLayout(shown), [shown]);
  const segments = useMemo(() => communityBar(data.communities), [data.communities]);
  const groups = useMemo(() => groupNodesByCommunity(shown), [shown]);
  const maxDegree = groups[0]?.nodes[0]?.degree ?? 1;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* US-UX.2 — mapa proporcional: área ∝ nº de nós no grafo COMPLETO. */}
      <section>
        <SectionTitle>
          Mapa de comunidades — largura proporcional ao nº de nós ({data.totalNodes} no
          grafo) · clique para abrir
        </SectionTitle>
        <div
          data-testid="community-bar"
          role="group"
          aria-label="Mapa proporcional de comunidades"
          style={{
            display: "flex",
            width: "100%",
            borderRadius: 6,
            overflow: "hidden",
            border: "1px solid var(--border)",
          }}
        >
          {segments.map((seg) => (
            <button
              key={seg.id ?? "outras"}
              type="button"
              className="community-bar-segment"
              data-testid="community-bar-segment"
              disabled={seg.id == null}
              onClick={() => {
                if (seg.id != null) onCommunity(seg.id, seg.name);
              }}
              aria-label={`${seg.name ?? `comunidade ${seg.id}`} — ${seg.size} nós (${Math.round(seg.fraction * 100)}%)`}
              title={`${seg.name ?? `comunidade ${seg.id}`} — ${seg.size} nós (${Math.round(seg.fraction * 100)}%)`}
              style={{
                flex: `${seg.fraction} 1 0px`,
                minWidth: 8,
                height: 36,
                border: "none",
                borderRight: "2px solid var(--bg)",
                cursor: seg.id != null ? "pointer" : "default",
                // US-UX.2 — lightness 70 SO na barra: rótulo #16181d passa de
                // 4.5:1 em todo matiz (pior caso h=240 → 5.61:1); bolhas mantêm 58%.
                background: seg.id != null ? communityColor(seg.id, 70) : "var(--surface)",
                color: seg.id != null ? "#16181d" : "var(--text-muted)",
                font: "inherit",
                fontSize: 11,
                fontWeight: 600,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                padding: "0 6px",
              }}
            >
              {seg.fraction > 0.07 ? `${seg.name ?? `c${seg.id}`} · ${seg.size}` : ""}
            </button>
          ))}
        </div>
      </section>

      {/* US-UX.2 — o esqueleto DESENHADO é o evento principal da aba. */}
      <section style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SectionTitle>
            Esqueleto do sistema — {shown.length} nós · clique numa bolha (comunidade) ou
            num nó (focus)
          </SectionTitle>
          {noise.hidden.length > 0 ? (
            <button
              type="button"
              className="chip"
              data-testid="doc-noise-toggle"
              aria-pressed={!showDocs}
              onClick={() => setShowDocs((v) => !v)}
              style={{ cursor: "pointer" }}
              title="Headings de documentação (CHANGELOG, README…) não são a espinha do sistema — mas nada some em silêncio: este filtro é reversível."
            >
              {showDocs
                ? `⨉ ocultar de novo os ${noise.hidden.length} nós documentais`
                : `filtro ativo: ${noise.hidden.length} nós documentais ocultos — clique para exibir`}
            </button>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }} data-testid="skeleton-empty">
            Todos os {data.nodes.length} nós projetados são documentais — desligue o filtro
            acima para vê-los.
          </div>
        ) : (
          <SkeletonGraph
            layout={layout}
            edges={data.edges}
            onFocus={onFocus}
            onCommunity={onCommunity}
          />
        )}
      </section>

      {/* US-UX.2 — as listas viraram DETALHE, não o evento principal. */}
      <details data-testid="community-list">
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
          Todas as comunidades ({data.communities.length})
        </summary>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {data.communities.slice(0, visible).map((c) => (
            <button
              key={c.id}
              className="chip"
              data-testid="community-chip"
              style={{ cursor: "pointer", borderLeft: `3px solid ${communityColor(c.id)}` }}
              onClick={() => onCommunity(c.id, c.name)}
              title={`Comunidade ${c.id} — ${c.size} nós`}
            >
              {c.name ?? `comunidade ${c.id}`} <span style={{ opacity: 0.7 }}>({c.size})</span>
            </button>
          ))}
          {data.communities.length > visible ? (
            <button
              className="kb-btn kb-btn-ghost kb-btn-sm"
              data-testid="community-more"
              onClick={() => setVisible((v) => v + 2 * COMMUNITY_PAGE)}
            >
              mostrar mais ({data.communities.length - visible} restantes)
            </button>
          ) : null}
        </div>
      </details>

      <details data-testid="graph-node-list">
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
          Lista de nós ({shown.length}
          {!showDocs && noise.hidden.length > 0
            ? ` — ${noise.hidden.length} documentais ocultos pelo filtro`
            : ""}
          )
        </summary>
        <div style={{ display: "grid", gap: 10, marginTop: 8, maxWidth: 960 }}>
          {groups.map((group) => (
            <div key={group.community ?? "none"} style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", gap: 6, alignItems: "center" }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: communityColor(group.community),
                    display: "inline-block",
                  }}
                />
                {group.communityName ??
                  (group.community != null ? `comunidade ${group.community}` : "sem comunidade")}
              </div>
              {group.nodes.map((node) => (
                <NodeRow key={node.id} node={node} maxDegree={maxDegree} onFocus={onFocus} />
              ))}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * US-UX.2 — o desenho do esqueleto: bolhas de comunidade (área ∝ nós
 * projetados) empacotadas deterministicamente, nós em phyllotaxis (hub no
 * centro), arestas por cima. SVG puro — mesmo espírito do ego-grafo do focus.
 * Acessível: bolha e nó são focáveis (Tab) e ativáveis por Enter/Espaço; a cor
 * da comunidade é auxiliar — o rótulo manda. No tema `.high-contrast` a cor sai
 * de cena por CSS (index.css): bolha/nó viram traço branco sobre preto e o
 * RÓTULO da bolha é o portador da identidade.
 */
function SkeletonGraph({
  layout,
  edges,
  onFocus,
  onCommunity,
}: {
  layout: ClusterLayout;
  edges: GraphProjection["edges"];
  onFocus: (node: GraphProjectionNode) => void;
  onCommunity: (id: number, name: string | null) => void;
}) {
  const positionById = useMemo(
    () => new Map(layout.positions.map((p) => [p.node.id, p])),
    [layout.positions],
  );

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      style={{
        width: "100%",
        maxHeight: "62vh",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg, 10px)",
        background: "var(--surface, transparent)",
      }}
      data-testid="skeleton-graph"
      role="img"
      aria-label="Esqueleto do sistema: comunidades como bolhas proporcionais, nós e arestas"
    >
      {layout.bubbles.map((bubble) => (
        <g
          key={bubble.community ?? "none"}
          className="skeleton-bubble"
          data-testid="skeleton-bubble"
          role={bubble.community != null ? "button" : undefined}
          tabIndex={bubble.community != null ? 0 : undefined}
          aria-label={
            bubble.community != null
              ? `Abrir comunidade ${bubble.name ?? bubble.community} — ${bubble.count} nós`
              : undefined
          }
          style={{ cursor: bubble.community != null ? "pointer" : "default", outlineOffset: 2 }}
          onClick={() => {
            if (bubble.community != null) onCommunity(bubble.community, bubble.name);
          }}
          onKeyDown={(event) => {
            if (bubble.community != null && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              onCommunity(bubble.community, bubble.name);
            }
          }}
        >
          <circle
            cx={bubble.cx}
            cy={bubble.cy}
            r={bubble.r}
            fill={communityColor(bubble.community)}
            fillOpacity={0.09}
            stroke={communityColor(bubble.community)}
            strokeOpacity={0.55}
            strokeWidth={1.5}
          />
          <text
            x={bubble.cx}
            y={bubble.cy - bubble.r - 5}
            textAnchor="middle"
            fontSize={11}
            fontWeight={700}
            fill="currentColor"
            style={{ pointerEvents: "none" }}
          >
            {(bubble.name ?? (bubble.community != null ? `comunidade ${bubble.community}` : "sem comunidade")) +
              ` · ${bubble.count}`}
          </text>
          <title>{`${bubble.name ?? "sem comunidade"} — ${bubble.count} nós projetados`}</title>
        </g>
      ))}
      {edges.map((edge, index) => {
        const from = positionById.get(edge.source);
        const to = positionById.get(edge.target);
        if (!from || !to) return null; // ponta filtrada (ruído documental) — aresta sai junto
        return (
          <line
            key={index}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="var(--border, #666)"
            strokeOpacity={0.5}
            strokeWidth={1}
          >
            <title>{`${edge.source} —${edge.relation}→ ${edge.target}`}</title>
          </line>
        );
      })}
      {layout.positions.map(({ node, x, y }) => {
        const radius = nodeRadius(node.degree);
        return (
          <g
            key={node.id}
            className="skeleton-node"
            transform={`translate(${x}, ${y})`}
            data-testid="skeleton-node"
            role="button"
            tabIndex={0}
            aria-label={`Focar no nó ${node.label} (grau ${node.degree})`}
            style={{ cursor: "pointer", outlineOffset: 2 }}
            onClick={(event) => {
              event.stopPropagation(); // não dispara o drill-down da bolha por baixo
              onFocus(node);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onFocus(node);
              }
            }}
          >
            {/* US-UX.2 — sem rótulo interno: o nome da comunidade já vive ACIMA
                da bolha e o rótulo do hub colidia com os pontos do aglomerado.
                Identidade do nó individual fica no tooltip/aria-label. */}
            <circle
              r={radius}
              fill={communityColor(node.community)}
              fillOpacity={0.9}
              stroke="var(--surface, transparent)"
              strokeWidth={1}
            />
            <title>{`${node.label} (${node.type}, grau ${node.degree})${node.sourceFile ? `\n${node.sourceFile}` : ""}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

function CommunityView({
  data,
  name,
  onFocus,
}: {
  data: GraphProjection;
  name: string | null;
  onFocus: (node: GraphProjectionNode) => void;
}) {
  const sorted = useMemo(
    () => [...data.nodes].sort((a, b) => b.degree - a.degree),
    [data.nodes],
  );
  const maxDegree = sorted[0]?.degree ?? 1;
  return (
    <section data-testid="community-view">
      <SectionTitle>
        Comunidade: {name ?? sorted[0]?.communityName ?? "—"} ({data.nodes.length} nós)
      </SectionTitle>
      {/* US-UX.2 — em tela cheia a lista esticada ficava ilegível: teto de largura. */}
      <div style={{ display: "grid", gap: 4, maxWidth: 960 }}>
        {sorted.map((node) => (
          <NodeRow key={node.id} node={node} maxDegree={maxDegree} onFocus={onFocus} />
        ))}
      </div>
    </section>
  );
}

function SearchView({
  data,
  term,
  onFocus,
}: {
  data: GraphProjection;
  term: string;
  onFocus: (node: GraphProjectionNode) => void;
}) {
  const maxDegree = Math.max(1, ...data.nodes.map((n) => n.degree));
  return (
    <section data-testid="search-view">
      <SectionTitle>
        Busca por “{term}” — {data.nodes.length} resultado(s) · clique para focar
      </SectionTitle>
      {data.nodes.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
          Nenhum nó corresponde à busca.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4, maxWidth: 960 }}>
          {data.nodes.map((node) => (
            <NodeRow key={node.id} node={node} maxDegree={maxDegree} onFocus={onFocus} />
          ))}
        </div>
      )}
    </section>
  );
}

const EGO_SIZE = 640;

function FocusView({
  projectId,
  data,
  depth,
  seedLabel,
  onFocus,
  onDepth,
}: {
  projectId: string | null;
  data: GraphProjection;
  depth: number;
  seedLabel: string;
  onFocus: (node: GraphProjectionNode) => void;
  onDepth: (depth: number) => void;
}) {
  const focusNode = data.nodes.find((n) => n.id === data.focus) ?? null;
  const positions = useMemo(
    () => (data.focus ? radialLayout(data.nodes, data.edges, data.focus, EGO_SIZE) : []),
    [data.nodes, data.edges, data.focus],
  );
  const positionById = useMemo(
    () => new Map(positions.map((p) => [p.node.id, p])),
    [positions],
  );
  const relations = useMemo(
    () => [...new Set(data.edges.map((e) => e.relation))].sort(),
    [data.edges],
  );
  const ringCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of positions) counts.set(p.ring, (counts.get(p.ring) ?? 0) + 1);
    return counts;
  }, [positions]);
  const maxRing = Math.max(0, ...positions.map((p) => p.ring));

  if (!data.focus || !focusNode) {
    return (
      <div style={{ color: "var(--text-muted)" }} data-testid="focus-unresolved">
        Não encontrei o nó “{seedLabel}” no grafo — tente a busca.
      </div>
    );
  }

  return (
    <section data-testid="focus-view" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <SectionTitle>Vizinhança de “{focusNode.label}”</SectionTitle>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>profundidade:</span>
        {[1, 2, 3].map((d) => (
          <button
            key={d}
            className={"kb-btn kb-btn-sm " + (d === depth ? "kb-btn-primary" : "kb-btn-ghost")}
            data-testid={`graph-depth-${d}`}
            onClick={() => onDepth(d)}
          >
            {d}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        <TypeBadge type={focusNode.type} />{" "}
        {focusNode.sourceFile ? <code>{focusNode.sourceFile}</code> : "(sem arquivo)"} · grau{" "}
        {focusNode.degree} ·{" "}
        {focusNode.communityName ??
          (focusNode.community != null ? `comunidade ${focusNode.community}` : "sem comunidade")}
      </div>

      {/* US-F4.3 — nó → arquivo → card: o grafo deixa de ser ilha. */}
      <FileCardsPanel projectId={projectId} sourceFile={focusNode.sourceFile} />

      <svg
        viewBox={`0 0 ${EGO_SIZE} ${EGO_SIZE}`}
        style={{
          width: "100%",
          maxHeight: "56vh",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--surface, transparent)",
        }}
        data-testid="ego-graph"
        role="img"
        aria-label={`Ego-grafo de ${focusNode.label}`}
      >
        {data.edges.map((edge, index) => {
          const from = positionById.get(edge.source);
          const to = positionById.get(edge.target);
          if (!from || !to) return null;
          return (
            <line
              key={index}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="var(--border, #666)"
              strokeOpacity={0.55}
              strokeWidth={1}
            >
              <title>{`${edge.source} —${edge.relation}→ ${edge.target}`}</title>
            </line>
          );
        })}
        {positions.map(({ node, x, y, ring }) => {
          const radius = nodeRadius(node.degree) + (ring === 0 ? 3 : 0);
          const label = node.label.length > 26 ? node.label.slice(0, 24) + "…" : node.label;
          // Labels do anel EXTERNO saem RADIAIS (estilo sunburst): cada label
          // ocupa a própria fatia angular — 70 vizinhos com label horizontal
          // colidiam todos no topo/fundo do círculo. Anéis internos mantêm o
          // label horizontal só quando o anel é pouco povoado (senão tooltip).
          const outermost = ring === maxRing && ring > 0;
          const angle = Math.atan2(y - EGO_SIZE / 2, x - EGO_SIZE / 2);
          const leftSide = Math.cos(angle) < 0;
          const rotation = (angle * 180) / Math.PI + (leftSide ? 180 : 0);
          const showInnerLabel = ring === 0 || (ringCounts.get(ring) ?? 0) <= 20;
          return (
            <g
              key={node.id}
              transform={`translate(${x}, ${y})`}
              style={{ cursor: "pointer" }}
              onClick={() => {
                if (node.id !== data.focus) onFocus(node);
              }}
              data-testid="ego-node"
            >
              <circle
                r={radius}
                fill={communityColor(node.community)}
                stroke={ring === 0 ? "var(--text, #fff)" : "transparent"}
                strokeWidth={ring === 0 ? 2 : 0}
                fillOpacity={0.9}
              />
              {outermost ? (
                <text
                  transform={`rotate(${rotation})`}
                  x={leftSide ? -(radius + 5) : radius + 5}
                  dy={3}
                  textAnchor={leftSide ? "end" : "start"}
                  fontSize={9}
                  fill="currentColor"
                  style={{ pointerEvents: "none" }}
                >
                  {label}
                </text>
              ) : showInnerLabel ? (
                <text
                  y={radius + 12}
                  textAnchor="middle"
                  fontSize={ring === 0 ? 12 : 10}
                  fontWeight={ring === 0 ? 700 : 400}
                  fill="currentColor"
                  style={{ pointerEvents: "none" }}
                >
                  {label}
                </text>
              ) : null}
              <title>{`${node.label} (${node.type}, grau ${node.degree})${node.sourceFile ? `\n${node.sourceFile}` : ""}`}</title>
            </g>
          );
        })}
      </svg>

      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {data.nodes.length - 1} vizinho(s) até profundidade {depth} · relações:{" "}
        {relations.join(", ") || "—"} · clique num nó para expandir a partir dele
      </div>
    </section>
  );
}

// ── US-F4.3 — painel "cards que tocaram este arquivo" (nó → arquivo → card) ──

/**
 * Liga o nó focado do grafo ao TRABALHO do board: os cards cujos fluxos
 * afetados (`AffectedFlow.files`, US-F2.7) ou handoffs de iteração
 * (`Iteration.handoffFiles`) citam o `sourceFile` do nó. Clicar num card
 * fecha o Explorer (navega para `/`) e abre o modal do card no board.
 *
 * Estados HONESTOS (a máquina vive em `fileCardsView`, testada offline):
 * nó sem arquivo, carregando, erro visível e — o mais comum — VAZIO explícito
 * (os campos são auto-declarados pela IA; um arquivo sem card é esperado e o
 * painel diz isso em vez de sumir).
 */
function FileCardsPanel({
  projectId,
  sourceFile,
}: {
  projectId: string | null;
  sourceFile: string | null;
}) {
  const navigate = useNavigate();
  const openEpic = useBoardUiStore((state) => state.openEpic);
  const openStory = useBoardUiStore((state) => state.openStory);
  const openTask = useBoardUiStore((state) => state.openTask);
  const query = useGraphFileCards(projectId, sourceFile);
  const view = fileCardsView(sourceFile, query);

  const openCard = (card: GraphFileCard) => {
    const target = fileCardTarget(card);
    if (target.modal === "epic") openEpic(target.id);
    else if (target.modal === "story") openStory(target.id);
    else {
      // Task: abre a story pai por baixo (o TaskModal empilha sobre ela).
      if (target.storyId) openStory(target.storyId);
      openTask(target.id);
    }
    navigate("/");
  };

  if (view.kind === "no-file") {
    return (
      <div data-testid="file-cards-nofile" style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Nó sem arquivo de origem — sem vínculo possível com o board.
      </div>
    );
  }

  return (
    <div
      data-testid="file-cards-panel"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700 }}>
        Cards que tocaram <code>{view.file}</code>
      </div>
      {view.kind === "loading" ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>procurando cards…</div>
      ) : view.kind === "error" ? (
        <div data-testid="file-cards-error" style={{ fontSize: 12 }}>
          <span className="chip chip-danger">falha ao buscar cards</span> {view.message}
        </div>
      ) : view.kind === "empty" ? (
        <div data-testid="file-cards-empty" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Nenhum card deste board registrou trabalho neste arquivo — os vínculos vêm dos
          fluxos afetados e dos handoffs das iterações, então só existem onde a frota
          (ou um humano) declarou o arquivo.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {view.cards.map((card) => (
            <button
              key={card.id}
              type="button"
              className="chip"
              data-testid="file-card-link"
              style={{ cursor: "pointer", display: "inline-flex", gap: 6, alignItems: "center" }}
              onClick={() => openCard(card)}
              title={
                `${card.key} · ${card.title}\nvia: ${card.via.join(", ")}` +
                (card.flowNames.length ? `\nfluxos: ${card.flowNames.join(", ")}` : "")
              }
            >
              <strong>{card.key}</strong>
              <span
                style={{
                  maxWidth: 220,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {card.title}
              </span>
              <span style={{ opacity: 0.6, fontSize: 10 }}>{card.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Primitivos ───────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{children}</div>
  );
}

function NodeRow({
  node,
  maxDegree,
  onFocus,
}: {
  node: GraphProjectionNode;
  maxDegree: number;
  onFocus: (node: GraphProjectionNode) => void;
}) {
  return (
    <button
      type="button"
      data-testid="graph-node-row"
      onClick={() => onFocus(node)}
      title={node.sourceFile ?? undefined}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(140px, 1.2fr) 70px 1fr",
        gap: 10,
        alignItems: "center",
        textAlign: "left",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "5px 10px",
        background: "var(--surface, transparent)",
        cursor: "pointer",
        color: "inherit",
        font: "inherit",
      }}
    >
      <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            flexShrink: 0,
            background: communityColor(node.community),
          }}
        />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
          {node.label}
        </span>
        <TypeBadge type={node.type} />
      </span>
      <span style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>grau {node.degree}</span>
        <span
          style={{
            height: 4,
            borderRadius: 2,
            background: "var(--code-bg, rgba(127,127,127,0.15))",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${Math.max(4, Math.round((node.degree / Math.max(1, maxDegree)) * 100))}%`,
              background: communityColor(node.community),
            }}
          />
        </span>
      </span>
      <code
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {node.sourceFile ?? ""}
      </code>
    </button>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="chip" style={{ fontSize: 10, padding: "0 6px", flexShrink: 0 }}>
      {type}
    </span>
  );
}
