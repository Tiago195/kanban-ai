import { z } from 'zod';

/**
 * US-OBS3 — Schema de criação de comentário de review por linha. O `cardId` vem
 * do path (`:id`), então NÃO é aceito no body (evita divergência path/body).
 */
export const createReviewCommentSchema = z.object({
  iterationId: z.string().nullable().optional(),
  filePath: z.string().min(1),
  line: z.number().int().min(1),
  body: z.string().min(1),
  author: z.string().min(1),
});

export type CreateReviewCommentDto = z.infer<typeof createReviewCommentSchema>;
