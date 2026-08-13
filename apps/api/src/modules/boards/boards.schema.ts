import { z } from 'zod';

/** Schema de atualização do modelo default do quadro. */
export const setBoardModelSchema = z.object({
  defaultModel: z.string().min(1).nullable(),
});

export type SetBoardModelDto = z.infer<typeof setBoardModelSchema>;

/**
 * EP-PROJECT / US-PROJ6 — associa (ou desassocia, com null) o `Project` do
 * quadro. Raiz da cascata de repo-alvo (Board.projectId), análoga ao
 * `defaultModel`. Ver `orchestrator.resolveStoryProjectId`.
 */
export const setBoardProjectSchema = z.object({
  projectId: z.string().min(1).nullable(),
});

export type SetBoardProjectDto = z.infer<typeof setBoardProjectSchema>;
