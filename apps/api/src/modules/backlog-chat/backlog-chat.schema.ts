import { z } from 'zod';

/** Cria uma sessão de chat de backlog ancorada num board. */
export const createBacklogSessionSchema = z.object({
  boardId: z.string().uuid(),
});
export type CreateBacklogSessionDto = z.infer<typeof createBacklogSessionSchema>;

/**
 * Mensagem nova do humano num turno da conversa.
 *
 * `channel` identifica a thread (canal) em que a mensagem foi disparada:
 * `main` (chat geral) ou `story:<storyId>` (thread focada numa story). Ver
 * ADR-0023. Opcional — o orquestrador assume `main` quando ausente.
 */
export const backlogMessageSchema = z.object({
  text: z.string().min(1),
  channel: z.string().min(1).optional(),
});
export type BacklogMessageDto = z.infer<typeof backlogMessageSchema>;

/**
 * Resposta a uma pergunta de descoberta pendente (HITL).
 *
 * `channel` é aceito por simetria com o envio de mensagens, mas o orquestrador
 * deriva o canal correto a partir da pergunta persistida — ele é informativo.
 */
export const backlogAnswerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1),
  channel: z.string().min(1).optional(),
});
export type BacklogAnswerDto = z.infer<typeof backlogAnswerSchema>;

/** Aprova e materializa uma versão específica da proposta. */
export const backlogApplySchema = z.object({
  version: z.number().int().positive(),
});
export type BacklogApplyDto = z.infer<typeof backlogApplySchema>;

/**
 * Materializa (cria no board) tasks rascunhadas no chat de uma story existente,
 * como cards `type:task` filhos em To Do. Ver ADR-0026.
 */
export const materializeStoryTasksSchema = z.object({
  titles: z.array(z.string().min(1)).min(1),
});
export type MaterializeStoryTasksDto = z.infer<typeof materializeStoryTasksSchema>;

/**
 * Resolve o card `type:story` do board materializado por uma sessão applied,
 * casando pelo título da story da proposta. Ver bug tasks-fantasma / ADR-0026.
 */
export const resolveStoryCardSchema = z.object({
  title: z.string().min(1),
});
export type ResolveStoryCardDto = z.infer<typeof resolveStoryCardSchema>;
