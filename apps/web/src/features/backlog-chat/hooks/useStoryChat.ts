import { useMutation } from "@tanstack/react-query";
import type { StoryChatSession } from "@kanban-ai/shared";

import { apiClient } from "@/shared/services/apiClient";
import { showToast } from "@/shared/services/toastStore";

export interface UseStoryChatResult {
  /** Sessão de chat resolvida (reusada ou zerada) para a story, ou null. */
  session: StoryChatSession | null;
  /** Abre (ou reusa) a sessão de chat da story-card do board. */
  open: (storyId: string) => void;
  isOpening: boolean;
}

/**
 * Resolve a `BacklogChatSession` do "chat da story" (ADR-0026) para uma
 * story-card existente no board. Reusa a sessão original quando a story veio de
 * um backlog-chat; cria uma zerada e vincula quando a story é manual. O front
 * então reusa o MESMO `useBacklogChat` (transcript + threads por canal) sobre a
 * sessão resolvida.
 */
export function useStoryChat(
  onResolved?: (session: StoryChatSession) => void,
): UseStoryChatResult {
  const mutation = useMutation({
    mutationFn: (storyId: string) => apiClient.openStoryChatSession(storyId),
    onSuccess: (session) => onResolved?.(session),
    onError: () => showToast("Falha ao abrir o chat da história"),
  });

  return {
    session: mutation.data ?? null,
    open: (storyId: string) => mutation.mutate(storyId),
    isOpening: mutation.isPending,
  };
}
