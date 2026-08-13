import { useState } from "react";

import type { Project, ProjectAuthKind, ProjectCloneState } from "@kanban-ai/shared";

import { showToast } from "@/shared/services/toastStore";

import { useProjects, useSyncProject } from "../hooks/useProjectExplorer";
import {
  useCreateProject,
  useDeleteProject,
  useSetBoardProject,
} from "../hooks/useProjectOnboarding";

/**
 * EP-PROJECT / US-PROJ6 — onboarding de Projects: registrar um repo git por URL,
 * ver o estado do clone AO VIVO (badge dirigido pelo evento WS
 * `project.clone_state`), listar os Projects, associar o Project ao quadro
 * (`Board.projectId`) e abrir o Project Explorer (US-PROJ7) de cada um.
 *
 * SÓ leitura/escrita via a superfície pública da feature — nada de importar
 * internals de outra feature.
 */
export function ProjectsManager({
  boardId,
  boardProjectId,
  onClose,
  onOpenExplorer,
}: {
  boardId: string | null;
  boardProjectId: string | null;
  onClose: () => void;
  onOpenExplorer: () => void;
}) {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const [showForm, setShowForm] = useState(false);

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
              <h2 style={{ margin: 0, fontSize: 16 }}>🗄️ Projetos (repositórios git)</h2>
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            <div className="modal-section" style={{ marginBottom: 12 }}>
              <div
                className="field-row"
                style={{ justifyContent: "space-between", alignItems: "center" }}
              >
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  Cole a URL de um repositório git (https ou ssh) — o kanban-ai clona e gerencia.
                </div>
                <button
                  className="kb-btn kb-btn-primary kb-btn-sm"
                  data-testid="open-create-project"
                  onClick={() => setShowForm((v) => !v)}
                >
                  {showForm ? "Cancelar" : "➕ Novo projeto"}
                </button>
              </div>
            </div>

            {showForm ? (
              <ProjectCreateForm
                existing={projects}
                onCreated={() => setShowForm(false)}
              />
            ) : null}

            <div className="modal-section">
              <div className="modal-section-title">Seus projetos</div>
              {projectsQuery.isLoading ? (
                <div style={{ color: "var(--text-muted)" }}>Carregando projetos…</div>
              ) : projects.length === 0 ? (
                <div
                  data-testid="projects-empty"
                  style={{
                    textAlign: "center",
                    padding: "24px 16px",
                    color: "var(--text-muted)",
                    border: "1px dashed var(--border)",
                    borderRadius: 8,
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Nenhum projeto ainda</div>
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    Clique em “Novo projeto” e cole a URL de um repositório git.
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gap: 8 }} data-testid="projects-list">
                  {projects.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      boardId={boardId}
                      isBoardProject={boardProjectId === project.id}
                      onOpenExplorer={onOpenExplorer}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Form "Novo projeto" ──────────────────────────────────────────────────────

const AUTH_LABEL: Record<ProjectAuthKind, string> = {
  none: "Público (sem autenticação)",
  https: "HTTPS com token",
  ssh: "Chave SSH",
};

/** Deriva um nome amigável a partir da URL do repo (o usuário pode editar). */
function deriveName(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  const tail = trimmed.split(/[/:]/).pop() ?? "";
  return tail;
}

const HTTPS_RE = /^https?:\/\/\S+$/i;
const SCP_SSH_RE = /^[^@\s]+@[^:\s]+:\S+$/i;
const SSH_URL_RE = /^ssh:\/\/\S+$/i;

function isValidRepoUrl(v: string): boolean {
  const t = v.trim();
  return HTTPS_RE.test(t) || SCP_SSH_RE.test(t) || SSH_URL_RE.test(t);
}

function ProjectCreateForm({
  existing,
  onCreated,
}: {
  existing: Project[];
  onCreated: () => void;
}) {
  const createProject = useCreateProject();
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [authKind, setAuthKind] = useState<ProjectAuthKind>("none");
  const [credentialRef, setCredentialRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  const effectiveName = nameTouched ? name : deriveName(repoUrl);

  const urlValid = repoUrl.trim().length === 0 || isValidRepoUrl(repoUrl);
  const needsCredential = authKind === "https";

  const submit = () => {
    setError(null);
    const url = repoUrl.trim();
    if (!url) return setError("Informe a URL do repositório.");
    if (!isValidRepoUrl(url)) return setError("URL inválida — use https ou ssh.");
    const finalName = (effectiveName || "").trim();
    if (!finalName) return setError("Informe um nome para o projeto.");
    if (existing.some((p) => p.repoUrl === url)) {
      return setError("Já existe um projeto com esta URL.");
    }
    if (needsCredential && credentialRef.trim().length === 0) {
      return setError(
        "Informe o NOME da variável de ambiente com a credencial (ex.: GH_TOKEN_ACME).",
      );
    }

    createProject.mutate(
      {
        name: finalName,
        repoUrl: url,
        authKind,
        credentialRef: needsCredential ? credentialRef.trim() : null,
      },
      {
        onSuccess: () => {
          showToast("Projeto criado — clonando…");
          setRepoUrl("");
          setName("");
          setNameTouched(false);
          setAuthKind("none");
          setCredentialRef("");
          onCreated();
        },
        onError: () => setError("Falha ao criar o projeto. Verifique a URL/credencial."),
      },
    );
  };

  return (
    <div className="modal-section" data-testid="project-create-form">
      <div className="modal-section-title">➕ Novo projeto</div>

      <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
        URL do repositório (https ou ssh)
      </label>
      <input
        className="card-title-input"
        data-testid="project-repo-url"
        value={repoUrl}
        placeholder="https://github.com/acme/repo.git  ou  git@github.com:acme/repo.git"
        onChange={(event) => setRepoUrl(event.target.value)}
        style={{ marginBottom: 4, borderColor: urlValid ? undefined : "var(--danger, #d33)" }}
      />
      {!urlValid ? (
        <div style={{ fontSize: 12, color: "var(--danger, #d33)", marginBottom: 8 }}>
          Formato inválido — aceito: https://… , git@host:owner/repo.git ou ssh://…
        </div>
      ) : (
        <div style={{ marginBottom: 8 }} />
      )}

      <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
        Nome (derivado da URL — editável)
      </label>
      <input
        className="card-title-input"
        data-testid="project-name"
        value={effectiveName}
        placeholder="nome-do-projeto"
        onChange={(event) => {
          setNameTouched(true);
          setName(event.target.value);
        }}
        style={{ marginBottom: 8 }}
      />

      <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
        Autenticação
      </label>
      <select
        className="card-desc-input"
        data-testid="project-auth-kind"
        value={authKind}
        onChange={(event) => {
          const kind = event.target.value as ProjectAuthKind;
          setAuthKind(kind);
          if (kind !== "https") setCredentialRef("");
        }}
        style={{ marginBottom: 8 }}
      >
        {(Object.keys(AUTH_LABEL) as ProjectAuthKind[]).map((kind) => (
          <option key={kind} value={kind}>
            {AUTH_LABEL[kind]}
          </option>
        ))}
      </select>

      {needsCredential ? (
        <>
          <label
            style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}
          >
            Nome da variável de ambiente da credencial
          </label>
          <input
            className="card-title-input"
            data-testid="project-credential-ref"
            value={credentialRef}
            placeholder="GH_TOKEN_ACME"
            onChange={(event) => setCredentialRef(event.target.value)}
            style={{ marginBottom: 4 }}
          />
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            ⚠️ Informe o <strong>NOME</strong> de uma variável de ambiente do servidor (ex.:{" "}
            <code>GH_TOKEN_ACME</code>) — <strong>nunca</strong> o token/segredo em si. O kanban-ai
            lê o valor do ambiente na hora do clone.
          </div>
        </>
      ) : null}

      {authKind === "ssh" ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
          🔑 O clone via <strong>SSH</strong> usa a chave montada no servidor (
          <code>~/.ssh</code>). <strong>Nenhuma</strong> variável de ambiente é necessária — a
          autenticação é feita pela chave privada do servidor.
        </div>
      ) : null}

      {error ? (
        <div
          data-testid="project-form-error"
          style={{ fontSize: 12, color: "var(--danger, #d33)", marginBottom: 8 }}
        >
          {error}
        </div>
      ) : null}

      <div className="field-row" style={{ justifyContent: "flex-end" }}>
        <button
          className="kb-btn kb-btn-primary"
          data-testid="project-create-submit"
          onClick={submit}
          disabled={createProject.isPending}
        >
          {createProject.isPending ? "Criando…" : "Criar & clonar"}
        </button>
      </div>
    </div>
  );
}

// ── Linha de um projeto na lista ─────────────────────────────────────────────

function ProjectRow({
  project,
  boardId,
  isBoardProject,
  onOpenExplorer,
}: {
  project: Project;
  boardId: string | null;
  isBoardProject: boolean;
  onOpenExplorer: () => void;
}) {
  const sync = useSyncProject(project.id);
  const deleteProject = useDeleteProject();
  const setBoardProject = useSetBoardProject(boardId);

  return (
    <div
      className="field-row"
      data-testid="project-row"
      style={{
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong>{project.name}</strong>
          <CloneStateBadge state={project.cloneState} />
          {isBoardProject ? <span className="chip chip-ok">quadro atual</span> : null}
        </div>
        <code
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            wordBreak: "break-all",
          }}
        >
          {project.repoUrl}
        </code>
        {project.cloneState === "failed" && project.lastError ? (
          <div
            data-testid="project-last-error"
            style={{ fontSize: 12, color: "var(--danger, #d33)" }}
            title={project.lastError}
          >
            ⚠️ {project.lastError}
          </div>
        ) : null}
        {project.lastSyncedAt ? (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            última sincronização: {new Date(project.lastSyncedAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            className="kb-btn kb-btn-ghost kb-btn-sm"
            data-testid="project-open-explorer"
            title="Ver repositório clonado e o que a AI aprendeu"
            onClick={onOpenExplorer}
          >
            🗂️ Explorar
          </button>
          <button
            className="kb-btn kb-btn-ghost kb-btn-sm"
            data-testid="project-sync"
            disabled={sync.isPending}
            onClick={() =>
              sync.mutate(undefined, {
                onSuccess: () => showToast("Sync disparado"),
                onError: () => showToast("Falha ao sincronizar"),
              })
            }
          >
            {sync.isPending ? "Sincronizando…" : "🔄 Sync"}
          </button>
          <button
            className="kb-btn kb-btn-danger kb-btn-sm"
            data-testid="project-delete"
            disabled={deleteProject.isPending}
            onClick={() => {
              if (!window.confirm(`Excluir o projeto "${project.name}"?`)) return;
              deleteProject.mutate(project.id, {
                onSuccess: () => showToast("Projeto excluído"),
                onError: () => showToast("Falha ao excluir"),
              });
            }}
          >
            Excluir
          </button>
        </div>
        {boardId ? (
          <button
            className={"kb-btn kb-btn-sm " + (isBoardProject ? "kb-btn-ghost" : "kb-btn-primary")}
            data-testid="project-associate-board"
            disabled={setBoardProject.isPending}
            title={
              isBoardProject
                ? "Desassociar este projeto do quadro atual"
                : "Associar este projeto ao quadro atual (Board.projectId)"
            }
            onClick={() =>
              setBoardProject.mutate(isBoardProject ? null : project.id, {
                onSuccess: () =>
                  showToast(isBoardProject ? "Projeto desassociado do quadro" : "Projeto associado ao quadro"),
                onError: () => showToast("Falha ao associar projeto ao quadro"),
              })
            }
          >
            {setBoardProject.isPending
              ? "Salvando…"
              : isBoardProject
                ? "✓ Associado — remover"
                : "🔗 Associar ao quadro"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── Badge de estado do clone (mesma semântica do ProjectExplorer) ────────────

const CLONE_STATE_LABEL: Record<ProjectCloneState, string> = {
  pending: "pendente",
  cloning: "clonando",
  ready: "pronto",
  failed: "falhou",
};

function CloneStateBadge({ state }: { state: ProjectCloneState }) {
  const tone =
    state === "ready" ? "chip-ok" : state === "failed" ? "chip-danger" : "chip-warn";
  return (
    <span className={"chip " + tone} data-testid="clone-state-badge" data-state={state}>
      {CLONE_STATE_LABEL[state]}
    </span>
  );
}
