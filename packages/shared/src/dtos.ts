/**
 * DTOs de mutação trafegados de web → api. São o contrato de request; os schemas
 * Zod do backend (apps/api) devem validar exatamente estes formatos.
 *
 * Fonte da verdade dos formatos: schemas Zod em apps/api/src/modules/cards.
 */

import type { CardType, StoryPoints } from './enums';

/** Payload para criar um card (POST /cards). */
export interface CreateCardDto {
  boardId: string;
  type: CardType;
  title: string;
  description?: string;
  parentId?: string | null;
  /** Coluna do board (story/epic) — obrigatória p/ story/epic. */
  columnId?: string;
  /** Coluna do mini-kanban (task) — obrigatória p/ task. */
  taskColumnId?: string;
  points?: StoryPoints | null;
  /** Story: caminho absoluto do repositório-alvo (aiProject) do loop engine. */
  aiProject?: string;
  /** Story: resumo de contexto de AI. */
  aiSummary?: string;
  /** Story: notas de AI. */
  aiNotes?: string;
  /** Loop profile do card (validado contra profiles builtin/custom). */
  loopType?: string;
  priority?: number;
  idempotencyKey?: string;
  startInPlanMode?: boolean;
}

/** Payload para mover um card entre colunas (PATCH /cards/:id/move). */
export interface MoveCardDto {
  /** Coluna de destino (board ou mini-kanban). */
  columnId: string;
  /** Posição desejada na coluna de destino (0-based). Se ausente, vai ao fim. */
  position?: number;
}

/** Payload para editar campos de um card (PATCH /cards/:id). */
export interface UpdateCardDto {
  title?: string;
  description?: string;
  points?: StoryPoints | null;
  blocked?: boolean;
  /** Story: contexto de AI. */
  aiSummary?: string;
  aiProject?: string;
  aiNotes?: string;
  /** Modelo de AI deste card (null = herdar do pai/board). */
  model?: string | null;
  priority?: number | null;
  startInPlanMode?: boolean;
}

/** Criar item de DOD (POST /cards/:id/dod). */
export interface CreateDodItemDto {
  text: string;
}

/** Editar item de DOD (PATCH /dod/:id). */
export interface UpdateDodItemDto {
  text?: string;
  done?: boolean;
}

/** Anexar label a um card (POST /cards/:id/labels). */
export interface AttachLabelDto {
  labelId: string;
}

/** Anexar assignee a um card (POST /cards/:id/assignees). */
export interface AttachAssigneeDto {
  assigneeId: string;
}

/** Criar affectedFlow numa story (POST /cards/:id/flows). */
export interface CreateFlowDto {
  name: string;
  files?: string[];
  note?: string;
}

/**
 * Código de erro estruturado usado quando um move é recusado por faltarem
 * campos obrigatórios (ex.: mover story→In Progress sem `aiProject`). O backend
 * inclui este código no corpo do erro para o front saber exatamente qual campo
 * exigir do usuário (sem parsear a mensagem textual).
 */
export const MISSING_REQUIRED_FIELDS = 'MISSING_REQUIRED_FIELDS' as const;

/** Campos que o gate de move pode exigir antes de permitir a transição. */
export type RequiredCardField = 'aiProject';

/**
 * Corpo de erro (400) emitido pelo gate de move quando faltam campos
 * obrigatórios para a transição pretendida.
 */
export interface MissingRequiredFieldsError {
  code: typeof MISSING_REQUIRED_FIELDS;
  /** Campos ausentes que precisam ser preenchidos antes de refazer o move. */
  fields: RequiredCardField[];
  /** Mensagem legível (fallback caso o front não trate o código). */
  message: string;
}
