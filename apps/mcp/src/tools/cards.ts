/**
 * Grupo `cards` (fatia F2) — CRUD e movimentação de cards do board.
 *
 * O MCP é um cliente HTTP fino: todas as invariantes de domínio (task só em
 * Backlog/To Do, epic derivado, points Fibonacci, loop ao entrar em In
 * Progress) são impostas pela API NestJS (:3333). As descrições abaixo
 * documentam essas invariantes proativamente para a AI se autocorrigir.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { STORY_POINTS } from '@kanban-ai/shared';
import type { KanbanClient } from '../client.js';
import { ok, registerTool } from './util.js';

export function registerCardTools(server: McpServer, client: KanbanClient): void {
  registerTool(
    server,
    'list_cards',
    'Lista os cards de um board (GET /cards). Passe `boardId` para filtrar; sem ele lista todos. Epics trazem `epicStatus` derivado das stories filhas.',
    { boardId: z.string().uuid().optional() },
    async (args) => ok(await client.get('/cards', { boardId: args.boardId })),
  );

  registerTool(
    server,
    'get_card',
    'Detalha um card por id (GET /cards/:id): inclui dod, flows, iterations, comments, activities, dependsOn, labels, assignees, children e resolvedModel.',
    { id: z.string().uuid() },
    async (args) => ok(await client.get(`/cards/${args.id}`)),
  );

  registerTool(
    server,
    'create_card',
    [
      'Cria um card (POST /cards). Hierarquia Epic → Story → Task via `parentId`.',
      'INVARIANTES: task só pode ser criada em coluna Backlog ou To Do;',
      `points (Fibonacci ${STORY_POINTS.join(', ')}) só se aplicam a story/epic — task não tem pontos.`,
      '`loopType` define o profile do loop engine — use list_loop_profiles para ver os válidos.',
    ].join(' '),
    {
      boardId: z.string().uuid(),
      type: z.enum(['epic', 'story', 'task']),
      title: z.string().min(1),
      description: z.string().optional(),
      parentId: z.string().uuid().nullable().optional(),
      points: z
        .number()
        .optional()
        .describe(`Story points Fibonacci (${STORY_POINTS.join(', ')}); só story/epic.`),
      columnId: z.string().uuid().optional(),
      loopType: z.string().min(1).optional(),
    },
    async (args) => ok(await client.post('/cards', args)),
  );

  registerTool(
    server,
    'update_card',
    [
      'Atualiza campos de um card (PATCH /cards/:id). Informe ao menos um campo além do id.',
      `points aceita Fibonacci (${STORY_POINTS.join(', ')}) ou null, e só se aplica a story/epic.`,
      'Não move o card — use move_card para trocar de coluna.',
    ].join(' '),
    {
      id: z.string().uuid(),
      title: z.string().optional(),
      description: z.string().optional(),
      points: z.number().nullable().optional(),
      blocked: z.boolean().optional(),
      aiSummary: z.string().optional(),
      aiProject: z.string().optional(),
      aiNotes: z.string().optional(),
      model: z.string().nullable().optional(),
      loopType: z.string().nullable().optional(),
    },
    async (args) => {
      const { id, ...rest } = args;
      const body = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      );
      return ok(await client.patch(`/cards/${id}`, body));
    },
  );

  registerTool(
    server,
    'move_card',
    [
      'Move um card para outra coluna/posição (PATCH /cards/:id/move).',
      'INVARIANTES: NUNCA mova um epic (seu status é derivado das stories filhas);',
      'mover uma story para In Progress dispara o loop engine.',
    ].join(' '),
    {
      id: z.string().uuid(),
      columnId: z.string().uuid(),
      position: z.number().int().min(0).optional(),
    },
    async (args) =>
      ok(await client.patch(`/cards/${args.id}/move`, {
        columnId: args.columnId,
        position: args.position,
      })),
  );

  registerTool(
    server,
    'delete_card',
    'Remove um card (DELETE /cards/:id) com cascata para todos os descendentes (stories/tasks filhas de um epic, tasks de uma story).',
    { id: z.string().uuid() },
    async (args) => ok(await client.delete(`/cards/${args.id}`)),
  );
}
