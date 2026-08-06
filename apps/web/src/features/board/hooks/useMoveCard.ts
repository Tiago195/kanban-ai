import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MISSING_REQUIRED_FIELDS, type MoveCardDto } from "@kanban-ai/shared";

import { queryKeys } from "@/features/board/services/queryKeys";
import { apiClient } from "@/shared/services/apiClient";
import { showToast } from "@/shared/services/toastStore";
import type { ApiBoard, ApiCardDetails, ApiCardSummary } from "@/shared/types";

interface MoveCardVariables {
  boardId: string;
  cardId: string;
  dto: MoveCardDto;
  /**
   * Quando a task é movida no mini-kanban de uma story, este é o id da story
   * pai. Usado para atualizar/invalidar o detalhe do pai (query `card(parentId)`),
   * cujo array `children` alimenta o mini-kanban — sem isso o mini-kanban fica
   * defasado até um F5.
   */
  parentId?: string | null;
}

interface MoveCardContext {
  previousCards?: ApiCardSummary[];
  previousParent?: ApiCardDetails;
}

export function useMoveCard() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ cardId, dto }: MoveCardVariables) => apiClient.moveCard(cardId, dto),
    onMutate: async ({ boardId, cardId, dto, parentId }): Promise<MoveCardContext> => {
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

      // Atualização otimista do detalhe do pai (mini-kanban dentro da story).
      let previousParent: ApiCardDetails | undefined;
      if (parentId) {
        const parentKey = queryKeys.card(parentId);
        await queryClient.cancelQueries({ queryKey: parentKey });
        previousParent = queryClient.getQueryData<ApiCardDetails>(parentKey);
        if (previousParent) {
          queryClient.setQueryData<ApiCardDetails>(parentKey, (current) => {
            if (!current) return current;
            return {
              ...current,
              children: current.children.map((child) =>
                child.id === cardId
                  ? {
                      ...child,
                      boardColumnId: destination?.isTaskColumn ? null : dto.columnId,
                      taskColumnId: destination?.isTaskColumn ? dto.columnId : null,
                      position: dto.position ?? child.position,
                    }
                  : child,
              ),
            };
          });
        }
      }

      return { previousCards, previousParent };
    },
    onError: (error, variables, context) => {
      if (context?.previousCards) {
        queryClient.setQueryData(queryKeys.cards(variables.boardId), context.previousCards);
      }
      if (variables.parentId && context?.previousParent) {
        queryClient.setQueryData(queryKeys.card(variables.parentId), context.previousParent);
      }
      // Gate do backend: story→In Progress sem Projeto-alvo. Avisa de forma clara
      // (o board principal já abre o modal proativamente; isto cobre outros
      // pontos de move, como o mini-kanban dentro do épico).
      const code = (error as Error & { code?: string })?.code;
      if (code === MISSING_REQUIRED_FIELDS) {
        showToast(
          (error as Error)?.message ??
            "Defina o Projeto-alvo da story antes de movê-la para In Progress.",
        );
      }
    },
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(variables.boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(variables.boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.card(variables.cardId) });
      if (variables.parentId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.card(variables.parentId) });
      }
    },
  });
}
