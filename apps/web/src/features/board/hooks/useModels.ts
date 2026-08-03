import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";

import { queryKeys } from "../services/queryKeys";

/** Lista os modelos de AI disponíveis para o login e o default do CLI. */
export function useModels() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: () => apiClient.getModels(),
    staleTime: 5 * 60 * 1000,
  });
}

/** Define o modelo default do quadro; invalida board + cards para refletir a cascata. */
export function useSetBoardModel(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (defaultModel: string | null) =>
      apiClient.setBoardModel(boardId as string, defaultModel),
    onSuccess: () => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.boards });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
    },
  });
}
