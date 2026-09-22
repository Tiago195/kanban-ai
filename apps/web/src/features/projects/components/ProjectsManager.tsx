import { useState } from "react";

import type {
  Project,
  ProjectAuthKind,
  ProjectCloneState,
  ProjectKnowledgeSummary,
} from "@kanban-ai/shared";

import { showToast } from "@/shared/services/toastStore";

import {
  useProjects,
  useProjectsKnowledge,
  useSyncProject,
} from "../hooks/useProjectExplorer";
import { cloneStateBadge, knowledgeFacts } from "../lib/projectCard";
import {
  useCreateProject,
  useDeleteProject,
  useSetBoardProject,
} from "../hooks/useProjectOnboarding";

/**
 * EP-PROJECT / US-PROJ6 — onboarding de Projects: registrar um repo git por URL,
 * ver o estado do clone AO VIVO (badge dirigido pelo evento WS
 * `project.clone_state`), listar os Projects, associar o Project ao quadro
 * (`Board.projectId`) e explorar cada um.
 *
 * US-UX.1 — deixou de ser modal: agora é o PAINEL da área "Projetos" dentro
 * da moldura do Explorador (`/explorer/:projectId/projects`). O conteúdo é o
 * mesmo do antigo `/projects`; só a moldura mudou. "Explorar" um projeto da
 * lista SELECIONA o projeto na URL da área (o repo/memória/grafo/wiki passam
 * a ser dele).
 *
 * SÓ leitura/escrita via a superfície pública da feature — nada de importar
 * internals de outra feature.
 */
export function ProjectsPanel({
  boardId,
  boardProjectId,
  onOpenExplorer,
}: {
  boardId: string | null;
  boardProjectId: string | null;
  onOpenExplorer: (projectId: string) => void;
}) {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  // US-UX.4 — estado do conhecimento de TODOS os projetos numa requisição só
  // (`GET /projects/summary`) — alimenta a faixa de cada card.
  const knowledgeQuery = useProjectsKnowledge();
  const knowledge = knowledgeQuery.data ?? [];
  const [showForm, setShowForm] = useState(false);

  return (
    <div data-testid="projects-panel">
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
                summary={knowledge.find((k) => k.projectId === project.id)}
                boardId={boardId}
                isBoardProject={boardProjectId === project.id}
                onOpenExplorer={() => onOpenExplorer(project.id)}
              />
            ))}
          </div>
        )}
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

// ── Card de um projeto na lista (US-UX.4) ────────────────────────────────────

/**
 * US-UX.4 — cada projeto é um CARD com a faixa de estado do conhecimento
 * (clone · grafo · wiki · memória): um olhar responde "o que a AI tem sobre
 * este repo?". Estado é badge (nunca palavra solta), falha grita, e `Excluir`
 * saiu da linha principal — vive no rodapé, atrás de confirmação inline.
 */
function ProjectRow({
  project,
  summary,
  boardId,
  isBoardProject,
  onOpenExplorer,
}: {
  project: Project;
  summary: ProjectKnowledgeSummary | undefined;
  boardId: string | null;
  isBoardProject: boolean;
  onOpenExplorer: () => void;
}) {
  const sync = useSyncProject(project.id);
  const deleteProject = useDeleteProject();
  const setBoardProject = useSetBoardProject(boardId);
  // US-UX.4 — exclusão em dois passos: o botão discreto do rodapé só ARMA a
  // confirmação; o destrutivo de verdade fica no bloco de confirmação.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const facts = knowledgeFacts({
    cloneState: project.cloneState,
    graphState: project.graphState,
    summary,
  });
  const hasFailure = project.cloneState === "failed" || project.graphState === "failed";

  return (
    <div
      className={"project-card" + (hasFailure ? " project-card-failed" : "")}
      data-testid="project-row"
    >
      <div className="project-card-head">
        <div className="project-card-title">
          <strong>{project.name}</strong>
          <CloneStateBadge state={project.cloneState} />
          {isBoardProject ? <span className="chip chip-ok">quadro atual</span> : null}
        </div>
        <div className="project-card-actions">
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

      <code className="project-card-url">{project.repoUrl}</code>

      {project.cloneState === "failed" && project.lastError ? (
        <div className="project-card-error" data-testid="project-last-error" title={project.lastError}>
          ⚠️ clone falhou: {project.lastError}
        </div>
      ) : null}

      {/* US-UX.4 — a faixa de estado do conhecimento. */}
      <div className="project-card-facts" data-testid="project-knowledge">
        {facts.map((fact) => (
          <div
            key={fact.key}
            className={"pk-fact pk-" + fact.tone}
            data-testid={"project-fact-" + fact.key}
            title={fact.detail ?? undefined}
          >
            <span className="pk-fact-label">
              <span aria-hidden>{fact.icon}</span> {fact.label}
            </span>
            <span className="pk-fact-value">{fact.value}</span>
          </div>
        ))}
      </div>

      {/* Grafo falhou → a causa aparece por extenso (falha grita, não sussurra). */}
      {project.graphState === "failed" && project.graphLastError ? (
        <div className="project-card-error" data-testid="project-graph-error">
          ⚠️ grafo falhou: {project.graphLastError}
        </div>
      ) : null}

      <div className="project-card-foot">
        <span className="project-card-sync">
          {project.lastSyncedAt
            ? `última sincronização: ${new Date(project.lastSyncedAt).toLocaleString()}`
            : "nunca sincronizado"}
        </span>
        {confirmingDelete ? null : (
          <button
            className="project-delete-link"
            data-testid="project-delete"
            onClick={() => setConfirmingDelete(true)}
          >
            Excluir projeto…
          </button>
        )}
      </div>

      {/* US-UX.4 — confirmação de exclusão inline (ação destrutiva e
          irreversível nunca dispara em um clique). */}
      {confirmingDelete ? (
        <div className="project-delete-confirm" data-testid="project-delete-confirm">
          <div>
            Excluir o projeto <strong>{project.name}</strong>? Isso remove o clone gerenciado, o
            grafo e a wiki — <strong>irreversível</strong>.
          </div>
          <div className="project-delete-confirm-actions">
            <button
              className="kb-btn kb-btn-ghost kb-btn-sm"
              data-testid="project-delete-cancel"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancelar
            </button>
            <button
              className="kb-btn kb-btn-danger kb-btn-sm"
              data-testid="project-delete-confirm-btn"
              disabled={deleteProject.isPending}
              onClick={() =>
                deleteProject.mutate(project.id, {
                  onSuccess: () => showToast("Projeto excluído"),
                  onError: () => showToast("Falha ao excluir"),
                })
              }
            >
              {deleteProject.isPending ? "Excluindo…" : "Excluir definitivamente"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Badge de estado do clone (rótulos/tons puros em lib/projectCard.ts) ──────

function CloneStateBadge({ state }: { state: ProjectCloneState }) {
  const badge = cloneStateBadge(state);
  return (
    <span className={"chip chip-" + badge.tone} data-testid="clone-state-badge" data-state={state}>
      {badge.label}
    </span>
  );
}
