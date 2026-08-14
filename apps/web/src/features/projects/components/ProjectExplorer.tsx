import { useMemo, useState } from "react";

import type {
  MemoryLockState,
  MemoryNeuronSummary,
  ProjectCloneState,
} from "@kanban-ai/shared";

import { showToast } from "@/shared/services/toastStore";

import {
  useProjectMemory,
  useProjectNeuron,
  useProjectRepoInfo,
  useProjects,
  useSyncProject,
} from "../hooks/useProjectExplorer";

type Tab = "repo" | "memory";

/**
 * US-PROJ7 — Project Explorer + Memory Viewer (SÓ leitura). A "tela de valor" do
 * EP-PROJECT: o usuário vê o repositório clonado (aba "Repositório") e navega
 * pelo que a AI já aprendeu (aba "O que a AI sabe" — os neurônios da colmeia).
 *
 * NÃO edita neurônios (escrita é do domínio do agent/loop). A lista de memória
 * NÃO edita neurônios (escrita é do domínio do agent/loop).
 *
 * **Dois escopos, não um.** O Explorador combina conteúdo de escopos diferentes,
 * então cada aba mostra SÓ o controle que de fato governa seu conteúdo (evita o
 * anti-padrão de "fake filter" — um seletor que não filtra nada):
 *  - Aba "Repositório": conteúdo é POR-PROJETO → mostra o seletor de projeto.
 *  - Aba "O que a AI sabe": a memória é a COLMEIA compartilhada por toda a frota
 *    (não muda com o projeto) → o seletor some e dá lugar a um cabeçalho de
 *    escopo "Colmeia". Vira por-Project quando US-PROJ4 namespacear o índice por
 *    `projectId`; aí o seletor volta a fazer sentido nesta aba.
 */
