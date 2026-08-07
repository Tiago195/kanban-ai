/**
 * Grupo `board` — leitura de contexto do quadro. Na F1 registramos apenas
 * `health_check` e `list_boards`; as demais (get_board, set_board_model,
 * list_models) entram na F3.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KanbanClient } from '../client.js';
import { ok, registerTool } from './util.js';
import { z } from 'zod';

export function registerBoardTools(server: McpServer, client: KanbanClient): void {
  registerTool(
    server,
    'health_check',
    'Verifica a conectividade com a API do kanban-ai (GET /health). Use no início para confirmar que a API está de pé.',
    {},
    async () => ok(await client.get('/health')),
  );

  registerTool(
    server,
    'list_boards',
    'Lista os boards disponíveis com suas colunas. Ponto de partida para descobrir ids de board e coluna. ' +
      'IMPORTANTE: cada board tem DUAS raias de colunas distinguidas pela flag `isTaskColumn`: ' +
      'colunas de board/story (`isTaskColumn:false` — Backlog, To Do, In Progress, Review, Done) e ' +
      'colunas de task (`isTaskColumn:true` — To Do, In Progress, Review, Done, sem Backlog). ' +
      'Títulos como "To Do"/"Done" aparecem em AMBAS as raias com ids diferentes — isso NÃO é duplicação, ' +
      'é o modelo de duas raias. Sempre filtre por `isTaskColumn` ao escolher a coluna certa: ' +
      'stories usam `boardColumnId` (raia de board), tasks usam `taskColumnId` (raia de task).',
    {},
    async () => ok(await client.get('/boards')),
  );

  registerTool(
    server,
    'get_board',
    'Retorna o snapshot completo de um board (colunas, labels, assignees e loop profiles). ' +
      'Use para carregar todo o contexto de um quadro antes de operar sobre ele — ' +
      'ids de colunas, labels e assignees vêm daqui. ' +
      'IMPORTANTE: o board expõe DUAS raias de colunas distinguidas pela flag `isTaskColumn`: ' +
      'raia de board/story (`isTaskColumn:false`: Backlog, To Do, In Progress, Review, Done) e ' +
      'raia de task (`isTaskColumn:true`: To Do, In Progress, Review, Done). ' +
      'Um título como "In Progress" aparece em ambas as raias com ids diferentes — NÃO é duplicação. ' +
      'Ao mover: stories vão para uma coluna com `isTaskColumn:false` (via `boardColumnId`), ' +
      'tasks vão para uma coluna com `isTaskColumn:true` (via `taskColumnId`).',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.get(`/boards/${id}`)),
  );

  registerTool(
    server,
    'set_board_model',
    'Define (ou limpa) o modelo de AI padrão do board (PATCH /boards/:id/model). ' +
      'Envie `defaultModel` com o nome do modelo para definir, ou `null` para limpar e ' +
      'voltar ao modelo global. Esse modelo é herdado por assignees que não definem o próprio.',
    { id: z.string().uuid(), defaultModel: z.string().min(1).nullable() },
    async ({ id, defaultModel }) =>
      ok(await client.patch(`/boards/${id}/model`, { defaultModel })),
  );

  registerTool(
    server,
    'list_models',
    'Lista os modelos de AI disponíveis para os agents autônomos e indica o modelo default. ' +
      'Use antes de set_board_model ou create_assignee para escolher um modelo válido.',
    {},
    async () => ok(await client.get('/agents/models')),
  );
}
