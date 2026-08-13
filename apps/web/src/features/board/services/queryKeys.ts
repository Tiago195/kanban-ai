export const queryKeys = {
  boards: ["boards"] as const,
  board: (boardId: string) => ["board", boardId] as const,
  cards: (boardId: string) => ["cards", boardId] as const,
  card: (cardId: string) => ["card", cardId] as const,
  loopState: (storyId: string) => ["loopState", storyId] as const,
  loopMetrics: (storyId: string) => ["loopMetrics", storyId] as const,
  /** US-OBS1 — read-model agregado da frota (GET /dashboard). */
  dashboard: () => ["dashboard"] as const,
  /**
   * Índice da memória (ADR-0027). A UI da memória lê a projeção Postgres via esta
   * chave; o realtime invalida-a a cada evento `memory.*` (EP-81, US-206) para
   * refazer o fetch contra o índice sem F5. `path` opcional = detalhe de 1 neurônio.
   */
  memory: (path?: string) => (path ? (["memory", path] as const) : (["memory"] as const)),
  models: ["agentModels"] as const,
};
