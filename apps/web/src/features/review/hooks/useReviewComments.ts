import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/features/board/services/queryKeys";
import { apiClient } from "@/shared/services/apiClient";
import type { ReviewComment, ReviewCommentInput } from "@kanban-ai/shared";

/**
 * US-OBS3 — comentários inline de review de um card.
 *
 * O realtime (`review.comment_added`) invalida `queryKeys.reviewComments(cardId)`
 * para refletir novos comentários sem F5 (ver `useRealtime`).
 */
export function useReviewComments(cardId: string, enabled = true) {
  return useQuery<ReviewComment[]>({
    queryKey: queryKeys.reviewComments(cardId),
    queryFn: () => apiClient.getReviewComments(cardId),
    enabled: enabled && Boolean(cardId),
    staleTime: 10_000,
  });
}

/** Cria um comentário inline; invalida a lista do card ao concluir. */
export function useAddReviewComment(cardId: string) {
  const queryClient = useQueryClient();
  return useMutation<ReviewComment, Error, Omit<ReviewCommentInput, "cardId">>({
    mutationFn: (input) => apiClient.addReviewComment(cardId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviewComments(cardId) });
    },
  });
}

/** Marca um comentário como resolvido; invalida a lista do card ao concluir. */
export function useResolveReviewComment(cardId: string) {
  const queryClient = useQueryClient();
  return useMutation<ReviewComment, Error, string>({
    mutationFn: (commentId) => apiClient.resolveReviewComment(cardId, commentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviewComments(cardId) });
    },
  });
}
