#!/usr/bin/env node
/**
 * Bootstrap do MCP Server do kanban-ai.
 *
 * Transportes (EP-C / US-C1 — abrir a colmeia a agents EXTERNOS):
 * - **stdio** (default): processo local, comportamento histórico. Sempre ativo
 *   quando `MCP_HTTP_PORT` NÃO está setado.
 * - **Streamable HTTP** (opcional): quando `MCP_HTTP_PORT` está setado, sobe um
 *   listener HTTP nativo (Node `http`) em `MCP_HTTP_HOST` (default `127.0.0.1`)
 *   usando o `StreamableHTTPServerTransport` do SDK. Permite que um cliente MCP
 *   remoto liste/chame as tools por rede. O stdio é PRESERVADO e roda em conjunto
 *   (a menos que `MCP_HTTP_ONLY=true`), para não quebrar o uso local.
 *
 * Config de API-alvo: `KANBAN_API_URL` (default http://localhost:3333) e
 * `KANBAN_API_TOKEN` (opcional). Para escrita na MEMÓRIA com auth ligada, use
 * `KANBAN_API_TOKEN` = um token de `MEMORY_API_TOKENS` (ver US-C2).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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

interface ServerDeps {
  baseUrl: string;
  token?: string;
  wsPath: string;
}

/**
 * Fábrica de um `McpServer` totalmente equipado (tools + resources + streaming).
 * Um servidor por transporte/sessão: o stdio usa uma instância; cada sessão HTTP
 * também ganha a sua (padrão stateful do SDK), isolando estado por cliente.
 */
function buildServer(deps: ServerDeps): McpServer {
  const client = new KanbanClient({ baseUrl: deps.baseUrl, token: deps.token });

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
  registerStreaming(server, { baseUrl: deps.baseUrl, token: deps.token, wsPath: deps.wsPath });

  return server;
}

/** Sobe o transporte stdio (comportamento histórico local). */
async function startStdio(deps: ServerDeps): Promise<void> {
  const server = buildServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr é seguro: stdout é reservado ao protocolo JSON-RPC.
  process.stderr.write(`[kanban-ai-mcp] stdio conectado. API=${deps.baseUrl}\n`);
}

/**
 * Sobe o transporte Streamable HTTP (EP-C/US-C1) num listener HTTP nativo.
 * Padrão stateful: um `StreamableHTTPServerTransport` por sessão, indexado pelo
 * header `mcp-session-id`. Requisições de `initialize` criam a sessão; as demais
 * reaproveitam o transporte existente. Bind default em `127.0.0.1` (não expõe a
 * rede sem intenção explícita).
 */
async function startHttp(deps: ServerDeps, port: number, host: string): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res, transports, deps).catch((e) => {
      process.stderr.write(`[kanban-ai-mcp] erro HTTP: ${(e as Error).message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }),
      );
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  process.stderr.write(
    `[kanban-ai-mcp] Streamable HTTP ouvindo em http://${host}:${port}/mcp. API=${deps.baseUrl}\n`,
  );
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
  deps: ServerDeps,
): Promise<void> {
  const sessionId = firstHeader(req.headers['mcp-session-id']);

  // GET/DELETE (SSE stream / encerramento de sessão): exigem sessão existente.
  if (req.method === 'GET' || req.method === 'DELETE') {
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (!existing) {
      res.writeHead(400).end('Missing or invalid mcp-session-id');
      return;
    }
    await existing.handleRequest(req, res);
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  const body = await readJsonBody(req);

  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    if (!isInitializeRequest(body)) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid session ID provided' },
          id: null,
        }),
      );
      return;
    }
    // Nova sessão: cria transporte stateful + servidor dedicado.
    const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        transports.set(sid, created);
      },
    });
    created.onclose = () => {
      if (created.sessionId) transports.delete(created.sessionId);
    };
    const server = buildServer(deps);
    await server.connect(created);
    await created.handleRequest(req, res, body);
    return;
  }

  await transport.handleRequest(req, res, body);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function main(): Promise<void> {
  const deps: ServerDeps = {
    baseUrl: process.env.KANBAN_API_URL ?? 'http://localhost:3333',
    token: process.env.KANBAN_API_TOKEN,
    wsPath: process.env.KANBAN_WS_PATH ?? '/ws',
  };

  const httpPortRaw = process.env.MCP_HTTP_PORT;
  const httpPort = httpPortRaw ? Number.parseInt(httpPortRaw, 10) : undefined;
  const httpHost = process.env.MCP_HTTP_HOST ?? '127.0.0.1';
  const httpOnly = process.env.MCP_HTTP_ONLY === 'true';

  if (httpPort !== undefined && Number.isFinite(httpPort)) {
    await startHttp(deps, httpPort, httpHost);
    // Preserva o stdio local em conjunto, salvo opt-out explícito.
    if (!httpOnly) {
      await startStdio(deps);
    }
    return;
  }

  // Default histórico: apenas stdio.
  await startStdio(deps);
}

main().catch((e) => {
  process.stderr.write(`[kanban-ai-mcp] falha no bootstrap: ${(e as Error).message}\n`);
  process.exit(1);
});
