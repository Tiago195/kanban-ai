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

/** Schema de edição de campos de um card. */
export const updateCardSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    points: z
      .number()
      .refine((p) => (STORY_POINTS as readonly number[]).includes(p), {
        message: 'points deve ser 1,2,3,5,8 ou 13',
      })
      .nullable()
      .optional(),
    blocked: z.boolean().optional(),
    aiSummary: z.string().optional(),
    aiProject: z.string().optional(),
    aiNotes: z.string().optional(),
    model: z.string().nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'nenhum campo para atualizar' });

export type UpdateCardDto = z.infer<typeof updateCardSchema>;

/** Schema de criação de item de DOD. */
export const createDodItemSchema = z.object({
  text: z.string().min(1),
});

export type CreateDodItemDto = z.infer<typeof createDodItemSchema>;

/** Schema de edição de item de DOD (texto e/ou done). */
export const updateDodItemSchema = z
  .object({
    text: z.string().min(1).optional(),
    done: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'nenhum campo para atualizar' });

export type UpdateDodItemDto = z.infer<typeof updateDodItemSchema>;

/** Schema de anexação de label a um card. */
export const attachLabelSchema = z.object({
  labelId: z.string().uuid(),
});

export type AttachLabelDto = z.infer<typeof attachLabelSchema>;

/** Schema de anexação de assignee a um card. */
export const attachAssigneeSchema = z.object({
  assigneeId: z.string().uuid(),
});

export type AttachAssigneeDto = z.infer<typeof attachAssigneeSchema>;

/** Schema de criação de affectedFlow. */
export const createFlowSchema = z.object({
  name: z.string().min(1),
  files: z.array(z.string()).default([]),
  note: z.string().default(''),
});

export type CreateFlowDto = z.infer<typeof createFlowSchema>;
