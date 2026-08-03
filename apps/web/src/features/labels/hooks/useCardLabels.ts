import { useMutation, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/features/board/services";
import { apiClient } from "@/shared/services/apiClient";

interface LabelsMutationVariables {
  boardId: string;
  cardId: string;
  labelId: string;
}

/** Paleta de cores para novas labels (portada do artifact de referência). */
export const LABEL_PALETTE = [
  "#e5484d",
  "#3b82f6",
  "#8b5cf6",
  "#0ea5e9",
  "#f59e0b",
  "#22a06b",
  "#ec4899",
  "#14b8a6",
];

export function useCardLabels() {
  const queryClient = useQueryClient();

  const refresh = (boardId: string, cardId?: string) => {
    if (cardId) void queryClient.invalidateQueries({ queryKey: queryKeys.card(cardId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
  };

  const attachLabel = useMutation({
    mutationFn: ({ cardId, labelId }: LabelsMutationVariables) => apiClient.attachLabel(cardId, { labelId }),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  const detachLabel = useMutation({
    mutationFn: ({ cardId, labelId }: LabelsMutationVariables) => apiClient.detachLabel(cardId, labelId),
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  /** Cria uma label nova no board e a atribui ao card atual. */
  const createLabel = useMutation({
    mutationFn: async (params: { boardId: string; cardId: string; name: string; color?: string }) => {
      const label = await apiClient.createLabel({
        boardId: params.boardId,
        name: params.name,
        color: params.color,
      });
      await apiClient.attachLabel(params.cardId, { labelId: label.id });
      return label;
    },
    onSuccess: (_res, variables) => refresh(variables.boardId, variables.cardId),
  });

  /** Exclui uma label de TODO o board (cascata remove os vínculos com cards). */
  const deleteLabel = useMutation({
    mutationFn: (params: { boardId: string; labelId: string }) => apiClient.deleteLabel(params.labelId),
    onSuccess: (_res, variables) => refresh(variables.boardId),
  });

  return { attachLabel, detachLabel, createLabel, deleteLabel };
}
