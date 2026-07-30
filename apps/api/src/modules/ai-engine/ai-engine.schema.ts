import { z } from 'zod';

/** Schema do corpo de parada do auto-play. */
export const stopAutoSchema = z.object({
  mode: z.enum(['graceful', 'hard']).default('graceful'),
});

export type StopAutoDto = z.infer<typeof stopAutoSchema>;

/** Schema do corpo de resposta a uma pergunta HITL. */
export const answerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1),
});

export type AnswerDto = z.infer<typeof answerSchema>;
