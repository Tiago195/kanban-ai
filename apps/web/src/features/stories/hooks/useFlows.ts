import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateFlowDto } from "@kanban-ai/shared";

import { queryKeys } from "@/features/board/services";
import { apiClient } from "@/shared/services/apiClient";

interface FlowScopedMutation {
  boardId: string;
  cardId: string;
}

export function useFlows() {
  const queryClient = useQueryClient();

  const refresh = (boardId: string, cardId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.card(cardId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
  };

  const addFlow = useMutation({
    mutationFn: ({ cardId, dto }: FlowScopedMutation & { dto: CreateFlowDto }) =>
      apiClient.addFlow(cardId, dto),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  const removeFlow = useMutation({
    mutationFn: ({ flowId }: FlowScopedMutation & { flowId: string }) => apiClient.removeFlow(flowId),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  return { addFlow, removeFlow };
}
