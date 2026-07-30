import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateDodItemDto, UpdateDodItemDto } from "@kanban-ai/shared";

import { queryKeys } from "@/features/board/services";
import { apiClient } from "@/shared/services/apiClient";

interface CardScopedMutation {
  boardId: string;
  cardId: string;
}

export function useDodMutations() {
  const queryClient = useQueryClient();

  const refresh = (boardId: string, cardId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.card(cardId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
  };

  const addDod = useMutation({
    mutationFn: ({ cardId, dto }: CardScopedMutation & { dto: CreateDodItemDto }) =>
      apiClient.addDod(cardId, dto),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  const updateDod = useMutation({
    mutationFn: ({ itemId, dto }: CardScopedMutation & { itemId: string; dto: UpdateDodItemDto }) =>
      apiClient.updateDod(itemId, dto),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  const removeDod = useMutation({
    mutationFn: ({ itemId }: CardScopedMutation & { itemId: string }) => apiClient.removeDod(itemId),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  return { addDod, updateDod, removeDod };
}
