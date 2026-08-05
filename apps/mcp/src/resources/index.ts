/**
 * Resources do MCP Server do kanban-ai (fatia F5).
 *
 * Resources são read-only e servem como contexto passivo: injetam o estado do
 * board/card na conversa sem gastar uma tool call — a AI lê o board/card antes
 * de agir. Todos devolvem `application/json`.
 *
 * O registro em `main.ts` fica a cargo de outra fatia; aqui só exportamos a
 * função `registerResources`.
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KanbanClient } from '../client.js';

const DESCRIPTION = 'Injeta contexto sem gastar tool call — a AI lê o board/card antes de agir.';

/** Normaliza uma variável de URI template (que pode vir como string[]) para string. */
function one(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

/** Monta o payload JSON padrão de um resource. */
function jsonContents(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(data),
      },
    ],
  };
}

export function registerResources(server: McpServer, client: KanbanClient): void {
  server.registerResource(
    'board',
    new ResourceTemplate('kanban://board/{id}', { list: undefined }),
    { description: DESCRIPTION, mimeType: 'application/json' },
    async (uri, variables) => {
      const id = one(variables.id);
      return jsonContents(uri, await client.get(`/boards/${id}`));
    },
  );

  server.registerResource(
    'board-cards',
    new ResourceTemplate('kanban://board/{id}/cards', { list: undefined }),
    { description: DESCRIPTION, mimeType: 'application/json' },
    async (uri, variables) => {
      const id = one(variables.id);
      return jsonContents(uri, await client.get('/cards', { boardId: id }));
    },
  );

  server.registerResource(
    'card',
    new ResourceTemplate('kanban://card/{id}', { list: undefined }),
    { description: DESCRIPTION, mimeType: 'application/json' },
    async (uri, variables) => {
      const id = one(variables.id);
      return jsonContents(uri, await client.get(`/cards/${id}`));
    },
  );

  server.registerResource(
    'card-chat',
    new ResourceTemplate('kanban://card/{id}/chat', { list: undefined }),
    { description: DESCRIPTION, mimeType: 'application/json' },
    async (uri, variables) => {
      const id = one(variables.id);
      return jsonContents(uri, await client.get(`/cards/${id}/chat`));
    },
  );

  server.registerResource(
    'models',
    'kanban://models',
    { description: DESCRIPTION, mimeType: 'application/json' },
    async (uri) => jsonContents(uri, await client.get('/agents/models')),
  );
}
