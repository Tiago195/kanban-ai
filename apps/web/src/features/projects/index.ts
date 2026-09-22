// US-UX.1 — o Explorador virou página inteira (a "moldura" da camada de
// conhecimento); o antigo modal de Projetos virou painel dentro dela.
export { ExplorerPage } from "./components/ProjectExplorer";
export { ProjectsPanel } from "./components/ProjectsManager";
export {
  useProjects,
  useProjectRepoInfo,
  useProjectMemory,
  useProjectNeuron,
  useSyncProject,
} from "./hooks/useProjectExplorer";
export {
  useCreateProject,
  useDeleteProject,
  useSetBoardProject,
} from "./hooks/useProjectOnboarding";
