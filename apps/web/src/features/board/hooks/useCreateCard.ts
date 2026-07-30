import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateCardDto } from "@kanban-ai/shared";

import { apiClient } from "@/shared/services/apiClient";

import { queryKeys } from "../services/queryKeys";

interface CreateCardVariables {
  dto: CreateCardDto;
}

export function useCreateCard(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ dto }: CreateCardVariables) => apiClient.createCard(dto),
    onSuccess: (card) => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.card(card.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
    },
  });
}
