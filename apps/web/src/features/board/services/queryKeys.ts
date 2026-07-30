export const queryKeys = {
  boards: ["boards"] as const,
  board: (boardId: string) => ["board", boardId] as const,
  cards: (boardId: string) => ["cards", boardId] as const,
  card: (cardId: string) => ["card", cardId] as const,
};
