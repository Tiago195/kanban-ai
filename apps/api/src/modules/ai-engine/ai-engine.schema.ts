import { z } from 'zod';

/** Schema do corpo de parada do auto-play. */
export const stopAutoSchema = z.object({
  mode: z.enum(['graceful', 'hard']).default('graceful'),
});

export type StopAutoDto = z.infer<typeof stopAutoSchema>;
