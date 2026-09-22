import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_GRAPH_TOKEN_BUDGET,
  ProjectGraphQueryService,
} from './project-graph-query.service';
import type { AppConfig } from '../../shared/config/config';

/**
 * US-F1.4 — ProjectGraphQueryService (cliente MCP de leitura do grafo).
 *
 * Testes DETERMINÍSTICOS e OFFLINE: um `http.createServer` local faz o papel
 * do servidor MCP Streamable HTTP do sidecar (handshake initialize →
 * mcp-session-id → notifications/initialized; tools/call respondido como SSE,
 * o formato default do serve_http). Cobrem os pontos frágeis da story:
 *  (a) `project_path` SEMPRE presente na chamada (isolamento por construção);
 *  (b) sidecar fora do ar → retorno tratado, NUNCA lança;
 *  (c) erro de tool devolvido como CONTEÚDO ("Error executing …") → ok:false;
 *  (d) mapeamento de argumentos (camelCase → snake_case) de query_graph e
 *      get_neighbors, incluindo o default de token_budget;
 *  (e) sessão expirada (404) → re-handshake transparente + retry único;
 *  (f) integração desligada / projectId inválido → tratados sem rede.
 */

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
  auth: string | undefined;
  session: string | undefined;
}

/** Sobe um servidor MCP fake (Streamable HTTP mínimo, respostas em SSE). */
async function fakeMcpServer(
  opts: {
    /** Texto de resposta da tool (default: eco do nome). */
    toolText?: (call: RecordedCall) => string;
    /** Responde 404 no PRIMEIRO tools/call (simula sessão expirada). */
    expireFirstCall?: boolean;
  } = {},
): Promise<{
  url: string;
  close: () => Promise<void>;
  calls: RecordedCall[];
  sessions: string[];
}> {
  const calls: RecordedCall[] = [];
  const sessions: string[] = [];
  let expired = opts.expireFirstCall === true;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const msg = JSON.parse(raw) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const auth = req.headers.authorization;
      const session = req.headers['mcp-session-id'] as string | undefined;
      if (msg.method === 'initialize') {
        const sid = `sess-${sessions.length + 1}`;
        sessions.push(sid);
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': sid });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake' } },
          }),
        );
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      // tools/call
      const call: RecordedCall = {
        name: msg.params?.name ?? '',
        args: msg.params?.arguments ?? {},
        auth,
        session,
      };
      if (expired) {
        // Sessão "expirada": o servidor stateful real responde 404.
        expired = false;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Session not found' } }));
        return;
      }
      calls.push(call);
      const text = opts.toolText ? opts.toolText(call) : `ok:${call.name}`;
      // SSE — o formato default (json_response=False) do serve_http.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text }] },
        })}\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    calls,
    sessions,
  };
}

function makeConfig(mcpUrl: string, apiKey = 'test-key'): AppConfig {
  return {
    graphify: { mcpUrl, apiKey, queryTimeoutMs: 2_000 },
  } as unknown as AppConfig;
}

test('US-F1.4: project_path é derivado do projectId e SEMPRE presente na chamada', async () => {
  const srv = await fakeMcpServer();
  try {
    const svc = new ProjectGraphQueryService(makeConfig(srv.url));
    const result = await svc.graphStats('proj-abc123');
    assert.deepEqual(result, { ok: true, text: 'ok:graph_stats' });
    assert.equal(srv.calls.length, 1);
    assert.equal(srv.calls[0].name, 'graph_stats');
    // O isolamento por construção: o path do Project vai em TODA chamada.
    assert.equal(
      srv.calls[0].args.project_path,
      '/home/graphify/.graphify/projects/proj-abc123',
    );
    // Auth + sessão do handshake presentes.
    assert.equal(srv.calls[0].auth, 'Bearer test-key');
    assert.equal(srv.calls[0].session, 'sess-1');
  } finally {
    await srv.close();
  }
});

