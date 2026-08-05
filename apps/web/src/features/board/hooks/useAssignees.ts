import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";

import { queryKeys } from "../services/queryKeys";

/** Cria um agent (assignee) global e revalida o board. */
export function useCreateAssignee(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dto: { name: string; model?: string; instructions?: string }) =>
      apiClient.createAssignee({ boardId: boardId as string, ...dto }),
    onSuccess: () => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
    },
  });
}

/** Remove um agent (assignee) global e revalida o board + cards. */
export function useDeleteAssignee(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (assigneeId: string) => apiClient.removeAssignee(assigneeId),
    onSuccess: () => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
    },
  });
}
