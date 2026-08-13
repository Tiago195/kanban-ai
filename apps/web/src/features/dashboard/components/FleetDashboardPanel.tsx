import type {
  FleetColumnCount,
  FleetCostSummary,
  FleetStaleStory,
} from "@kanban-ai/shared";

import { useFleetDashboard } from "../hooks/useFleetDashboard";

function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("pt-BR");
}

function formatStale(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric-stat">
      <div className="metric-stat-value">{value}</div>
      <div className="metric-stat-label">{label}</div>
      {hint ? <div className="metric-stat-hint">{hint}</div> : null}
    </div>
  );
}

function CostBlock({ cost }: { cost: FleetCostSummary }) {
  return (
    <div className="metric-stats">
      <Stat label="Stories ativas" value={String(cost.activeStories)} hint="In Progress" />
      <Stat label="Iterações" value={String(cost.totalIterations)} />
      <Stat label="Tokens de entrada" value={formatTokens(cost.totalInputTokens)} />
      <Stat label="Tokens de saída" value={formatTokens(cost.totalOutputTokens)} />
      <Stat label="Taxa de derivação" value={formatPct(cost.derivedTaskRate)} hint="média ponderada" />
      <Stat label="Taxa de OK" value={formatPct(cost.okIterationRate)} hint="média ponderada" />
    </div>
  );
}

function ColumnsTable({ columns }: { columns: FleetColumnCount[] }) {
  return (
    <table className="metrics-table">
      <thead>
        <tr>
          <th>Coluna</th>
          <th className="metrics-num">Epics</th>
          <th className="metrics-num">Stories</th>
          <th className="metrics-num">Tasks</th>
          <th className="metrics-num">Total</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((col) => (
          <tr key={col.column}>
            <td>{col.column}</td>
            <td className="metrics-num">{col.epics}</td>
            <td className="metrics-num">{col.stories}</td>
            <td className="metrics-num">{col.tasks}</td>
            <td className="metrics-num">{col.total}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StaleTable({ stories }: { stories: FleetStaleStory[] }) {
  if (stories.length === 0) {
    return <div className="metrics-empty">Nenhuma story stale em In Progress. 🎉</div>;
  }
  return (
    <table className="metrics-table">
      <thead>
        <tr>
          <th>Story</th>
          <th>Título</th>
          <th>Estado</th>
          <th className="metrics-num">Parada há</th>
        </tr>
      </thead>
      <tbody>
        {stories.map((story) => (
          <tr key={story.storyId}>
            <td className="metrics-key">{story.key}</td>
            <td>{story.title}</td>
            <td>{story.execState}</td>
            <td className="metrics-num">{formatStale(story.staleMinutes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * US-OBS1 — painel do dashboard de frota. Consome `GET /dashboard` (via
 * `useFleetDashboard`) e renderiza: burn/cost agregado, contagem por coluna e
 * stories stale. Reusa o padrão visual do `LoopMetricsPanel`.
 */
export function FleetDashboardPanel() {
  const { data, isLoading, isError, error } = useFleetDashboard();

  if (isLoading) {
    return <div className="metrics-empty">Carregando dashboard da frota…</div>;
  }

  if (isError) {
    return (
      <div className="metrics-empty">
        Não foi possível carregar o dashboard
        {error instanceof Error ? `: ${error.message}` : "."}
      </div>
    );
  }

  if (!data) {
    return <div className="metrics-empty">Sem dados de frota.</div>;
  }

  return (
    <div className="loop-metrics fleet-dashboard">
      <CostBlock cost={data.cost} />

      <h4 className="fleet-section-title">Cards por coluna</h4>
      <ColumnsTable columns={data.columns} />

      <h4 className="fleet-section-title">Stories stale (In Progress)</h4>
      <StaleTable stories={data.staleStories} />
    </div>
  );
}
