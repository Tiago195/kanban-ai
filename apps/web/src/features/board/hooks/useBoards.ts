import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";

import { queryKeys } from "../services/queryKeys";

export function useBoards() {
  return useQuery({
    queryKey: queryKeys.boards,
    queryFn: () => apiClient.getBoards(),
  });
}

export function usePrimaryBoardId() {
  const boardsQuery = useBoards();
  const boardId = boardsQuery.data?.[0]?.id ?? null;

  return {
    ...boardsQuery,
    boardId,
  };
}