export function ProjectExplorer({ onClose }: { onClose: () => void }) {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Seleciona o primeiro Project assim que a lista chega (sem efeito: derivado).
  const activeId = selectedId ?? projects[0]?.id ?? null;
  const [tab, setTab] = useState<Tab>("repo");

  return (
    <div
      className="modal-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
        <div className="kb-modal">
          <div className="modal-header">
            <div className="modal-title-row">
              <h2 style={{ margin: 0, fontSize: 16 }}>🗂️ Explorador</h2>
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            {projectsQuery.isLoading ? (
              <div style={{ color: "var(--text-muted)" }}>Carregando projetos…</div>
            ) : projects.length === 0 ? (
              <EmptyState
                title="Nenhum projeto ainda"
                hint="Associe um repositório git a um quadro para clonar e explorar aqui."
              />
            ) : (
              <>
                <div className="kb-tabs" role="tablist" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button
                    role="tab"
                    aria-selected={tab === "repo"}
                    data-testid="tab-repo"
                    className={"kb-btn " + (tab === "repo" ? "kb-btn-primary" : "kb-btn-ghost")}
                    onClick={() => setTab("repo")}
                  >
                    📁 Repositório
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "memory"}
                    data-testid="tab-memory"
                    className={"kb-btn " + (tab === "memory" ? "kb-btn-primary" : "kb-btn-ghost")}
                    onClick={() => setTab("memory")}
                  >
                    🐝 O que a AI sabe
                  </button>
                </div>

                {/* Cada aba mostra só o controle de escopo que governa seu conteúdo. */}
                {tab === "repo" ? (
                  <>
                    <ProjectScopePicker
                      projects={projects}
                      activeId={activeId}
                      onChange={setSelectedId}
                    />
                    <RepoTab projectId={activeId} />
                  </>
                ) : (
                  <>
                    <HiveScopeHeader />
                    <MemoryTab projectId={activeId} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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
              <span style={{ color: "var(--text-muted)" }}>nenhum (repo ainda não clonado?)</span>
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

// ── Aba "O que a AI sabe" (memória) ─────────────────────────────────────────

function MemoryTab({ projectId }: { projectId: string | null }) {
  const memoryQuery = useProjectMemory(projectId);
  const neurons = memoryQuery.data ?? [];
  const [search, setSearch] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return neurons;
    return neurons.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.path.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [neurons, search]);

  return (
    <div data-testid="memory-tab">
      {memoryQuery.isLoading ? (
        <div style={{ color: "var(--text-muted)" }}>Carregando memória…</div>
      ) : neurons.length === 0 ? (
        <EmptyState
          title="A AI ainda não aprendeu nada"
          hint="Quando os agents rodarem, os neurônios que eles aprenderem aparecem aqui."
        />
      ) : (
        <>
          <input
            className="card-desc-input"
            placeholder="Buscar por título, tag ou path…"
            data-testid="memory-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ marginBottom: 12 }}
          />
          {filtered.length === 0 ? (
            <EmptyState title="Nenhum neurônio corresponde à busca" hint="Ajuste o termo." />
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {filtered.map((n) => (
                <NeuronCard key={n.path} neuron={n} onOpen={() => setOpenPath(n.path)} />
              ))}
            </div>
          )}
        </>
      )}

      {openPath ? (
        <NeuronDrawer
          projectId={projectId}
          path={openPath}
          onClose={() => setOpenPath(null)}
        />
      ) : null}
    </div>
  );
}

function NeuronCard({
  neuron,
  onOpen,
}: {
  neuron: MemoryNeuronSummary;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="neuron-card"
      data-testid="neuron-card"
      onClick={onOpen}
      style={{
        textAlign: "left",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        background: "var(--surface, transparent)",
        cursor: "pointer",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong>{neuron.title || neuron.path}</strong>
        <LockStateBadge state={neuron.lockState} />
        {neuron.stale ? <span className="chip chip-warn">stale</span> : null}
        {neuron.archivedAt ? <span className="chip">arquivado</span> : null}
      </div>
      <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{neuron.path}</code>
      {neuron.summary ? <div style={{ fontSize: 13 }}>{neuron.summary}</div> : null}
      {neuron.tags.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {neuron.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

function NeuronDrawer({
  projectId,
  path,
  onClose,
}: {
  projectId: string | null;
  path: string;
  onClose: () => void;
}) {
  const detailQuery = useProjectNeuron(projectId, path);
  const detail = detailQuery.data;

  return (
    <div
      className="modal-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-panel" onClick={(event) => event.stopPropagation()} data-testid="neuron-drawer">
        <div className="kb-modal">
          <div className="modal-header">
            <div className="modal-title-row">
              <h2 style={{ margin: 0, fontSize: 15 }}>🧠 {detail?.title || path}</h2>
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            {detailQuery.isLoading ? (
              <div style={{ color: "var(--text-muted)" }}>Carregando neurônio…</div>
            ) : !detail ? (
              <EmptyState title="Neurônio indisponível" hint="Ele pode ter sido arquivado." />
            ) : (
              <>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                  <code>{detail.path}</code> · HEAD{" "}
                  <code>{detail.headCommit ? detail.headCommit.slice(0, 12) : "—"}</code>
                </div>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: 12,
                    background: "var(--code-bg, rgba(127,127,127,0.08))",
                    padding: 12,
                    borderRadius: 8,
                    maxHeight: "60vh",
                    overflow: "auto",
                  }}
                >
                  {detail.content ?? "(neurônio vazio)"}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Primitivos visuais leves (usam classes/vars já existentes no app) ────────

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <span style={{ minWidth: 160, color: "var(--text-muted)", fontSize: 13 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

// ── Cabeçalhos de escopo (deixam claro POR ESTRUTURA o que governa cada aba) ──

/**
 * Seletor de projeto — só aparece na aba "Repositório", onde de fato filtra o
 * conteúdo. Fica ao lado de um rótulo de escopo "Projeto" para simetria com o
 * cabeçalho da colmeia.
 */
function ProjectScopePicker({
  projects,
  activeId,
  onChange,
}: {
  projects: { id: string; name: string; repoUrl: string }[];
  activeId: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div
      className="scope-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        marginBottom: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface, transparent)",
      }}
    >
      <span
        className="chip"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
      >
        📁 Projeto
      </span>
      <select
        className="card-desc-input"
        data-testid="project-explorer-select"
        value={activeId ?? ""}
        onChange={(event) => onChange(event.target.value)}
        style={{ flex: 1, margin: 0 }}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {p.repoUrl}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Cabeçalho da aba de memória. A colmeia é um escopo ÚNICO (toda a frota), então
 * NÃO há seletor de projeto aqui — o próprio cabeçalho comunica o escopo. Isso
 * evita o "fake filter" (um seletor que não muda o conteúdo) que confundia o
 * usuário ao trocar de projeto e ver o mesmo conhecimento.
 */
function HiveScopeHeader() {
  return (
    <div
      className="scope-bar"
      data-testid="hive-scope-header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        marginBottom: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface, transparent)",
      }}
    >
      <span
        className="chip"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
      >
        🐝 Colmeia
      </span>
      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
        Memória compartilhada por toda a frota de agents — não é específica de um projeto.
      </span>
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

const CLONE_STATE_LABEL: Record<ProjectCloneState, string> = {
  pending: "pendente",
  cloning: "clonando",
  ready: "pronto",
  failed: "falhou",
};

function CloneStateBadge({ state }: { state: ProjectCloneState }) {
  const tone =
    state === "ready" ? "chip-ok" : state === "failed" ? "chip-danger" : "chip-warn";
  return <span className={"chip " + tone}>{CLONE_STATE_LABEL[state]}</span>;
}

const LOCK_STATE_LABEL: Record<MemoryLockState, string> = {
  FREE: "livre",
  EDITING: "editando",
  REVIEW: "em review",
};

function LockStateBadge({ state }: { state: MemoryLockState }) {
  const tone = state === "FREE" ? "chip-ok" : state === "REVIEW" ? "chip-warn" : "chip";
  return <span className={"chip " + tone}>{LOCK_STATE_LABEL[state]}</span>;
}
