import { useMutation, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/features/board/services";
import { apiClient } from "@/shared/services/apiClient";

interface LabelsMutationVariables {
  boardId: string;
  cardId: string;
  labelId: string;
}

export function useCardLabels() {
  const queryClient = useQueryClient();

  const refresh = (boardId: string, cardId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.card(cardId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
  };

  const attachLabel = useMutation({
    mutationFn: ({ cardId, labelId }: LabelsMutationVariables) => apiClient.attachLabel(cardId, { labelId }),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  const detachLabel = useMutation({
    mutationFn: ({ cardId, labelId }: LabelsMutationVariables) => apiClient.detachLabel(cardId, labelId),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  return { attachLabel, detachLabel };
}
