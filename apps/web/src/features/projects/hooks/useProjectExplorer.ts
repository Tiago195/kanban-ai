import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";
import { queryKeys } from "@/features/board/services/queryKeys";

/** US-PROJ7 — lista de Projects (para escolher qual explorar). */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => apiClient.getProjects(),
  });
}

/** Metadados do repositório clonado (aba "Repositório"). */
export function useProjectRepoInfo(projectId: string | null) {
  return useQuery({
    queryKey: projectId ? queryKeys.projectRepoInfo(projectId) : ["projectRepoInfo", "none"],
    queryFn: () => apiClient.getProjectRepoInfo(projectId as string),
    enabled: Boolean(projectId),
  });
}

/** Índice da memória (aba "O que a AI sabe"). */
export function useProjectMemory(projectId: string | null) {
  return useQuery({
    queryKey: projectId ? queryKeys.projectMemory(projectId) : ["projectMemory", "none"],
    queryFn: () => apiClient.getProjectMemory(projectId as string),
    enabled: Boolean(projectId),
  });
}

/** Detalhe (markdown completo) de um neurônio selecionado. */
export function useProjectNeuron(projectId: string | null, path: string | null) {
  return useQuery({
    queryKey:
      projectId && path
        ? queryKeys.projectMemory(projectId, path)
        : ["projectMemory", "none", "none"],
    queryFn: () => apiClient.getProjectNeuron(projectId as string, path as string),
    enabled: Boolean(projectId && path),
  });
}

/** Dispara o sync do clone gerenciado e invalida o repo-info (o realtime confirma). */
export function useSyncProject(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.syncProject(projectId as string),
    onSuccess: () => {
      if (!projectId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectRepoInfo(projectId) });
    },
  });
}
