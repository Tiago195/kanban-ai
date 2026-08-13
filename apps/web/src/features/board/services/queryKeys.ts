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
  /** US-OBS3 — comentários inline de review de um card. */
  reviewComments: (cardId: string) => ["reviewComments", cardId] as const,
  /**
   * EP-PROJECT / US-PROJ7 — Project Explorer. `repoInfo` reflete o clone; a
   * lista/detalhe de memória são invalidados pelo realtime (`memory.*` global e
   * `project.clone_state` para o repo-info).
   */
  projectRepoInfo: (projectId: string) => ["projectRepoInfo", projectId] as const,
  /** EP-PROJECT / US-PROJ6 — lista de Projects (badge de clone atualizado por realtime). */
  projects: ["projects"] as const,
  projectMemory: (projectId: string, path?: string) =>
    path
      ? (["projectMemory", projectId, path] as const)
      : (["projectMemory", projectId] as const),
  models: ["agentModels"] as const,
};
