import type { GraphFileCard, GraphFileCardsResponse } from "@kanban-ai/shared";

/**
 * US-F4.3 — estado do painel "cards que tocaram este arquivo" do nó focado
 * (nó → arquivo → card). Função PURA (padrão da US-F4.2: a lógica de estado
 * vive fora do componente e é testável offline): decide o que a UI mostra a
 * partir do `sourceFile` do nó e do resultado da query.
 *
 * O estado `empty` é ENTREGA VÁLIDA, não falha: a cobertura do vínculo depende
 * do board ter de fato trabalhado o arquivo (fluxos afetados/handoffs são
 * auto-declarados pela IA) — nó sem card conhecido diz isso claramente, não
 * some nem finge.
 */
export type FileCardsView =
  | { kind: "no-file" }
  | { kind: "loading"; file: string }
  | { kind: "error"; file: string; message: string }
  | { kind: "empty"; file: string }
  | { kind: "cards"; file: string; cards: GraphFileCard[] };

export function fileCardsView(
  sourceFile: string | null,
  query: {
    isLoading: boolean;
    isError: boolean;
    error?: unknown;
    data?: GraphFileCardsResponse;
  },
): FileCardsView {
  if (!sourceFile) return { kind: "no-file" };
  if (query.isLoading) return { kind: "loading", file: sourceFile };
  if (query.isError) {
    return {
      kind: "error",
      file: sourceFile,
      message: (query.error as Error)?.message ?? "erro desconhecido",
    };
  }
  if (!query.data || query.data.cards.length === 0) {
    return { kind: "empty", file: sourceFile };
  }
  return { kind: "cards", file: sourceFile, cards: query.data.cards };
}

/**
 * US-F4.3 — qual modal do board abrir para um card do painel. Task abre a
 * STORY pai junto (o TaskModal do board vive empilhado sobre a story) e o
 * task por cima; story/epic abrem direto.
 */
export function fileCardTarget(card: GraphFileCard):
  | { modal: "epic"; id: string }
  | { modal: "story"; id: string }
  | { modal: "task"; id: string; storyId: string | null } {
  if (card.type === "epic") return { modal: "epic", id: card.id };
  if (card.type === "story") return { modal: "story", id: card.id };
  return { modal: "task", id: card.id, storyId: card.parentId };
}
