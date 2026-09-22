import { z } from 'zod';
import { STORY_POINTS } from '@kanban-ai/shared';
import type { AgentAdapterKind } from '@kanban-ai/shared';
import { AGENT_ADAPTER_KINDS } from '../../shared/config/config';

/**
 * US-F3.10 — adapter por card, validado contra o catálogo de kinds na ESCRITA
 * (a leitura da cascata ignora valores desconhecidos, mas o certo é nem deixar
 * entrar). null limpa o override e volta a herdar.
 */
const adapterField = z
  .enum([...AGENT_ADAPTER_KINDS] as [AgentAdapterKind, ...AgentAdapterKind[]])
  .nullable()
  .optional();

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
  loopType: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  idempotencyKey: z.string().min(1).optional(),
  startInPlanMode: z.boolean().optional(),
  aiSummary: z.string().optional(),
  aiProject: z.string().optional(),
  aiNotes: z.string().optional(),
  // Rastreio de origem: sessão do backlog-chat que materializou o card. Uso
  // interno (apply do backlog-chat); não é preenchido em criações manuais via
  // board. Ver ADR-0026.
  backlogChatSessionId: z.string().uuid().optional(),
  /**
   * US-COLAB1 — tenant do card. Ausente = card global (retrocompatível). Ver
   * ADR-0030; rótulo opaco de escopo (sem auth no v1, ADR-0009).
   */
  tenantId: z.string().min(1).optional(),
});

export type CreateCardDto = z.infer<typeof createCardSchema>;

/**
 * Query params de `GET /cards` — todos opcionais e retrocompatíveis: sem nenhum
 * param a rota devolve o comportamento antigo (lista completa, campos completos).
 * Habilita paginação por cursor, filtros e projeção `summary` para consumidores
 * headless (MCP/LLM) não estourarem contexto.
 */
export const listCardsQuerySchema = z.object({
  boardId: z.string().uuid().optional(),
  /** Filtra por tipo de card. */
  type: z.enum(['epic', 'story', 'task']).optional(),
  /** Filtra por coluna (bate em boardColumnId OU taskColumnId). */
  columnId: z.string().uuid().optional(),
  /** Retorna só cards atualizados em/depois deste instante (ISO 8601). */
  updatedSince: z.string().datetime().optional(),
  /** Página máxima; quando presente, ativa o modo paginado (retorna `{ items, nextCursor }`). */
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** Cursor de continuação (id do último card da página anterior). */
  cursor: z.string().uuid().optional(),
  /** Projeção: `full` (default) mantém tudo; `summary` retorna só campos essenciais. */
  fields: z.enum(['full', 'summary']).optional(),
  /**
   * US-COLAB1 — filtra o board por tenant. Ausente = comportamento antigo
   * (todos os cards do board). Presente = só cards com esse tenantId (filtro
   * estrito; cards globais com tenantId=null NÃO vazam). Ver ADR-0030.
   */
  tenantId: z.string().min(1).optional(),
});

export type ListCardsQueryDto = z.infer<typeof listCardsQuerySchema>;

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
    adapter: adapterField, // US-F3.10 — cascata de adapter (custo por card)
    loopType: z.string().min(1).nullable().optional(),
    priority: z.number().int().nullable().optional(),
    startInPlanMode: z.boolean().optional(),
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

/**
 * Schema de criação de comentário num card. `authorId` é opcional: quando um
 * assignee (agent) deixa um handoff/resumo, aponta o id; humano/AI externa
 * pode omitir (null).
 */
export const createCommentSchema = z.object({
  text: z.string().min(1),
  authorId: z.string().uuid().nullable().optional(),
});

export type CreateCommentDto = z.infer<typeof createCommentSchema>;

/**
 * Schema de criação de dependência entre tasks. O card do path é o dependente
 * (o que precisa esperar); `dependsOnId` é a task que deve terminar antes.
 */
export const createDependencySchema = z.object({
  dependsOnId: z.string().uuid(),
});

export type CreateDependencyDto = z.infer<typeof createDependencySchema>;

/**
 * US-OBS2-2 — Query do tail incremental do log de eventos de um card
 * (`GET /cards/:id/events`). `since` é o cursor por id (o último evento já visto);
 * `limit` limita a página (default 100, teto 500).
 */
export const listCardEventsQuerySchema = z.object({
  /** Cursor por id: retorna só eventos APÓS este id. Ausente = do começo. */
  since: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export type ListCardEventsQueryDto = z.infer<typeof listCardEventsQuerySchema>;
