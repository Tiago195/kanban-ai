import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UpdateCardDto } from "@kanban-ai/shared";

import { queryKeys } from "@/features/board/services";
import { apiClient } from "@/shared/services/apiClient";

interface UpdateCardVariables {
  cardId: string;
  boardId: string;
  dto: UpdateCardDto;
}

export function useUpdateCard() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ cardId, dto }: UpdateCardVariables) => apiClient.updateCard(cardId, dto),
    onSuccess: (_card, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.card(variables.cardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(variables.boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(variables.boardId) });
    },
  });
}
