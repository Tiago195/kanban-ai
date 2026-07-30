import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";

import { queryKeys } from "../services/queryKeys";

export function useBoard(boardId: string | null) {
  return useQuery({
    queryKey: boardId ? queryKeys.board(boardId) : ["board", "empty"],
    queryFn: () => apiClient.getBoard(boardId as string),
    enabled: Boolean(boardId),
  });
}
