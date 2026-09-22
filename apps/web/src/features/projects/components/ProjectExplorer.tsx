import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { ProjectCloneState } from "@kanban-ai/shared";

import { useBoard, usePrimaryBoardId } from "@/features/board";
import type { Theme } from "@/shared/hooks/useTheme";
import { showToast } from "@/shared/services/toastStore";

import {
  useProjectRepoInfo,
  useProjects,
  useSyncProject,
} from "../hooks/useProjectExplorer";
import { cloneStateBadge, modulesEmptyMessage } from "../lib/projectCard";
import {
  EXPLORER_AREAS,
  resolveExplorerRoute,
  switchAreaPath,
  switchProjectPath,
  type ExplorerArea,
} from "../lib/explorerShell";
import { ProjectGraphTab } from "./ProjectGraphTab";
import { ProjectMemoryTab } from "./ProjectMemoryTab";
import { ProjectWikiTab } from "./ProjectWikiTab";
import { ProjectsPanel } from "./ProjectsManager";

/**
 * US-UX.1 — A MOLDURA: o Explorador deixa de ser modal de ~600px flutuando
 * sobre o quadro e vira PÁGINA INTEIRA endereçável (`/explorer/:projectId/:area`),
 * com um rail vertical persistente para as 4 áreas da camada de conhecimento:
 * Projetos · O que a AI sabe · Grafo · Wiki.
 *
 * O CONTEÚDO de cada área é o mesmo de antes (redesenhá-las é US-UX.2–UX.5):
 * - "Projetos" absorve o antigo modal `/projects` (ProjectsPanel) E a antiga
 *   aba "Repositório" (metadados do clone + Sync do projeto selecionado);
 * - "O que a AI sabe", "Grafo" e "Wiki" são as abas de sempre (US-PROJ7,
 *   US-F4.2/F4.3, US-F5.4), agora com espaço para respirar.
 *
 * O projeto selecionado é CONTEXTO PERSISTENTE da área inteira: ele vive na
 * URL — trocar de área mantém o projeto, trocar de projeto mantém a área
 * (máquina pura em `../lib/explorerShell.ts`).
 */
