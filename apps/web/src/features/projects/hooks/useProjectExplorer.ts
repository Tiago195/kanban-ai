import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";
import { queryKeys } from "@/features/board/services/queryKeys";

/** US-PROJ7 — lista de Projects (para escolher qual explorar). */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => apiClient.getProjects(),
  });
}

/**
 * US-UX.4 — estado do conhecimento de todos os Projects (faixa dos cards):
 * UMA requisição para a lista inteira, nunca N×4 do browser.
 */
export function useProjectsKnowledge() {
  return useQuery({
    queryKey: queryKeys.projectsKnowledge,
    queryFn: () => apiClient.getProjectsKnowledge(),
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

/**
 * US-UX.3 — painel da memória (aba "O que a AI sabe"): o que o reflect
 * aprendeu (vereditos por nó, becos sem saída, correções).
 */
export function useProjectLearning(projectId: string | null) {
  return useQuery({
    queryKey: projectId ? queryKeys.projectLearning(projectId) : ["projectLearning", "none"],
    queryFn: () => apiClient.getProjectLearning(projectId as string),
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

/**
 * US-F4.2 — projeção do grafo de conhecimento (aba "Grafo"). Os `params`
 * entram na queryKey (cada modo/navegação tem cache próprio);
 * `placeholderData: keepPreviousData` mantém a projeção anterior na tela
 * durante a navegação (sem "piscar" para loading a cada clique).
 */
export function useProjectGraph(
  projectId: string | null,
  params: { focus?: string; community?: number; search?: string; depth?: number },
) {
  return useQuery({
    queryKey: projectId
      ? queryKeys.projectGraph(projectId, params)
      : ["projectGraph", "none"],
    queryFn: () => apiClient.getProjectGraph(projectId as string, params),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
}

/**
 * US-F4.3 — cards que tocaram o arquivo de um nó do grafo (nó → arquivo →
 * card). Só busca quando há nó focado COM `sourceFile` (nós sem arquivo não
 * têm o que cruzar com o board).
 */
export function useGraphFileCards(projectId: string | null, file: string | null) {
  return useQuery({
    queryKey:
      projectId && file
        ? queryKeys.projectGraphFileCards(projectId, file)
        : ["projectGraphFileCards", "none"],
    queryFn: () => apiClient.getProjectGraphFileCards(projectId as string, file as string),
    enabled: Boolean(projectId && file),
  });
}

/** US-F5.4 — índice da Wiki do grafo (aba "Wiki"). */
export function useProjectWiki(projectId: string | null) {
  return useQuery({
    queryKey: projectId ? queryKeys.projectWiki(projectId) : ["projectWiki", "none"],
    queryFn: () => apiClient.getProjectWiki(projectId as string),
    enabled: Boolean(projectId),
  });
}

/**
 * US-F5.4 — um artigo da Wiki. `keepPreviousData` mantém o artigo anterior na
 * tela durante a navegação por links internos (sem "piscar" para loading).
 * Só busca com a wiki GERADA (o índice `generated:true` chegou primeiro).
 */
export function useProjectWikiArticle(
  projectId: string | null,
  slug: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey:
      projectId && slug
        ? queryKeys.projectWiki(projectId, slug)
        : ["projectWiki", "none", "none"],
    queryFn: () => apiClient.getProjectWikiArticle(projectId as string, slug as string),
    enabled: Boolean(projectId && slug) && enabled,
    placeholderData: keepPreviousData,
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
