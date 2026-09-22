export const queryKeys = {
  boards: ["boards"] as const,
  board: (boardId: string) => ["board", boardId] as const,
  cards: (boardId: string) => ["cards", boardId] as const,
  card: (cardId: string) => ["card", cardId] as const,
  loopState: (storyId: string) => ["loopState", storyId] as const,
  loopMetrics: (storyId: string) => ["loopMetrics", storyId] as const,
  /** US-OBS1 — read-model agregado da frota (GET /dashboard). */
  dashboard: () => ["dashboard"] as const,
  /** US-OBS3 — comentários inline de review de um card. */
  reviewComments: (cardId: string) => ["reviewComments", cardId] as const,
  /**
   * EP-PROJECT / US-PROJ7 — Project Explorer. `repoInfo` reflete o clone
   * (invalidado pelo realtime `project.clone_state`); lista/detalhe da memória
   * (`projectMemory`) atualizam por refetch de navegação (US-F2.3: os eventos
   * `memory.*` morreram com o substrato git da memória).
   */
  projectRepoInfo: (projectId: string) => ["projectRepoInfo", projectId] as const,
  /** EP-PROJECT / US-PROJ6 — lista de Projects (badge de clone atualizado por realtime). */
  projects: ["projects"] as const,
  /** US-UX.4 — resumo do conhecimento (grafo/wiki/memória) da lista de cards;
   * invalidado junto com `projects` (clone/grafo mudam → contagens mudam). */
  projectsKnowledge: ["projectsKnowledge"] as const,
  /**
   * US-F4.2 — projeção do grafo de conhecimento (aba "Grafo"). O prefixo
   * `["projectGraph", projectId]` invalida TODAS as projeções (qualquer modo)
   * quando o realtime `project.graph_state` avisa que o grafo mudou.
   */
  projectGraph: (projectId: string, params?: Record<string, unknown>) =>
    params
      ? (["projectGraph", projectId, params] as const)
      : (["projectGraph", projectId] as const),
  /** US-F4.3 — cards que tocaram um arquivo do grafo (nó → arquivo → card). */
  projectGraphFileCards: (projectId: string, file: string) =>
    ["projectGraphFileCards", projectId, file] as const,
  /**
   * US-UX.3 — painel da memória (aba "O que a AI sabe"): overlay do reflect
   * + becos sem saída. Atualiza por refetch de navegação, como o
   * `projectMemory` (o reflect roda em background após os learnings).
   */
  projectLearning: (projectId: string) => ["projectLearning", projectId] as const,
  projectMemory: (projectId: string, path?: string) =>
    path
      ? (["projectMemory", projectId, path] as const)
      : (["projectMemory", projectId] as const),
  /**
   * US-F5.4 — Wiki do grafo (aba "Wiki"). O prefixo `["projectWiki",
   * projectId]` invalida índice E artigos quando o realtime
   * `project.graph_state` avisa que o grafo (e portanto a wiki) mudou.
   */
  projectWiki: (projectId: string, slug?: string) =>
    slug
      ? (["projectWiki", projectId, slug] as const)
      : (["projectWiki", projectId] as const),
  models: ["agentModels"] as const,
};