test('US-F1.4: query_graph mapeia argumentos camelCase → snake_case com default de token_budget', async () => {
  const srv = await fakeMcpServer();
  try {
    const svc = new ProjectGraphQueryService(makeConfig(srv.url));
    await svc.queryGraph('p1', {
      question: 'RealtimeService',
      mode: 'dfs',
      depth: 2,
      contextFilter: ['call'],
    });
    await svc.queryGraph('p1', { question: 'x', tokenBudget: 512 });
    assert.equal(srv.calls[0].name, 'query_graph');
    assert.deepEqual(srv.calls[0].args, {
      question: 'RealtimeService',
      mode: 'dfs',
      depth: 2,
      token_budget: DEFAULT_GRAPH_TOKEN_BUDGET,
      context_filter: ['call'],
      project_path: '/home/graphify/.graphify/projects/p1',
    });
    // token_budget explícito substitui o default.
    assert.equal(srv.calls[1].args.token_budget, 512);
  } finally {
    await srv.close();
  }
});

test('US-F1.4: get_neighbors mapeia relation_filter e token_budget', async () => {
  const srv = await fakeMcpServer();
  try {
    const svc = new ProjectGraphQueryService(makeConfig(srv.url));
    await svc.getNeighbors('p1', { label: 'OrchestratorService', relationFilter: 'call' });
    assert.equal(srv.calls[0].name, 'get_neighbors');
    assert.deepEqual(srv.calls[0].args, {
      label: 'OrchestratorService',
      relation_filter: 'call',
      token_budget: DEFAULT_GRAPH_TOKEN_BUDGET,
      project_path: '/home/graphify/.graphify/projects/p1',
    });
  } finally {
    await srv.close();
  }
});

test('US-F1.4: erro de tool devolvido como CONTEÚDO vira { ok:false } legível (grafo inexistente)', async () => {
  const srv = await fakeMcpServer({
    // O serve responde exceções de handler como texto, não como erro HTTP —
    // é o caso do grafo ainda não construído (graphState != ready).
    toolText: () =>
      "Error executing graph_stats: [Errno 2] No such file or directory: '/home/graphify/.graphify/projects/p1/graphify-out/graph.json'",
  });
  try {
    const svc = new ProjectGraphQueryService(makeConfig(srv.url));
    const result = await svc.graphStats('p1');
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /Error executing graph_stats/);
  } finally {
    await srv.close();
  }
});

test('US-F1.4: sidecar fora do ar NUNCA lança — retorno tratado e legível', async () => {
  // Porta de um servidor recém-fechado: conexão recusada garantida.
  const srv = await fakeMcpServer();
  await srv.close();
  const svc = new ProjectGraphQueryService(makeConfig(srv.url));
  const result = await svc.queryGraph('p1', { question: 'x' });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /inacessível/);
});

test('US-F1.4: sessão expirada (404) → re-handshake e retry transparentes', async () => {
  const srv = await fakeMcpServer({ expireFirstCall: true });
  try {
    const svc = new ProjectGraphQueryService(makeConfig(srv.url));
    const result = await svc.graphStats('p1');
    assert.deepEqual(result, { ok: true, text: 'ok:graph_stats' });
    // Duas sessões: a que "expirou" e a fresca do retry.
    assert.deepEqual(srv.sessions, ['sess-1', 'sess-2']);
    assert.equal(srv.calls[0].session, 'sess-2');
  } finally {
    await srv.close();
  }
});

test('US-F1.4: sem GRAPHIFY_API_KEY a integração fica desligada (zero rede)', async () => {
  const srv = await fakeMcpServer();
  try {
    const svc = new ProjectGraphQueryService(makeConfig(srv.url, ''));
    const result = await svc.graphStats('p1');
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /desligado/);
    assert.equal(srv.calls.length, 0);
    assert.equal(srv.sessions.length, 0);
  } finally {
    await srv.close();
  }
});

test('US-F1.4: projectId fora do formato de segmento único é recusado sem rede', async () => {
  const srv = await fakeMcpServer();
  try {
    const svc = new ProjectGraphQueryService(makeConfig(srv.url));
    const result = await svc.graphStats('../outro-projeto');
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /projectId inválido/);
    assert.equal(srv.sessions.length, 0);
  } finally {
    await srv.close();
  }
});
