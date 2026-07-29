import { z } from 'zod';
import { STORY_POINTS } from '@kanban-ai/shared';

/** Schema de criação de card (epic/story/task). */
export const createCardSchema = z.object({
  boardId: z.string().uuid(),
  type: z.enum(['epic', 'story', 'task']),
  title: z.string().min(1),
  description: z.string().default(''),
  parentId: z.string().uuid().nullable().optional(),
  points: z
    .number()
    .refine((p) => (STORY_POINTS as readonly number[]).includes(p), {
      message: 'points deve ser 1,2,3,5,8 ou 13',
    })
    .optional(),
  columnId: z.string().uuid().optional(),
});

export type CreateCardDto = z.infer<typeof createCardSchema>;

/** Schema de movimento de card entre colunas. */
export const moveCardSchema = z.object({
  columnId: z.string().uuid(),
  position: z.number().int().min(0).optional(),
});

export type MoveCardDto = z.infer<typeof moveCardSchema>;