export function ExplorerPage({
  theme,
  setTheme,
}: {
  // US-UX.1 — o controle de tema vem do App (o MESMO useTheme() do header do
  // quadro, via props): sem segunda instância de estado para dessincronizar.
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  const navigate = useNavigate();
  // US-UX.5 — `slug` é o artigo da Wiki aberto (deep link); só a área wiki usa.
  const params = useParams<{ projectId?: string; area?: string; slug?: string }>();

  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];

  // O projeto do quadro é o default sensato quando a URL não nomeia um.
  // Espera o board resolver antes de escolher o default — senão a corrida
  // entre as queries faria o redirect cair sempre no primeiro da lista.
  const { boardId, isLoading: boardIdLoading } = usePrimaryBoardId();
  const boardQuery = useBoard(boardId);
  const boardProjectId = boardQuery.data?.projectId ?? null;
  const boardSettled = !boardIdLoading && (!boardId || !boardQuery.isLoading);

  const route = resolveExplorerRoute({
    projectIdParam: params.projectId ?? null,
    areaParam: params.area ?? null,
    projectsLoaded: !projectsQuery.isLoading && boardSettled,
    projectIds: projects.map((p) => p.id),
    boardProjectId,
  });

  // URL incompleta/inválida → corrige (replace) para a forma canônica, de modo
  // que F5 e copiar/colar o link levem SEMPRE ao mesmo lugar.
  useEffect(() => {
    if (route.kind === "redirect") navigate(route.path, { replace: true });
  }, [route, navigate]);

  const area = route.area;
  const activeId = route.kind === "ready" || route.kind === "redirect" ? route.projectId : null;

  return (
    <div className="explorer-page" data-testid="explorer-page">
      <aside className="explorer-rail" aria-label="Áreas do explorador">
        {/* Voltar ao quadro — sempre visível, primeiro item do rail. */}
        <button
          type="button"
          className="explorer-rail-btn explorer-rail-back"
          data-testid="explorer-back-board"
          title="Voltar ao quadro"
          onClick={() => navigate("/")}
        >
          <span className="explorer-rail-icon" aria-hidden>
            ←
          </span>
          <span className="explorer-rail-label">Voltar ao quadro</span>
        </button>
        <nav className="explorer-rail-nav" aria-label="Áreas">
          {EXPLORER_AREAS.map((item) => (
            <button
              key={item}
              type="button"
              className="explorer-rail-btn"
              aria-current={item === area ? "page" : undefined}
              data-testid={`rail-${item}`}
              title={AREA_META[item].label}
              // Sem projeto (lista vazia) só a área Projetos é navegável.
              disabled={!activeId && item !== "projects"}
              onClick={() => {
                if (activeId) navigate(switchAreaPath({ projectId: activeId }, item));
              }}
            >
              <span className="explorer-rail-icon" aria-hidden>
                {AREA_META[item].icon}
              </span>
              <span className="explorer-rail-label">{AREA_META[item].label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="explorer-main">
        <header className="explorer-topbar">
          <h1 className="explorer-topbar-title">
            <span aria-hidden>{AREA_META[area].icon}</span> {AREA_META[area].label}
          </h1>
          <span className="explorer-topbar-hint">{AREA_META[area].hint}</span>
          {/* O seletor de projeto é o CABEÇALHO da área — governa todas as abas. */}
          {projects.length > 0 ? (
            <div className="explorer-topbar-project">
              <span className="chip" style={{ flexShrink: 0 }}>
                📁 Projeto
              </span>
              <select
                className="card-desc-input"
                data-testid="project-explorer-select"
                aria-label="Projeto selecionado"
                value={activeId ?? ""}
                onChange={(event) =>
                  navigate(switchProjectPath({ area }, event.target.value))
                }
                style={{ margin: 0 }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.repoUrl}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {/* US-UX.1 (auditoria) — o seletor de tema vivia no header do quadro,
              que não renderiza aqui; sem ele a camada inteira ficava sem troca
              de tema. Mesmo controle/acessibilidade do original. */}
          <select
            className="kb-btn kb-btn-ghost"
            title={"Tema: " + theme}
            aria-label="Selecionar tema"
            data-testid="explorer-theme-select"
            value={theme}
            onChange={(event) => setTheme(event.target.value as Theme)}
            style={projects.length > 0 ? { flexShrink: 0 } : { marginLeft: "auto" }}
          >
            <option value="light">🌞 Claro</option>
            <option value="dark">🌙 Escuro</option>
            <option value="high-contrast">◐ Alto contraste</option>
          </select>
        </header>

        <main className="explorer-content">
          <div className="explorer-content-inner">
            {route.kind === "loading" ? (
              <div style={{ color: "var(--text-muted)" }}>Carregando projetos…</div>
            ) : area === "projects" ? (
              <>
                {/* A antiga aba "Repositório" (US-PROJ7): metadados do clone
                    do projeto selecionado + "Sync agora". */}
                {activeId ? (
                  <section>
                    <div className="modal-section-title">📁 Repositório do projeto selecionado</div>
                    <RepoTab projectId={activeId} />
                  </section>
                ) : null}
                <ProjectsPanel
                  boardId={boardId}
                  boardProjectId={boardProjectId}
                  onOpenExplorer={(projectId) =>
                    navigate(switchProjectPath({ area }, projectId))
                  }
                />
              </>
            ) : !activeId ? (
              <EmptyState
                title="Nenhum projeto ainda"
                hint="Crie um projeto na área Projetos para explorar aqui."
              />
            ) : area === "graph" ? (
              <ProjectGraphTab projectId={activeId} />
            ) : area === "wiki" ? (
              /* key: trocar de Project zera o artigo aberto (slug é por-wiki). */
              <ProjectWikiTab
                key={activeId}
                projectId={activeId}
                articleSlug={params.slug ?? null}
              />
            ) : (
              /* US-UX.3 — o painel da memória (redesenho da MemoryTab). */
              <ProjectMemoryTab projectId={activeId} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/** US-UX.1 — identidade visual de cada área do rail (ícone + rótulo + lema). */
const AREA_META: Record<ExplorerArea, { icon: string; label: string; hint: string }> = {
  projects: {
    icon: "🗄️",
    label: "Projetos",
    hint: "repositórios git clonados e gerenciados",
  },
  memory: {
    icon: "🐝",
    label: "O que a AI sabe",
    hint: "os neurônios que a frota aprendeu",
  },
  graph: {
    icon: "🕸️",
    label: "Grafo",
    hint: "o grafo de conhecimento do código",
  },
  wiki: {
    icon: "📖",
    label: "Wiki",
    hint: "a base de conhecimento derivada do grafo",
  },
};

// ── Aba Repositório ──────────────────────────────────────────────────────────

function RepoTab({ projectId }: { projectId: string | null }) {
  const repoQuery = useProjectRepoInfo(projectId);
  const sync = useSyncProject(projectId);
  const info = repoQuery.data;

  return (
    <div data-testid="repo-tab">
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button
          className="kb-btn kb-btn-primary kb-btn-sm"
          disabled={!projectId || sync.isPending}
          data-testid="sync-now"
          onClick={() =>
            sync.mutate(undefined, {
              onSuccess: () => showToast("Sync disparado"),
              onError: () => showToast("Falha ao sincronizar"),
            })
          }
        >
          {sync.isPending ? "Sincronizando…" : "🔄 Sync agora"}
        </button>
      </div>

      {repoQuery.isLoading ? (
        <div style={{ color: "var(--text-muted)" }}>Carregando repositório…</div>
      ) : !info ? (
        <EmptyState title="Sem informações do repositório" hint="Tente sincronizar." />
      ) : (
        <div className="modal-section" style={{ display: "grid", gap: 10 }}>
          <MetaRow label="Estado do clone">
            <CloneStateBadge state={info.cloneState} />
          </MetaRow>
          <MetaRow label="Branch default">
            <code>{info.defaultBranch ?? "—"}</code>
          </MetaRow>
          <MetaRow label="HEAD">
            <code>{info.headCommit ? info.headCommit.slice(0, 12) : "—"}</code>
          </MetaRow>
          <MetaRow label="Última sincronização">
            <span>{info.lastSyncedAt ? new Date(info.lastSyncedAt).toLocaleString() : "nunca"}</span>
          </MetaRow>
          <MetaRow label="Módulos detectados">
            {info.modules.length === 0 ? (
              /* US-UX.4 (BUG-UI2) — zero módulos com clone pronto é resultado
                 legítimo; só sugerimos problema de clone quando o clone de
                 fato não está `ready` (a mensagem antiga contradizia o HEAD
                 exibido logo acima). */
              <span style={{ color: "var(--text-muted)" }} data-testid="modules-empty">
                {modulesEmptyMessage(info.cloneState)}
              </span>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {info.modules.map((m) => (
                  <span key={m} className="chip">
                    {m}
                  </span>
                ))}
              </div>
            )}
          </MetaRow>
        </div>
      )}
    </div>
  );
}

// US-UX.3 — a antiga MemoryTab (lista plana + drawer) virou o painel da
// memória em `./ProjectMemoryTab.tsx` (busca e leitura de neurônio preservadas).

// ── Primitivos visuais leves (usam classes/vars já existentes no app) ────────

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <span style={{ minWidth: 160, color: "var(--text-muted)", fontSize: 13 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div
      data-testid="empty-state"
      style={{
        textAlign: "center",
        padding: "32px 16px",
        color: "var(--text-muted)",
        border: "1px dashed var(--border)",
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {hint ? <div style={{ fontSize: 12, marginTop: 6 }}>{hint}</div> : null}
    </div>
  );
}

// US-UX.4 — rótulo/tom do badge vêm do helper puro compartilhado do card.
function CloneStateBadge({ state }: { state: ProjectCloneState }) {
  const badge = cloneStateBadge(state);
  return <span className={"chip chip-" + badge.tone}>{badge.label}</span>;
}
