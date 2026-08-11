import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import {
  BACKLOG_MAIN_CHANNEL,
  type BacklogChatMessage,
  type BacklogProposal,
  type BacklogTaskProposal,
} from "@kanban-ai/shared";

import { apiClient } from "@/shared/services/apiClient";
import { showToast } from "@/shared/services/toastStore";
import { queryKeys } from "@/features/board/services";
import {
  selectChannel,
  useBacklogChatStore,
  type BacklogPending,
} from "@/features/backlog-chat/services/backlogChatStore";

export interface UseBacklogChatResult {
  messages: BacklogChatMessage[];
  pending: BacklogPending | null;
  proposal: BacklogProposal | null;
  taskProposal: BacklogTaskProposal | null;
  streaming: boolean;
  /** Epoch (ms) em que o turno corrente começou, ou null se ocioso. */
  streamingSince: number | null;
  /** Última linha de atividade da AI (status vivo), ou null. */
  lastActivity: string | null;
  isSending: boolean;
  isAnswering: boolean;
  isApplying: boolean;
  /** Envia uma mensagem livre do humano (dispara turno da AI). */
  send: (text: string) => void;
  /** Responde à pergunta de descoberta pendente (HITL). */
  answer: (text: string) => void;
  /** Aprova a proposta corrente: materializa Epic + Stories no board. */
  apply: () => void;
}

/**
 * Estado reativo do chat de backlog de uma sessão, **escopado a um canal**
 * (thread estilo Slack — ver ADR-0023). `main` é a conversa geral; passar
 * `backlogStoryChannel(storyId)` abre a thread focada de uma story.
 *
 * Alimentado pelos eventos `backlog.*` no realtime (streaming/HITL/proposta, sem
 * invalidar cache) e reidratado do backend no F5. A hidratação busca o
 * transcript COMPLETO da sessão (todos os canais) e deixa o store particioná-lo
 * por `message.channel`; assim várias instâncias do hook (main + sheet de story)
 * compartilham uma única query keyed por `sessionId` e cada uma lê apenas o
 * slice do seu canal. `hydrate` é idempotente (só semeia canais vazios).
 *
 * `messages`, `pending` (HITL) e `streaming` são **por canal**; a `proposal` é
 * **por sessão** (compartilhada entre canais).
 *
 * `boardId` é necessário para invalidar os cards do board após o `/apply`.
 */
export function useBacklogChat(
  sessionId: string | null,
  boardId: string | null,
  channel: string = BACKLOG_MAIN_CHANNEL,
): UseBacklogChatResult {
  const chat = useBacklogChatStore((s) =>
    sessionId ? selectChannel(s.bySession, sessionId, channel) : undefined,
  );
  const proposal = useBacklogChatStore((s) =>
    sessionId ? (s.bySession[sessionId]?.proposal ?? null) : null,
  );
  const taskProposal = useBacklogChatStore((s) =>
    sessionId ? (s.bySession[sessionId]?.taskProposal ?? null) : null,
  );
  const hydrate = useBacklogChatStore((s) => s.hydrate);
  const addMessage = useBacklogChatStore((s) => s.addMessage);
  const clearQuestion = useBacklogChatStore((s) => s.clearQuestion);
  const setStreaming = useBacklogChatStore((s) => s.setStreaming);
  const queryClient = useQueryClient();

  // A história é buscada por SESSÃO (não por canal): o transcript é completo e o
  // store o particiona por canal em `hydrate`. Keyed só por `sessionId` para que
  // instâncias concorrentes do hook (main + sheet) dedupem a mesma query.
  const { data: history } = useQuery({
    queryKey: ["backlog-chat", sessionId, "messages"],
    queryFn: () => apiClient.getBacklogMessages(sessionId as string),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
  });

  const { data: proposalData } = useQuery({
    queryKey: ["backlog-chat", sessionId, "proposal"],
    queryFn: () => apiClient.getBacklogProposal(sessionId as string),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (sessionId && history) hydrate(sessionId, history, proposalData ?? null);
  }, [sessionId, history, proposalData, hydrate]);

  const sendMutation = useMutation({
    mutationFn: (text: string) => {
      if (!sessionId) return Promise.reject(new Error("sem sessão"));
      // Otimista: mostra a mensagem do humano e liga o indicador de "digitando".
      // O streaming permanece ligado até um evento WS de chunk/pergunta/proposta
      // chegar — a request de /messages resolve rápido (turno roda em background).
      addMessage(sessionId, channel, {
        id: `local-${Date.now()}`,
        sessionId,
        channel,
        role: "user",
        text,
        ts: Date.now(),
      });
      setStreaming(sessionId, channel, true);
      return apiClient.sendBacklogMessage(sessionId, text, channel);
    },
    onError: () => {
      if (sessionId) setStreaming(sessionId, channel, false);
    },
  });

  const answerMutation = useMutation({
    mutationFn: (text: string) => {
      const questionId = chat?.pending?.questionId;
      if (!sessionId || !questionId) {
        return Promise.reject(new Error("sem pergunta pendente"));
      }
      return apiClient.answerBacklogQuestion(sessionId, questionId, text, channel);
    },
    onSuccess: (_data, text) => {
      if (sessionId) {
        clearQuestion(sessionId, channel, text);
        setStreaming(sessionId, channel, true);
      }
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      const version = proposal?.version;
      if (!sessionId || version == null) {
        return Promise.reject(new Error("sem proposta para aplicar"));
      }
      return apiClient.applyBacklog(sessionId, version);
    },
    onSuccess: () => {
      if (boardId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
        // Atualiza a lista lateral (a sessão vira "applied" → ✅) e o status
        // que a UI usa para desabilitar o botão de aprovar.
        void queryClient.invalidateQueries({ queryKey: ["backlog-sessions", boardId] });
      }
      showToast("Backlog criado no board ✅");
    },
    onError: (err: Error) => {
      showToast(err.message || "Falha ao aplicar o backlog");
      // Se falhou por já estar aplicada, ressincroniza o status na UI.
      if (boardId) {
        void queryClient.invalidateQueries({ queryKey: ["backlog-sessions", boardId] });
      }
    },
  });

  return {
    messages: chat?.messages ?? [],
    pending: chat?.pending ?? null,
    proposal,
    taskProposal,
    streaming: chat?.streaming ?? false,
    streamingSince: chat?.streamingSince ?? null,
    lastActivity: chat?.lastActivity ?? null,
    isSending: sendMutation.isPending,
    isAnswering: answerMutation.isPending,
    isApplying: applyMutation.isPending,
    send: (text: string) => sendMutation.mutate(text),
    answer: (text: string) => answerMutation.mutate(text),
    apply: () => applyMutation.mutate(),
  };
}
