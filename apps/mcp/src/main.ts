#!/usr/bin/env node
/**
 * Bootstrap do MCP Server do kanban-ai (transporte stdio).
 *
 * Lê `KANBAN_API_URL` (default http://localhost:3333) e `KANBAN_API_TOKEN`
 * (opcional; a API v1 não tem auth — ADR-0009). Registra tools e resources e
 * conecta o transporte stdio.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KanbanClient } from './client.js';
import { registerBoardTools } from './tools/board.js';
import { registerCardTools } from './tools/cards.js';
import { registerChecklistTools } from './tools/checklist.js';
import { registerTaxonomyTools } from './tools/taxonomy.js';
import { registerContextTools } from './tools/context.js';
import { registerLoopTools } from './tools/loop.js';
import { registerBacklogTools } from './tools/backlog.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerResources } from './resources/index.js';
import { registerStreaming } from './streaming.js';

async function main(): Promise<void> {
  const baseUrl = process.env.KANBAN_API_URL ?? 'http://localhost:3333';
  const token = process.env.KANBAN_API_TOKEN;

  const client = new KanbanClient({ baseUrl, token });

  const server = new McpServer({
    name: 'kanban-ai',
    version: '0.0.0',
  });

  // Declara a capability de subscribe de resources: o streaming WS emite
  // notifications/resources/updated para kanban://card/{taskId}/chat.
  server.server.registerCapabilities({ resources: { subscribe: true } });

  registerBoardTools(server, client);
  registerCardTools(server, client);
  registerChecklistTools(server, client);
  registerTaxonomyTools(server, client);
  registerContextTools(server, client);
  registerLoopTools(server, client);
  registerBacklogTools(server, client);
  registerMemoryTools(server, client);
  registerResources(server, client);

  // Streaming WS → notificações MCP (fase 2). Lê o path configurável do WS.
  const wsPath = process.env.KANBAN_WS_PATH ?? '/ws';
  registerStreaming(server, { baseUrl, token, wsPath });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr é seguro: stdout é reservado ao protocolo JSON-RPC.
  process.stderr.write(`[kanban-ai-mcp] conectado. API=${baseUrl}\n`);
}

main().catch((e) => {
  process.stderr.write(`[kanban-ai-mcp] falha no bootstrap: ${(e as Error).message}\n`);
  process.exit(1);
});
