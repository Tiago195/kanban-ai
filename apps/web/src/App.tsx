import { useEffect, useMemo, useRef, useState } from "react";
import { Routes, Route, useNavigate, useParams } from "react-router-dom";

import type { IterationPhase } from "@kanban-ai/shared";

import {
  BoardView,
  useBoard,
  useBoardUiStore,
  useCards,
  useCreateAssignee,
  useCreateLoopProfile,
  useDeleteAssignee,
  useDeleteLoopProfile,
  useModels,
  usePrimaryBoardId,
  useSetBoardModel,
  useUpdateLabel,
  useUpdateLoopProfile,
} from "@/features/board";
import { useRealtime } from "@/features/realtime";
import { useReviewNotifications } from "@/features/realtime/hooks/useReviewNotifications";
import { BacklogChatView } from "@/features/backlog-chat";
import { ProjectExplorer, ProjectsManager } from "@/features/projects";
import { Toast } from "@/shared/components/Toast";
import { getHealth } from "@/shared/services/apiClient";
import { showToast } from "@/shared/services/toastStore";
import type { ApiLoopProfile } from "@/shared/types";
import { useTheme } from "@/shared/hooks/useTheme";

export default function App() {
  const [health, setHealth] = useState<string>("carregando…");
  const { theme, setTheme } = useTheme();
  const { boardId } = usePrimaryBoardId();
  const { data: board } = useBoard(boardId);
  const { data: cards } = useCards(boardId);
  const { status, lastEvent } = useRealtime(undefined, boardId);
  const { prefEnabled, setNotificationsEnabled } = useReviewNotifications(lastEvent);

  const filters = useBoardUiStore((state) => state.filters);
  const setFilters = useBoardUiStore((state) => state.setFilters);

  const navigate = useNavigate();

  useEffect(() => {
    getHealth()
      .then((res) => setHealth(res.status ?? JSON.stringify(res)))
      .catch((err: unknown) => setHealth("indisponível (" + String(err) + ")"));
  }, []);

  const handleExport = () => {
    const payload = {
      board: board ?? null,
      cards: cards ?? [],
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kanban-ai-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("Board exportado");
  };

  const metrics = useMemo(() => {
    const list = cards ?? [];
    const doneColumnIds = new Set(
      (board?.columns ?? [])
        .filter((column) => !column.isTaskColumn && column.title === "Done")
        .map((column) => column.id),
    );
    let donePts = 0;
    let totalPts = 0;
    for (const card of list) {
      if (card.points != null && (card.type === "story" || card.type === "epic")) {
        totalPts += card.points;
        if (card.boardColumnId && doneColumnIds.has(card.boardColumnId)) donePts += card.points;
      }
    }
    return {
      epics: list.filter((card) => card.type === "epic").length,
      stories: list.filter((card) => card.type === "story").length,
      tasks: list.filter((card) => card.type === "task").length,
      blocked: list.filter((card) => card.blocked).length,
      donePts,
      totalPts,
      progress: totalPts > 0 ? Math.round((donePts / totalPts) * 100) : 0,
    };
  }, [cards, board?.columns]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title" title={"WS: " + status}>
          Sprint Board
        </h1>
        <div className="header-actions">
          <input
            className="search-input"
            type="search"
            placeholder="Buscar cards…"
            aria-label="Buscar cards"
            value={filters.q}
            onChange={(event) => setFilters({ q: event.target.value })}
          />
          {/* <select
            className="filter-select"
            aria-label="Filtrar por tipo"
            value={filters.type}
            onChange={(event) => setFilters({ type: event.target.value as typeof filters.type })}
          >
            <option value="">Histórias e Tasks</option>
            <option value="story">Só Histórias</option>
            <option value="task">Só Tasks</option>
          </select> */}
          <select
            className="filter-select"
            aria-label="Filtrar por label"
            value={filters.label}
            onChange={(event) => setFilters({ label: event.target.value })}
          >
            <option value="">Todas as labels</option>
            {(board?.labels ?? []).map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>
          <select
            className="filter-select"
            aria-label="Filtrar por agente"
            value={filters.assignee}
            onChange={(event) => setFilters({ assignee: event.target.value })}
          >
            <option value="">Todos os agentes</option>
            {(board?.assignees ?? []).map((assignee) => (
              <option key={assignee.id} value={assignee.id}>
                {assignee.name}
              </option>
            ))}
          </select>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Criar épicos e histórias conversando com a IA"
            data-testid="open-backlog-chat"
            onClick={() => navigate("/backlog-chat")}
          >
            ✨ Criar backlog
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Gerenciar agentes responsáveis"
            onClick={() => navigate("/agents")}
          >
            🤖 Agentes
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Registrar um repositório git como Projeto e associá-lo ao quadro"
            data-testid="open-projects"
            onClick={() => navigate("/projects")}
          >
            🗄️ Projetos
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Ver o repositório clonado e o que a AI já aprendeu"
            data-testid="open-project-explorer"
            onClick={() => navigate("/explorer")}
          >
            🗂️ Explorador
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Gerenciar perfis de loop das AIs"
            onClick={() => navigate("/loops")}
          >
            🔁 Loops
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Ativar/desativar notificações de review"
            onClick={async () => {
              await setNotificationsEnabled(!prefEnabled);
            }}
          >
            {prefEnabled ? "🔔 Review ON" : "🔕 Review OFF"}
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Gerenciar colunas requer suporte no backend (ainda indisponível)"
            onClick={() => showToast("Gestão de colunas ainda não disponível no backend")}
          >
            + Coluna
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Exportar JSON"
            onClick={handleExport}
          >
            ⤓ Export
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Importar requer suporte no backend (ainda indisponível)"
            onClick={() => showToast("Importação ainda não disponível no backend")}
          >
            ⤒ Import
          </button>
          <select
            className="kb-btn kb-btn-ghost"
            title={"Tema: " + theme + " — API: " + health}
            aria-label="Selecionar tema"
            value={theme}
            onChange={(event) => setTheme(event.target.value as "light" | "dark" | "high-contrast")}
          >
            <option value="light">🌞 Claro</option>
            <option value="dark">🌙 Escuro</option>
            <option value="high-contrast">◐ Alto contraste</option>
          </select>
        </div>
      </header>

      <div className="metrics-bar">
        <div className="metric">
          <span>Épicos</span>
          <b>{metrics.epics}</b>
        </div>
        <div className="metric">
          <span>Histórias</span>
          <b>{metrics.stories}</b>
        </div>
        <div className="metric">
          <span>Tasks</span>
          <b>{metrics.tasks}</b>
        </div>
        <div className="metric">
          <span>Pontos concluídos</span>
          <b>{metrics.donePts}</b>
          <span>/</span>
          <b>{metrics.totalPts}</b>
        </div>
        <div className="metric-progress" title="Progresso da sprint (story points)">
          <span style={{ width: metrics.progress + "%" }} />
        </div>
        <div className="metric">
          <span>Bloqueados</span>
          <b>{metrics.blocked}</b>
        </div>
      </div>

      <BoardView />

      <Toast />

      <Routes>
        <Route
          path="/agents"
          element={<AgentsModal boardId={boardId} onClose={() => navigate("/")} />}
        />
        <Route
          path="/loops"
          element={<LoopsModal boardId={boardId} onClose={() => navigate("/")} />}
        />
        <Route path="/explorer" element={<ProjectExplorer onClose={() => navigate("/")} />} />
        <Route
          path="/projects"
          element={
            <ProjectsManager
              boardId={boardId}
              boardProjectId={board?.projectId ?? null}
              onClose={() => navigate("/")}
              onOpenExplorer={() => navigate("/explorer")}
            />
          }
        />
        <Route path="/backlog-chat" element={<BacklogChatRoute boardId={boardId} />} />
        <Route path="/backlog-chat/:sessionId" element={<BacklogChatRoute boardId={boardId} />} />
      </Routes>
    </div>
  );
}

/**
 * Ponte entre a rota e o `BacklogChatView`. Lê o `:sessionId` da URL (F5-safe:
 * o histórico é reidratado do backend) e navega para a URL com id assim que a
 * sessão é criada, de modo que o reload reabra a MESMA conversa.
 */
function BacklogChatRoute({ boardId }: { boardId: string | null }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  return (
    <BacklogChatView
      boardId={boardId}
      routeSessionId={sessionId ?? null}
      onSessionCreated={(id) => navigate(`/backlog-chat/${id}`, { replace: true })}
      onSelectSession={(id) => navigate(`/backlog-chat/${id}`)}
      onNewSession={() => navigate("/backlog-chat")}
      onClose={() => navigate("/")}
    />
  );
}

function AgentsModal({ boardId, onClose }: { boardId: string | null; onClose: () => void }) {
  const { data: board } = useBoard(boardId);
  const createAssignee = useCreateAssignee(boardId);
  const deleteAssignee = useDeleteAssignee(boardId);
  const modelsQuery = useModels();
  const setBoardModel = useSetBoardModel(boardId);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  const [instructions, setInstructions] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || createAssignee.isPending) return;
    createAssignee.mutate(
      {
        name: trimmed,
        model: modelId || undefined,
        instructions: instructions.trim() || undefined,
      },
      {
        onSuccess: () => {
          setName("");
          setModelId("");
          setInstructions("");
          showToast("Agente criado");
        },
        onError: () => showToast("Falha ao criar agente"),
      },
    );
  };

  const assignees = board?.assignees ?? [];
  const models = modelsQuery.data?.models ?? [];
  const cliDefault = modelsQuery.data?.default ?? null;
  const boardDefault = board?.defaultModel ?? null;
  const effectiveDefault = boardDefault ?? cliDefault;
  const labelFor = (id: string | null): string => {
    if (!id) return "—";
    return models.find((m) => m.id === id)?.label ?? id;
  };

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
              <h2 style={{ margin: 0, fontSize: 16 }}>🤖 Agentes responsáveis</h2>
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            <div className="modal-section">
              <div className="modal-section-title">🧠 Modelo de AI do quadro (default)</div>
              <select
                className="card-desc-input"
                value={boardDefault ?? ""}
                disabled={setBoardModel.isPending || modelsQuery.isLoading}
                onChange={(event) => {
                  const value = event.target.value === "" ? null : event.target.value;
                  setBoardModel.mutate(value, {
                    onSuccess: () => showToast("Modelo default do quadro atualizado"),
                    onError: () => showToast("Falha ao atualizar modelo default"),
                  });
                }}
              >
                <option value="">Usar default do login ({labelFor(cliDefault)})</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                Default efetivo: <strong>{labelFor(effectiveDefault)}</strong>. Épicos, histórias e
                tasks herdam este modelo quando não definem o seu. {models.length} modelo(s)
                disponíveis para o login.
              </div>
            </div>
            <div className="modal-section">
              {assignees.length === 0 ? (
                <div style={{ color: "var(--text-muted)" }}>Nenhum agente ainda.</div>
              ) : (
                assignees.map((assignee) => (
                  <div
                    key={assignee.id}
                    className="field-row"
                    style={{ justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span>🤖 {assignee.name}</span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        🧠 {labelFor(assignee.model) === "—" ? "Default do quadro" : labelFor(assignee.model)}
                      </span>
                      {assignee.instructions ? (
                        <span
                          style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}
                          title={assignee.instructions}
                        >
                          📝 {assignee.instructions.length > 80
                            ? `${assignee.instructions.slice(0, 80)}…`
                            : assignee.instructions}
                        </span>
                      ) : null}
                    </div>
                    <button
                      className="kb-btn kb-btn-danger kb-btn-sm"
                      onClick={() => {
                        if (!window.confirm(`Excluir "${assignee.name}"?`)) return;
                        deleteAssignee.mutate(assignee.id, {
                          onSuccess: () => showToast("Agente excluído"),
                          onError: () => showToast("Falha ao excluir agente"),
                        });
                      }}
                    >
                      Excluir
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="modal-section">
              <div className="modal-section-title">➕ Novo agente</div>
              <div className="field-row" style={{ gap: 8, marginBottom: 8 }}>
                <input
                  ref={inputRef}
                  className="card-title-input"
                  value={name}
                  placeholder="Nome do novo agente…"
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
              </div>
              <select
                className="card-desc-input"
                value={modelId}
                disabled={modelsQuery.isLoading}
                style={{ marginBottom: 8 }}
                onChange={(event) => setModelId(event.target.value)}
              >
                <option value="">Usar default do quadro ({labelFor(effectiveDefault)})</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <textarea
                className="card-desc-input"
                value={instructions}
                placeholder="Instruções do agente (AGENTS.md): como ele deve agir, foco, regras…"
                rows={4}
                style={{ marginBottom: 8, resize: "vertical", fontFamily: "inherit" }}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <div className="field-row" style={{ justifyContent: "flex-end" }}>
                <button
                  className="kb-btn kb-btn-primary"
                  onClick={submit}
                  disabled={name.trim().length === 0 || createAssignee.isPending}
                >
                  {createAssignee.isPending ? "Criando…" : "+ Agente"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoopProfileRow({
  boardId,
  profile,
}: {
  boardId: string | null;
  profile: ApiLoopProfile;
}) {
  const updateProfile = useUpdateLoopProfile(boardId);
  const deleteProfile = useDeleteLoopProfile(boardId);

  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [phases, setPhases] = useState((profile.phases ?? []).join(", "));

  useEffect(() => {
    setName(profile.name);
    setDescription(profile.description);
    setPhases((profile.phases ?? []).join(", "));
  }, [profile.name, profile.description, profile.phases]);

  const commitPhases = () => {
    const arr = phases
      .split(",")
      .map((s) => s.trim())
      .filter((s) =>
        ["reproduce", "analysis", "implementation", "validation"].includes(s),
      ) as IterationPhase[];
    if (!arr.length) {
      setPhases((profile.phases ?? []).join(", "));
      return;
    }
    updateProfile.mutate({ id: profile.id, dto: { phases: arr } });
  };

  const handleDelete = () => {
    if (!window.confirm(`Excluir perfil "${profile.name}"?`)) return;
    deleteProfile.mutate(profile.id, {
      onSuccess: () => showToast("Perfil de loop excluído"),
    });
  };

  return (
    <div className="flow-item" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="flow-top" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="flow-name"
          value={name}
          disabled={profile.builtin}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (!profile.builtin && name.trim() && name.trim() !== profile.name) {
              updateProfile.mutate({ id: profile.id, dto: { name: name.trim() } });
            }
          }}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {profile.builtin ? "(embutido)" : "(custom)"}
        </span>
        {!profile.builtin ? (
          <button className="kb-btn kb-btn-ghost kb-btn-sm" onClick={handleDelete} aria-label="Excluir perfil">
            🗑
          </button>
        ) : null}
      </div>
      <input
        className="flow-files"
        value={description}
        placeholder="descrição"
        onChange={(event) => setDescription(event.target.value)}
        onBlur={() => {
          if (description !== profile.description) {
            updateProfile.mutate({ id: profile.id, dto: { description } });
          }
        }}
      />
      <input
        className="flow-files"
        value={phases}
        placeholder="fases: analysis, implementation, validation"
        onChange={(event) => setPhases(event.target.value)}
        onBlur={commitPhases}
      />
    </div>
  );
}

function LoopsModal({ boardId, onClose }: { boardId: string | null; onClose: () => void }) {
  const { data: board } = useBoard(boardId);
  const profiles = board?.loopProfiles ?? [];
  const labels = board?.labels ?? [];
  const customProfiles = profiles.filter((profile) => profile.profileId !== "__default");

  const createProfile = useCreateLoopProfile(boardId);
  const updateLabel = useUpdateLabel(boardId);
  const [newName, setNewName] = useState("");

  const handleCreate = () => {
    const value = newName.trim();
    if (!value) return;
    createProfile.mutate(
      { name: value },
      {
        onSuccess: () => {
          setNewName("");
          showToast(`Perfil "${value}" criado`);
        },
      },
    );
  };

  return (
    <div
      className="modal-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-panel" onClick={(event) => event.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="kb-modal">
          <div className="modal-header">
            <div className="modal-title-row">
              <h2 style={{ margin: 0, fontSize: 16 }}>🔁 Perfis de loop</h2>
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            <div className="modal-section">
              <div className="modal-section-title">Perfis</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {profiles.length === 0 ? (
                  <div style={{ color: "var(--text-muted)" }}>Nenhum perfil de loop.</div>
                ) : (
                  profiles.map((profile) => (
                    <LoopProfileRow key={profile.id} boardId={boardId} profile={profile} />
                  ))
                )}
              </div>
            </div>

            <div className="modal-section">
              <div className="modal-section-title">Novo perfil</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="criteria-input"
                  style={{ flex: 1 }}
                  value={newName}
                  placeholder="Nome (ex.: Hotfix, Spike, Docs)"
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleCreate();
                    }
                  }}
                />
                <button
                  className="kb-btn kb-btn-primary kb-btn-sm"
                  onClick={handleCreate}
                  disabled={!newName.trim() || createProfile.isPending}
                >
                  Criar
                </button>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                Fases separadas por vírgula: reproduce, analysis, implementation, validation. A última é
                sempre a validação (teste de mesa dos fluxos).
              </div>
            </div>

            <div className="modal-section">
              <div className="modal-section-title">Labels → perfil de loop</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {labels.length === 0 ? (
                  <div style={{ color: "var(--text-muted)" }}>Nenhuma label.</div>
                ) : (
                  labels.map((label) => (
                    <div key={label.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        className="swatch"
                        style={{
                          background: label.color,
                          width: 14,
                          height: 14,
                          borderRadius: 4,
                          display: "inline-block",
                        }}
                      />
                      <span style={{ flex: 1, fontSize: 13 }}>{label.name}</span>
                      <select
                        className="select-inline"
                        value={label.loopProfileId ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          updateLabel.mutate({
                            id: label.id,
                            dto: { loopProfileId: value ? value : null },
                          });
                        }}
                      >
                        <option value="">— genérico —</option>
                        {customProfiles.map((profile) => (
                          <option key={profile.id} value={profile.profileId}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
