import { z } from 'zod';
import type { AgentAdapterKind } from '@kanban-ai/shared';
import { AGENT_ADAPTER_KINDS } from '../../shared/config/config';

/** Schema de atualização do modelo default do quadro. */
export const setBoardModelSchema = z.object({
  defaultModel: z.string().min(1).nullable(),
});

export type SetBoardModelDto = z.infer<typeof setBoardModelSchema>;

/**
 * US-F3.10 — atualização do adapter default do quadro (raiz da cascata de
 * adapter, análoga a `defaultModel`). Validado contra o catálogo de kinds;
 * null limpa e volta a herdar do global (AGENT_ADAPTER).
 */
export const setBoardAdapterSchema = z.object({
  defaultAdapter: z
    .enum([...AGENT_ADAPTER_KINDS] as [AgentAdapterKind, ...AgentAdapterKind[]])
    .nullable(),
});

export type SetBoardAdapterDto = z.infer<typeof setBoardAdapterSchema>;

/**
 * EP-PROJECT / US-PROJ6 — associa (ou desassocia, com null) o `Project` do
 * quadro. Raiz da cascata de repo-alvo (Board.projectId), análoga ao
 * `defaultModel`. Ver `orchestrator.resolveStoryProjectId`.
 */
export const setBoardProjectSchema = z.object({
  projectId: z.string().min(1).nullable(),
});

export type SetBoardProjectDto = z.infer<typeof setBoardProjectSchema>;
