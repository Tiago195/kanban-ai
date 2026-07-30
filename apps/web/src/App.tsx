import { useEffect, useMemo, useState } from "react";

import { BoardView, useBoard, useCards, usePrimaryBoardId } from "@/features/board";
import { useRealtime } from "@/features/realtime";
import { getHealth } from "@/shared/services/apiClient";

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

  useEffect(() => {
    getHealth()
      .then((res) => setHealth(res.status ?? JSON.stringify(res)))
      .catch((err: unknown) => setHealth("indisponível (" + String(err) + ")"));
  }, []);

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
          <input className="search-input" type="search" placeholder="Buscar cards…" aria-label="Buscar cards" />
          <select className="filter-select" aria-label="Filtrar por tipo" defaultValue="">
            <option value="">Histórias e Tasks</option>
            <option value="story">Só Histórias</option>
            <option value="task">Só Tasks</option>
          </select>
          <select className="filter-select" aria-label="Filtrar por label" defaultValue="">
            <option value="">Todas as labels</option>
          </select>
          <select className="filter-select" aria-label="Filtrar por agente" defaultValue="">
            <option value="">Todos os agentes</option>
          </select>
          <button className="kb-btn kb-btn-ghost" type="button" title="Gerenciar agentes responsáveis">
            🤖 Agentes
          </button>
          <button className="kb-btn kb-btn-ghost" type="button" title="Gerenciar perfis de loop das AIs">
            🔁 Loops
          </button>
          <button className="kb-btn kb-btn-ghost" type="button">
            + Coluna
          </button>
          <button className="kb-btn kb-btn-ghost" type="button" title="Exportar JSON">
            ⤓ Export
          </button>
          <button className="kb-btn kb-btn-ghost" type="button" title="Importar JSON">
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
    </div>
  );
}
