import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { CreateProjectInput } from "@kanban-ai/shared";

import { apiClient } from "@/shared/services/apiClient";
import { queryKeys } from "@/features/board/services/queryKeys";

/**
 * EP-PROJECT / US-PROJ6 — cria um Project por URL git. O clone roda async no
 * backend; o `cloneState` evolui via evento WS `project.clone_state` (que
 * invalida a lista). Aqui só invalidamos a lista para o novo Project aparecer.
 */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => apiClient.createProject(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      // US-UX.4: a faixa de conhecimento acompanha a lista.
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectsKnowledge });
    },
  });
}

/** US-PROJ6 — remove um Project (e o clone gerenciado, no backend). */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => apiClient.deleteProject(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      // US-UX.4: a faixa de conhecimento acompanha a lista.
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectsKnowledge });
    },
  });
}

/**
 * US-PROJ6 — associa (ou desassocia, com null) o Project ao Board, persistindo
 * `Board.projectId` via `PATCH /boards/:id/project`. Invalida board + cards
 * (raiz da cascata de repo-alvo, análoga ao modelo default).
 */
export function useSetBoardProject(boardId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string | null) =>
      apiClient.setBoardProject(boardId as string, projectId),
    onSuccess: () => {
      if (!boardId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.boards });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
    },
  });
}
