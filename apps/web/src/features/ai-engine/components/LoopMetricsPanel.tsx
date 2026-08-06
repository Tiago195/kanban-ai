import type { LoopMetrics } from "@kanban-ai/shared";

import { useLoopMetrics } from "../hooks";

const EXEC_STATE_LABEL: Record<string, string> = {
  idle: "Ocioso",
  running: "Rodando",
  "awaiting-input": "Aguardando",
  blocked: "Bloqueado",
  done: "Concluído",
};

function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("pt-BR");
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

/**
 * Painel de custo & qualidade do loop de uma story: consome o endpoint
 * `GET /cards/:id/loop/metrics` (via `useLoopMetrics`) e renderiza os
 * números-chave (tokens, duração média, iterações, taxas) + tabela por task.
 */
export function LoopMetricsPanel({ storyId }: { storyId: string }) {
  const { data, isLoading, isError, error } = useLoopMetrics(storyId, Boolean(storyId));

  if (isLoading) {
    return <div className="metrics-empty">Carregando métricas do loop…</div>;
  }

  if (isError) {
    return (
      <div className="metrics-empty">
        Não foi possível carregar as métricas
        {error instanceof Error ? `: ${error.message}` : "."}
      </div>
    );
  }

  const metrics: LoopMetrics | undefined = data;
  if (!metrics) {
    return <div className="metrics-empty">Sem métricas disponíveis.</div>;
  }

  if (metrics.iterationCount === 0) {
    return (
      <div className="metrics-empty">
        Sem iterações ainda. Rode 1 iteração ou mova a história para In Progress.
      </div>
    );
  }

  return (
    <div className="loop-metrics">
      <div className="metric-stats">
        <Stat label="Tokens de entrada" value={formatTokens(metrics.totalInputTokens)} />
        <Stat label="Tokens de saída" value={formatTokens(metrics.totalOutputTokens)} />
        <Stat label="Duração média / iteração" value={formatDuration(metrics.avgDurationMs)} />
        <Stat label="Iterações" value={String(metrics.iterationCount)} hint={`${metrics.taskCount} tasks`} />
        <Stat label="Iterações / task" value={String(metrics.avgIterationsPerTask)} />
        <Stat label="Taxa de derivação" value={formatPct(metrics.derivedTaskRate)} hint="validação falhou" />
        <Stat label="Taxa de OK" value={formatPct(metrics.okIterationRate)} hint="desfecho ok" />
      </div>

      {metrics.perTask.length > 0 ? (
        <table className="metrics-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Título</th>
              <th>Estado</th>
              <th className="metrics-num">Iterações</th>
            </tr>
          </thead>
          <tbody>
            {metrics.perTask.map((task) => (
              <tr key={task.taskId}>
                <td className="metrics-key">{task.key}</td>
                <td>{task.title}</td>
                <td>{EXEC_STATE_LABEL[task.execState] ?? task.execState}</td>
                <td className="metrics-num">{task.iterations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
