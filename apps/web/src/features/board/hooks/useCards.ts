import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";

import { queryKeys } from "../services/queryKeys";

export function useCards(boardId: string | null) {
  return useQuery({
    queryKey: boardId ? queryKeys.cards(boardId) : ["cards", "empty"],
    queryFn: () => apiClient.getCards(boardId as string),
    enabled: Boolean(boardId),
  });
}
