import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/features/board/services/queryKeys";
import { apiClient } from "@/shared/services/apiClient";
import type { LoopStateResponse } from "@/shared/services/apiClient";

/**
 * Estado do loop de uma story (auto-play rodando? sessão viva?). O realtime
 * invalida esta query quando o backend emite auto.started/auto.stopped.
 */
export function useLoopState(storyId: string | null, enabled = true) {
  return useQuery<LoopStateResponse>({
    queryKey: queryKeys.loopState(storyId ?? "none"),
    queryFn: () => apiClient.getLoopState(storyId as string),
    enabled: Boolean(storyId) && enabled,
    staleTime: 2_000,
  });
}

/** Dispara 1 iteração manual do loop (botão "▶ Rodar 1 iteração"). */
export function useStepLoop(boardId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storyId: string) => apiClient.stepLoop(storyId),
    onSettled: (_data, _err, storyId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.loopState(storyId) });
      if (boardId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
      }
    },
  });
}

/** Inicia/para o auto-play server-side (botões "⏩ Auto-play / ⏸ Parar"). */
export function useAutoPlay(boardId: string | null) {
  const queryClient = useQueryClient();

  const invalidate = (storyId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.loopState(storyId) });
    if (boardId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
    }
  };

  const start = useMutation({
    mutationFn: (storyId: string) => apiClient.startAutoLoop(storyId),
    onSettled: (_d, _e, storyId) => invalidate(storyId),
  });

  const stop = useMutation({
    mutationFn: ({ storyId, mode }: { storyId: string; mode?: "graceful" | "hard" }) =>
      apiClient.stopAutoLoop(storyId, mode ?? "graceful"),
    onSettled: (_d, _e, { storyId }) => invalidate(storyId),
  });

  return { start, stop };
}
