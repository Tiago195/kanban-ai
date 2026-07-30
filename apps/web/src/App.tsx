import { useEffect, useState } from "react";

import { AssigneesPlaceholder } from "@/features/assignees";
import { BoardView, usePrimaryBoardId } from "@/features/board";
import { useBoardUiStore, type AppTabId } from "@/features/board/services";
import { EpicsPlaceholder } from "@/features/epics";
import { LabelsPlaceholder } from "@/features/labels";
import { useRealtime } from "@/features/realtime";
import { StoriesPlaceholder } from "@/features/stories";
import { TasksPlaceholder } from "@/features/tasks";
import { AiEnginePlaceholder } from "@/features/ai-engine";
import { AppLayout } from "@/shared/components/AppLayout";
import { Button } from "@/shared/components/ui/button";
import { getHealth } from "@/shared/services/apiClient";

const TABS: { id: AppTabId; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "epics", label: "Epics" },
  { id: "stories", label: "Stories" },
  { id: "tasks", label: "Tasks" },
  { id: "labels", label: "Labels" },
  { id: "assignees", label: "Assignees" },
  { id: "ai-engine", label: "AI Engine" },
];

function TabContent({ tab }: { tab: AppTabId }) {
  switch (tab) {
    case "board":
      return <BoardView />;
    case "epics":
      return <EpicsPlaceholder />;
    case "stories":
      return <StoriesPlaceholder />;
    case "tasks":
      return <TasksPlaceholder />;
    case "labels":
      return <LabelsPlaceholder />;
    case "assignees":
      return <AssigneesPlaceholder />;
    case "ai-engine":
      return <AiEnginePlaceholder />;
    default:
      return null;
  }
}

export default function App() {
  const [health, setHealth] = useState<string>("carregando…");
  const { activeTab, setActiveTab } = useBoardUiStore();
  const { boardId } = usePrimaryBoardId();
  const { status, lastEvent } = useRealtime(undefined, boardId);

  useEffect(() => {
    getHealth()
      .then((res) => setHealth(res.status ?? JSON.stringify(res)))
      .catch((err: unknown) => setHealth("indisponível (" + String(err) + ")"));
  }, []);

  const nav = TABS.map((t) => (
    <Button key={t.id} variant={t.id === activeTab ? "default" : "ghost"} size="sm" onClick={() => setActiveTab(t.id)}>
      {t.label}
    </Button>
  ));

  return (
    <AppLayout title="Kanban-AI" nav={nav}>
      <div className="mb-6 flex flex-wrap items-center gap-4 text-sm">
        <span className="rounded-md border border-border px-3 py-1">
          API health: <strong>{health}</strong>
        </span>
        <span className="rounded-md border border-border px-3 py-1">
          WS: <strong>{status}</strong>
        </span>
        <span className="rounded-md border border-border px-3 py-1">
          Último evento: <strong>{lastEvent ? lastEvent.type : "nenhum"}</strong>
        </span>
      </div>
      <TabContent tab={activeTab} />
    </AppLayout>
  );
}
