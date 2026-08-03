import { z } from 'zod';

/** Schema de atualização do modelo default do quadro. */
export const setBoardModelSchema = z.object({
  defaultModel: z.string().min(1).nullable(),
});

export type SetBoardModelDto = z.infer<typeof setBoardModelSchema>;
