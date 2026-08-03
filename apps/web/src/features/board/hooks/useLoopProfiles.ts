import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { IterationPhase, ValidationStrategy } from "@kanban-ai/shared";

import { apiClient } from "@/shared/services/apiClient";

import { queryKeys } from "../services/queryKeys";

/** Cria um perfil de loop custom e revalida o board. */
export function useCreateLoopProfile(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dto: {
      name: string;
      description?: string;
      phases?: IterationPhase[];
      validation?: ValidationStrategy;
      firstStep?: string;
    }) => apiClient.createLoopProfile({ boardId: boardId as string, ...dto }),
    onSuccess: () => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
    },
  });
}

/** Atualiza um perfil de loop (nome/descrição/fases) e revalida o board. */
export function useUpdateLoopProfile(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      id: string;
      dto: {
        name?: string;
        description?: string;
        phases?: IterationPhase[];
        validation?: ValidationStrategy;
        firstStep?: string;
      };
    }) => apiClient.updateLoopProfile(params.id, params.dto),
    onSuccess: () => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
    },
  });
}

/** Exclui um perfil de loop custom e revalida o board + cards (labels desvinculadas). */
export function useDeleteLoopProfile(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiClient.deleteLoopProfile(id),
    onSuccess: () => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
    },
  });
}

/** Atualiza o mapeamento label → perfil de loop e revalida o board. */
export function useUpdateLabel(boardId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      id: string;
      dto: { loopProfileId?: string | null; name?: string; color?: string };
    }) => apiClient.updateLabel(params.id, params.dto),
    onSuccess: () => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
    },
  });
}
