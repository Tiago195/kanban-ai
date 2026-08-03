import { useEffect, useMemo, useRef, useState } from "react";

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
import { Toast } from "@/shared/components/Toast";
import { getHealth } from "@/shared/services/apiClient";
import { showToast } from "@/shared/services/toastStore";
import type { ApiLoopProfile } from "@/shared/types";

const THEME_KEY = "kanban-ai-theme";

function useDarkMode() {
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(THEME_KEY) === "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add("dark");
      window.localStorage.setItem(THEME_KEY, "dark");
    } else {
      root.classList.remove("dark");
      window.localStorage.setItem(THEME_KEY, "light");
    }
  }, [dark]);

  return { dark, toggle: () => setDark((value) => !value) };
}

export default function App() {
  const [health, setHealth] = useState<string>("carregando…");
  const { dark, toggle } = useDarkMode();
  const { boardId } = usePrimaryBoardId();
  const { data: board } = useBoard(boardId);
  const { data: cards } = useCards(boardId);
  const { status } = useRealtime(undefined, boardId);

  const filters = useBoardUiStore((state) => state.filters);
  const setFilters = useBoardUiStore((state) => state.setFilters);

  const [agentsOpen, setAgentsOpen] = useState(false);
  const [loopsOpen, setLoopsOpen] = useState(false);

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
          <select
            className="filter-select"
            aria-label="Filtrar por tipo"
            value={filters.type}
            onChange={(event) => setFilters({ type: event.target.value as typeof filters.type })}
          >
            <option value="">Histórias e Tasks</option>
            <option value="story">Só Histórias</option>
            <option value="task">Só Tasks</option>
          </select>
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
            title="Gerenciar agentes responsáveis"
            onClick={() => setAgentsOpen(true)}
          >
            🤖 Agentes
          </button>
          <button
            className="kb-btn kb-btn-ghost"
            type="button"
            title="Gerenciar perfis de loop das AIs"
            onClick={() => setLoopsOpen(true)}
          >
            🔁 Loops
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
          <button
            className="kb-btn-icon"
            type="button"
            title={"Alternar tema — API: " + health}
            aria-label="Alternar tema"
            onClick={toggle}
          >
            {dark ? "☀️" : "🌙"}
          </button>
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

      {agentsOpen ? (
        <AgentsModal boardId={boardId} onClose={() => setAgentsOpen(false)} />
      ) : null}
      {loopsOpen ? <LoopsModal boardId={boardId} onClose={() => setLoopsOpen(false)} /> : null}
    </div>
  );
}

function AgentsModal({ boardId, onClose }: { boardId: string | null; onClose: () => void }) {
  const { data: board } = useBoard(boardId);
  const createAssignee = useCreateAssignee(boardId);
  const deleteAssignee = useDeleteAssignee(boardId);
  const modelsQuery = useModels();
  const setBoardModel = useSetBoardModel(boardId);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || createAssignee.isPending) return;
    createAssignee.mutate(
      { name: trimmed },
      {
        onSuccess: () => {
          setName("");
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
    <div className="modal-layer" onClick={onClose}>
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
                    style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}
                  >
                    <span>🤖 {assignee.name}</span>
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
              <div className="field-row" style={{ gap: 8 }}>
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
    <div className="modal-layer" onClick={onClose}>
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
