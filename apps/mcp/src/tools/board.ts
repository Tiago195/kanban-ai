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
    'Lista os boards disponíveis com suas colunas. Ponto de partida para descobrir ids de board e coluna.',
    {},
    async () => ok(await client.get('/boards')),
  );

  registerTool(
    server,
    'get_board',
    'Retorna o snapshot completo de um board (colunas, labels, assignees e loop profiles). ' +
      'Use para carregar todo o contexto de um quadro antes de operar sobre ele — ' +
      'ids de colunas, labels e assignees vêm daqui.',
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
