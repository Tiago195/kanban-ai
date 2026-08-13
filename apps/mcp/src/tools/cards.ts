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
    [
      'Lista os cards de um board (GET /cards). Epics trazem `epicStatus` derivado das stories filhas.',
      'Para não estourar o contexto do LLM, esta tool é PAGINADA e RESUMIDA por padrão:',
      'retorna `{ items, nextCursor }` com campos essenciais (id, key, type, title, parentId,',
      'boardColumnId, taskColumnId, position, points, blocked, needsHuman, execState, epicStatus, updatedAt).',
      'Use `nextCursor` para buscar a próxima página; use `get_card` para o detalhe completo de um card.',
      'Filtre com `boardId`, `type` (epic|story|task), `columnId` (casa boardColumnId OU taskColumnId)',
      'e `updatedSince` (ISO 8601). Passe `fields:"full"` para o objeto completo de cada card.',
    ].join(' '),
    {
      boardId: z.string().uuid().optional(),
      type: z.enum(['epic', 'story', 'task']).optional(),
      columnId: z.string().uuid().optional(),
      updatedSince: z
        .string()
        .datetime()
        .optional()
        .describe('Só cards atualizados em/depois deste instante (ISO 8601).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Tamanho da página (default 50).'),
      cursor: z
        .string()
        .uuid()
        .optional()
        .describe('Cursor de continuação (nextCursor da página anterior).'),
      fields: z
        .enum(['full', 'summary'])
        .optional()
        .describe('summary (default): campos essenciais; full: objeto completo.'),
    },
    async (args) =>
      ok(
        await client.get('/cards', {
          boardId: args.boardId,
          type: args.type,
          columnId: args.columnId,
          updatedSince: args.updatedSince,
          // Defaults ergonômicos para LLM: página pequena + projeção resumida.
          limit: args.limit ?? 50,
          cursor: args.cursor,
          fields: args.fields ?? 'summary',
        }),
      ),
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
    'list_card_events',
    [
      'US-OBS2-2 — Lê o LOG TIPADO E APPEND-ONLY de transições de um card',
      '(GET /cards/:id/events). Cada evento é `{ id, cardId, kind, payload, ts }`, com',
      '`kind` ∈ card_created | card_updated | card_moved | story_entered_in_progress |',
      'epic_status_derived. É observabilidade estruturada (coexiste com as `activities`',
      'de texto livre) — NÃO reintroduz DOR/acceptance.',
      'TAIL INCREMENTAL: os eventos vêm em ordem cronológica ASCENDENTE; guarde o `id`',
      'do último e passe-o como `since` na próxima chamada para receber só o que veio',
      'depois. Use `limit` para o tamanho da página (default 100, teto 500).',
    ].join(' '),
    {
      id: z.string().uuid(),
      since: z
        .string()
        .uuid()
        .optional()
        .describe('Cursor: id do último evento já visto. Ausente = desde o começo.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Tamanho da página (default 100).'),
    },
    async (args) =>
      ok(
        await client.get(`/cards/${args.id}/events`, {
          since: args.since,
          limit: args.limit,
        }),
      ),
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
