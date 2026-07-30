import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerEvent } from "@kanban-ai/shared";

import { queryKeys } from "@/features/board/services";
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

  useEffect(() => {
    const client = new WsClient({
      url,
      onOpen: () => setStatus("open"),
      onClose: () => setStatus("closed"),
      onEvent: (event) => {
        setLastEvent(event);

        if (!boardId) return;

        if (event.type === "card.moved") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.card(event.cardId) });
          return;
        }

        if (
          [
            "card.updated",
            "dod.checked",
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
          return;
        }

        if (event.type === "epic.status.derived") {
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
  }, [url, boardId, queryClient]);

  return { status, lastEvent };
}
