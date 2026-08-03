import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";

import { queryKeys } from "../services/queryKeys";

interface DeleteCardVariables {
  cardId: string;
  /** Pai do card excluído — invalidado para reagir no mini-kanban/epic. */
  parentId?: string | null;
}

export function useDeleteCard(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ cardId }: DeleteCardVariables) => apiClient.deleteCard(cardId),
    onSuccess: (result, variables) => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
      // Remove os detalhes dos cards excluídos (card e descendentes).
      for (const id of result.deletedIds) {
        queryClient.removeQueries({ queryKey: queryKeys.card(id) });
      }
      if (variables.parentId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.card(variables.parentId) });
      }
    },
  });
}
