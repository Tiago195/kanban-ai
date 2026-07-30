import { useMutation } from "@tanstack/react-query";
import type { AgentChatMessage, PendingQuestion } from "@kanban-ai/shared";

import { apiClient } from "@/shared/services/apiClient";
import { useAgentChatStore } from "@/features/ai-engine/services/agentChatStore";

export interface UseAgentChatResult {
  messages: AgentChatMessage[];
  pending: PendingQuestion | null;
  isAnswering: boolean;
  /** Envia a resposta do humano à pergunta pendente (HITL). */
  answer: (text: string) => void;
}

/**
 * Expõe o transcript reativo do chat de uma task (alimentado por
 * `agent.chunk`/`agent.question`/`agent.answered` no realtime, sem invalidar
 * cache — ADR-0017) e a ação de responder à pergunta pendente.
 *
 * `storyId` é necessário porque o endpoint HITL opera sobre a story (dona da
 * sessão do agent).
 */
export function useAgentChat(taskId: string | null, storyId: string | null): UseAgentChatResult {
  const chat = useAgentChatStore((s) => (taskId ? s.byTask[taskId] : undefined));
  const clearQuestion = useAgentChatStore((s) => s.clearQuestion);

  const answerMutation = useMutation({
    mutationFn: (text: string) => {
      const questionId = chat?.pending?.questionId;
      if (!storyId || !questionId) {
        return Promise.reject(new Error("sem pergunta pendente"));
      }
      return apiClient.answerQuestion(storyId, questionId, text);
    },
    onSuccess: (_data, text) => {
      if (taskId) clearQuestion(taskId, text);
    },
  });

  return {
    messages: chat?.messages ?? [],
    pending: chat?.pending ?? null,
    isAnswering: answerMutation.isPending,
    answer: (text: string) => answerMutation.mutate(text),
  };
}
