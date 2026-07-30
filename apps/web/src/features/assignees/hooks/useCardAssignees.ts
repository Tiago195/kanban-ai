import { useMutation, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/features/board/services";
import { apiClient } from "@/shared/services/apiClient";

interface AssigneesMutationVariables {
  boardId: string;
  cardId: string;
  assigneeId: string;
}

export function useCardAssignees() {
  const queryClient = useQueryClient();

  const refresh = (boardId: string, cardId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.card(cardId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
  };

  const attachAssignee = useMutation({
    mutationFn: ({ cardId, assigneeId }: AssigneesMutationVariables) =>
      apiClient.attachAssignee(cardId, { assigneeId }),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  const detachAssignee = useMutation({
    mutationFn: ({ cardId, assigneeId }: AssigneesMutationVariables) =>
      apiClient.detachAssignee(cardId, assigneeId),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  return { attachAssignee, detachAssignee };
}
