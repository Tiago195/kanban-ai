import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MoveCardDto } from "@kanban-ai/shared";

import { queryKeys } from "@/features/board/services/queryKeys";
import { apiClient } from "@/shared/services/apiClient";
import type { ApiBoard, ApiCardSummary } from "@/shared/types";

interface MoveCardVariables {
  boardId: string;
  cardId: string;
  dto: MoveCardDto;
}

interface MoveCardContext {
  previousCards?: ApiCardSummary[];
}

export function useMoveCard() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ cardId, dto }: MoveCardVariables) => apiClient.moveCard(cardId, dto),
    onMutate: async ({ boardId, cardId, dto }): Promise<MoveCardContext> => {
      const cardsKey = queryKeys.cards(boardId);
      const boardKey = queryKeys.board(boardId);

      await queryClient.cancelQueries({ queryKey: cardsKey });

      const previousCards = queryClient.getQueryData<ApiCardSummary[]>(cardsKey);
      const board = queryClient.getQueryData<ApiBoard>(boardKey);
      const destination = board?.columns.find((column) => column.id === dto.columnId);

      if (previousCards) {
        queryClient.setQueryData<ApiCardSummary[]>(cardsKey, (current = []) => {
          const moved = current.find((card) => card.id === cardId);
          if (!moved) return current;

          const optimistic = current.filter((card) => card.id !== cardId);
          optimistic.push({
            ...moved,
            boardColumnId: destination?.isTaskColumn ? null : dto.columnId,
            taskColumnId: destination?.isTaskColumn ? dto.columnId : null,
            position: dto.position ?? moved.position,
          });
          return optimistic;
        });
      }

      return { previousCards };
    },
    onError: (_error, variables, context) => {
      if (context?.previousCards) {
        queryClient.setQueryData(queryKeys.cards(variables.boardId), context.previousCards);
      }
    },
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(variables.boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(variables.boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.card(variables.cardId) });
    },
  });
}
