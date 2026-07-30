import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/features/board/services";
import { apiClient } from "@/shared/services/apiClient";

export function useCard(cardId: string | null) {
  return useQuery({
    queryKey: cardId ? queryKeys.card(cardId) : ["card", "empty"],
    queryFn: () => apiClient.getCard(cardId as string),
    enabled: Boolean(cardId),
  });
}
