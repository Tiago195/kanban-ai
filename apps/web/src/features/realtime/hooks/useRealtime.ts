import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerEvent } from "@kanban-ai/shared";

import { queryKeys } from "@/features/board/services";
import { useAgentChatStore } from "@/features/ai-engine/services/agentChatStore";
import { useBacklogChatStore } from "@/features/backlog-chat/services/backlogChatStore";
import { WsClient } from "@/shared/services/wsClient";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface UseRealtimeResult {
  status: ConnectionStatus;
  lastEvent: ServerEvent | null;
}

export function useRealtime(url?: string, boardId?: string | null): UseRealtimeResult {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const clientRef = useRef<WsClient | null>(null);
  const queryClient = useQueryClient();

  // boardId muda quando o usuário troca de board — lemos via ref para NÃO
  // recriar o socket (evita flap de conexão e perda de eventos).
  const boardIdRef = useRef<string | null | undefined>(boardId);
  boardIdRef.current = boardId;

  useEffect(() => {
    const client = new WsClient({
      url,
      onOpen: () => setStatus("open"),
      onClose: () => setStatus("closed"),
      onEvent: (event) => {
        setLastEvent(event);
        const boardId = boardIdRef.current;
        // ── Streaming/HITL: buffer reativo, SEM invalidar cache (ADR-0017) ──
        // Estes eventos não dependem de boardId (chat vive em memória).
        if (event.type === "agent.chunk") {
          useAgentChatStore.getState().appendChunk({
            taskId: event.taskId,
            kind: event.kind,
            delta: event.delta,
          });
          return;
        }

        if (event.type === "agent.question") {
          useAgentChatStore.getState().setQuestion({
            taskId: event.taskId,
            questionId: event.questionId,
            prompt: event.prompt,
            options: event.options,
            ts: Date.now(),
          });
          return;
        }

        if (event.type === "agent.answered") {
          useAgentChatStore.getState().clearQuestion(event.taskId);
          return;
        }

        // ── Chat de backlog: buffer reativo próprio, SEM invalidar cache ──
        // Eventos de canal (chunk/question/answered) carregam `channel`. A
        // proposta é session-level (sem canal). Ver ADR-0023.
        if (event.type === "backlog.chunk") {
          useBacklogChatStore.getState().appendChunk({
            sessionId: event.sessionId,
            channel: event.channel,
            kind: event.kind,
            delta: event.delta,
          });
          return;
        }

        if (event.type === "backlog.question") {
          useBacklogChatStore.getState().setQuestion({
            sessionId: event.sessionId,
            channel: event.channel,
            questionId: event.questionId,
            prompt: event.prompt,
            options: event.options,
            ts: Date.now(),
          });
          return;
        }

        if (event.type === "backlog.answered") {
          useBacklogChatStore.getState().clearQuestion(event.sessionId, event.channel);
          return;
        }

        if (event.type === "backlog.proposal") {
          useBacklogChatStore.getState().setProposal(event.sessionId, event.proposal);
          return;
        }

        if (event.type === "backlog.task_proposal") {
          useBacklogChatStore
            .getState()
            .setTaskProposal(event.sessionId, event.taskProposal);
          return;
        }

        // BUG-01: fim do turno de backlog → desliga o indicador "ainda
        // trabalhando" do canal, mesmo que o turno não tenha emitido
        // proposal/question (ex.: só `output`).
        if (event.type === "backlog.turn_done") {
          useBacklogChatStore
            .getState()
            .setStreaming(event.sessionId, event.channel, false);
          return;
        }

        // #2: fim de uma iteração → desliga o indicador "agente digitando" da
        // task. (A próxima iteração religa no primeiro agent.chunk.) Feito antes
        // do guard de boardId porque o chat vive em memória.
        if (event.type === "iteration.appended") {
          useAgentChatStore.getState().setStreaming(event.taskId, false);
        }

        // ── Memória viva (ADR-0027, EP-81/US-206): reflete estado sem F5 ──
        // Os eventos memory.* NÃO dependem de boardId (a memória é global à
        // colmeia). O cliente reage refazendo fetch contra o índice: invalida a
        // chave do neurônio afetado (quando o evento carrega `path`) e a lista.
        if (
          event.type === "memory.locked" ||
          event.type === "memory.released" ||
          event.type === "memory.updated"
        ) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.memory(event.path) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.memory() });
          return;
        }

        if (event.type === "memory.conflict") {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.memory(event.conflict.path),
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.memory() });
          return;
        }

        if (event.type === "memory.review") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.memory(event.item.path) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.memory() });
          return;
        }

        if (event.type === "review.comment_added") {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.reviewComments(event.cardId),
          });
          return;
        }

        if (!boardId) return;

        if (event.type === "card.moved") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.cardId) });
          if (event.parentId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.parentId) });
          }
          return;
        }

        if (event.type === "comment.created") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.cardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          if (event.parentId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.parentId) });
          }
          return;
        }

        if (
          [
            "card.updated",
            "dod.checked",
            "dod.created",
            "label.attached",
            "label.detached",
            "assignee.attached",
            "assignee.detached",
            "flow.changed",
          ].includes(event.type) &&
          "cardId" in event
        ) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.cardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          return;
        }

        if (event.type === "card.created") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
          // Card filho (ex.: task) aparece em `children` do pai — invalida o pai
          // para o mini-kanban do modal reagir.
          if (event.card.parentId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.card.parentId) });
          }
          return;
        }

        if (event.type === "card.deleted") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
          for (const id of event.deletedIds) {
            queryClient.removeQueries({ queryKey: queryKeys.card(id) });
          }
          if (event.parentId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.parentId) });
          }
          return;
        }

        if (event.type === "epic.status.derived") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          return;
        }

        if (event.type === "board.updated") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          return;
        }

        // ── Loop engine events ────────────────────────────────────────────
        // Iteration/exec-state changes target a task (which is a Card).
        if (event.type === "iteration.appended" || event.type === "task.state.changed") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.taskId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          // O evento carrega taskId, não storyId; invalida qualquer painel de
          // métricas aberto (chave ["loopMetrics", storyId]) para refletir a
          // nova iteração sem F5.
          void queryClient.invalidateQueries({
            predicate: (q) => q.queryKey[0] === "loopMetrics",
          });
          return;
        }

        if (event.type === "card.needs_human") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.taskId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.loopState(event.storyId) });
          return;
        }

        if (event.type === "task.derived") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.originTaskId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.derivedTaskId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          return;
        }

        if (event.type === "auto.started" || event.type === "auto.stopped") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.loopState(event.storyId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.storyId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          return;
        }

        if (event.type === "agent.session.state_changed") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.loopState(event.storyId) });
          return;
        }

        if (event.type === "story.entered_in_progress") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.loopState(event.storyId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
        }
      },
    });

    clientRef.current = client;
    setStatus("connecting");
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [url, queryClient]);

  return { status, lastEvent };
}
