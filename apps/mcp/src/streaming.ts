/**
 * Streaming WS → notificações MCP.
 *
 * Abre um WebSocket com a API (`{baseUrl}/ws`) e, ao receber eventos do loop
 * engine que alteram o "diário"/chat de uma task (`agent.chunk`,
 * `agent.question`, `agent.answered`, `iteration.appended`), emite
 * `notifications/resources/updated` para o resource `kanban://card/{taskId}/chat`.
 *
 * Só emite para URIs que o cliente MCP realmente subscreveu (rastreadas via os
 * handlers `subscribe`/`unsubscribe` registrados aqui). Clientes sem subscribe
 * usam o fallback documentado: polling de `loop_state` + `get_chat`.
 *
 * Princípio do módulo: cliente fino. Este arquivo NÃO tem regra de negócio — só
 * traduz eventos WS da API em notificações MCP.
 */
import WebSocket from 'ws';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerEvent } from '@kanban-ai/shared';

/** Constrói a URI do resource de chat de uma task. */
function chatUri(taskId: string): string {
  return `kanban://card/${taskId}/chat`;
}

/** Deriva a URL do WS a partir da baseUrl HTTP da API. */
function toWsUrl(baseUrl: string, wsPath: string): string {
  const url = new URL(wsPath, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Liga o streaming WS ao servidor MCP. Idempotente por processo.
 *
 * @returns função de cleanup que fecha o socket e cancela reconexões.
 */
export function registerStreaming(
  server: McpServer,
  opts: { baseUrl: string; token?: string; wsPath?: string },
): () => void {
  // URIs de chat que o cliente subscreveu. Só emitimos updated para estas.
  const subscribed = new Set<string>();

  // Registra os handlers de subscribe/unsubscribe no server low-level. A
  // capability `resources.subscribe` é declarada no main.ts (registerCapabilities).
  server.server.setRequestHandler(SubscribeRequestSchema, (req) => {
    subscribed.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  const wsUrl = toWsUrl(opts.baseUrl, opts.wsPath ?? '/ws');
  const headers = opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined;

  let socket: WebSocket | undefined;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const notify = (taskId: string): void => {
    const uri = chatUri(taskId);
    if (!subscribed.has(uri)) return;
    // sendResourceUpdated é assíncrono; erros de transporte não devem derrubar o WS.
    void server.server.sendResourceUpdated({ uri }).catch((e: unknown) => {
      process.stderr.write(`[kanban-ai-mcp] falha ao notificar ${uri}: ${(e as Error).message}\n`);
    });
  };

  const handleEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case 'agent.chunk':
      case 'agent.question':
      case 'iteration.appended':
        notify(event.taskId);
        break;
      case 'agent.answered':
        notify(event.taskId);
        break;
      default:
        // demais eventos não alteram o resource de chat — ignorados.
        break;
    }
  };

  const connect = (): void => {
    if (closed) return;
    socket = new WebSocket(wsUrl, headers ? { headers } : undefined);

    socket.on('open', () => {
      process.stderr.write(`[kanban-ai-mcp] WS conectado em ${wsUrl}\n`);
    });

    socket.on('message', (data: WebSocket.RawData) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(data.toString()) as ServerEvent;
      } catch {
        return; // mensagem não-JSON: ignora.
      }
      if (event && typeof event.type === 'string') handleEvent(event);
    });

    socket.on('close', () => {
      if (closed) return;
      // reconexão simples com backoff fixo; a API pode ter reiniciado.
      reconnectTimer = setTimeout(connect, 2_000);
    });

    socket.on('error', (e: Error) => {
      process.stderr.write(`[kanban-ai-mcp] WS erro: ${e.message}\n`);
      // 'close' dispara em seguida e agenda a reconexão.
    });
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
