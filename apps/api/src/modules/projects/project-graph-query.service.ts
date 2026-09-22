import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';

/**
 * EP-F1 / US-F1.4 — Cliente MCP de LEITURA do grafo de conhecimento (graphify).
 *
 * Fala com o servidor MCP do sidecar (Streamable HTTP em
 * `http://127.0.0.1:<GRAPHIFY_MCP_PORT>/mcp`, ADR-0041) e expõe as tools de
 * leitura como métodos TIPADOS. O `projectId` é OBRIGATÓRIO em todos os
 * métodos: o `project_path` (`/home/graphify/.graphify/projects/<projectId>`,
 * ADR-0041 §2) é derivado dele AQUI, nunca pelo chamador — nenhuma consulta
 * consegue cair no "grafo default" do processo por acidente. Isolamento entre
 * Projects por CONSTRUÇÃO, não por disciplina.
 *
 * Postura DEFENSIVA (mesmo espírito do `ProjectGraphService`): NENHUM método
 * lança — uma falha de grafo jamais derruba quem chamou. Os três modos de
 * falha viram `{ ok: false, error }` legível:
 *  - sidecar fora do ar / timeout (fetch rejeita);
 *  - grafo inexistente (`graphState != ready`): o serve responde o erro como
 *    CONTEÚDO de tool ("Error executing <tool>: ..."), não como exceção HTTP;
 *  - sem `GRAPHIFY_API_KEY`: integração DESLIGADA (nenhuma chamada de rede).
 *
 * Protocolo: cliente Streamable HTTP mínimo em `fetch` (estilo da casa —
 * `apps/mcp/src/client.ts` / `project-graph.service.ts`), sem dependência
 * nova. O sidecar roda STATEFUL (sem `--stateless`): fazemos o handshake
 * `initialize` → `mcp-session-id` → `notifications/initialized` uma vez e
 * reaproveitamos a sessão; sessão expirada/sidecar reiniciado = UMA nova
 * tentativa com sessão fresca antes de desistir.
 */

/** Resultado best-effort de qualquer tool de leitura: nunca vira exceção. */
export type GraphQueryResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * US-F1.4 — orçamento default de tokens da resposta das tools que o aceitam.
 * Substitui o corte fixo em 4000 chars (~1000 tokens) do recall antigo:
 * 2000 tokens (~8000 chars) é o default do PRÓPRIO graphify (`serve.py`) — dá
 * o dobro de contexto do recall e mantém a resposta com teto previsível.
 * Passamos SEMPRE explicitamente (nunca dependemos do default do servidor).
 */
export const DEFAULT_GRAPH_TOKEN_BUDGET = 2000;

export interface QueryGraphOptions {
  /** Pergunta em linguagem natural ou palavra-chave (símbolo, arquivo…). */
  question: string;
  /** `bfs` = contexto amplo (default do servidor); `dfs` = traçar um caminho. */
  mode?: 'bfs' | 'dfs';
  /** Profundidade da travessia (1-6; default 3 do servidor). */
  depth?: number;
  /** Orçamento de tokens da resposta. Default `DEFAULT_GRAPH_TOKEN_BUDGET`. */
  tokenBudget?: number;
  /** Filtro explícito de contexto de aresta, ex.: `['call', 'field']`. */
  contextFilter?: string[];
}

export interface GetNeighborsOptions {
  /** Label ou ID do nó. */
  label: string;
  /** Filtro por tipo de relação (substring, ex.: `'call'`). */
  relationFilter?: string;
  /** Orçamento de tokens da resposta. Default `DEFAULT_GRAPH_TOKEN_BUDGET`. */
  tokenBudget?: number;
}

export interface ShortestPathOptions {
  source: string;
  target: string;
  /** Máximo de hops (default 8 do servidor). */
  maxHops?: number;
  /** Ignora a direção das arestas na busca. */
  undirected?: boolean;
}

/**
 * Raiz dos grafos por Project DENTRO do container do sidecar (ADR-0041 §2) —
 * o path é remoto (volume `kanban_graphify_home`), por isso é constante e não
 * config: é o contrato do compose/Dockerfile (HOME do usuário `graphify`),
 * o MESMO layout que o wrapper de build escreve (`GRAPHS_ROOT`).
 */
// US-F5.5 — exportada: o prompt dos agents (orchestrator.buildPrompt) ensina o
// `project_path` das tools MCP com o MESMO contrato, sem duplicar a string.
export const GRAPHIFY_PROJECTS_HOME = '/home/graphify/.graphify/projects';

/** projectId é segmento ÚNICO de path — mesma trust boundary do wrapper de build. */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Versão do protocolo MCP proposta no handshake (a do Streamable HTTP, ADR-0041). */
const MCP_PROTOCOL_VERSION = '2025-03-26';

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: {
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

/** Primeira linha não-vazia — mensagens de erro legíveis, sem stacktrace. */
function firstLine(message: string): string {
  return message.split('\n')[0]?.trim() || message.trim();
}

/**
 * Extrai as mensagens JSON-RPC do corpo da resposta. O Streamable HTTP pode
 * responder `application/json` (mensagem única) ou `text/event-stream`
 * (eventos SSE com `data: {...}`) — o sidecar usa SSE por default.
 */
function parseRpcMessages(body: string, contentType: string): RpcMessage[] {
  if (!body) return [];
  if (contentType.includes('text/event-stream')) {
    const messages: RpcMessage[] = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data) continue;
      try {
        messages.push(JSON.parse(data) as RpcMessage);
      } catch {
        // Evento SSE não-JSON (ping/keepalive) — ignora.
      }
    }
    return messages;
  }
  try {
    const parsed = JSON.parse(body) as RpcMessage | RpcMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

@Injectable()
export class ProjectGraphQueryService {
  private readonly logger = new Logger(ProjectGraphQueryService.name);

  /** Sessão MCP corrente (promise para coalescer handshakes concorrentes). */
  private session: Promise<string> | null = null;
  private nextId = 1;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Integração ligada = `GRAPHIFY_API_KEY` presente (mesma chave do sidecar). */
  private get enabled(): boolean {
    return this.config.graphify.apiKey.length > 0;
  }

  // ── tools de leitura (todas por projectId — isolamento por construção) ────

  /** Busca no grafo por BFS/DFS: nós e arestas relevantes como texto. */
  queryGraph(projectId: string, opts: QueryGraphOptions): Promise<GraphQueryResult> {
    return this.call(projectId, 'query_graph', {
      question: opts.question,
      mode: opts.mode,
      depth: opts.depth,
      token_budget: opts.tokenBudget ?? DEFAULT_GRAPH_TOKEN_BUDGET,
      context_filter: opts.contextFilter,
    });
  }

  /** Detalhes completos de um nó por label ou ID. */
  getNode(projectId: string, label: string): Promise<GraphQueryResult> {
    return this.call(projectId, 'get_node', { label });
  }

  /** Vizinhos diretos de um nó, com detalhes das arestas. */
  getNeighbors(projectId: string, opts: GetNeighborsOptions): Promise<GraphQueryResult> {
    return this.call(projectId, 'get_neighbors', {
      label: opts.label,
      relation_filter: opts.relationFilter,
      token_budget: opts.tokenBudget ?? DEFAULT_GRAPH_TOKEN_BUDGET,
    });
  }

  /** Todos os nós de uma comunidade (0-indexada por tamanho). */
  getCommunity(
    projectId: string,
    communityId: number,
    tokenBudget?: number,
  ): Promise<GraphQueryResult> {
    return this.call(projectId, 'get_community', {
      community_id: communityId,
      token_budget: tokenBudget ?? DEFAULT_GRAPH_TOKEN_BUDGET,
    });
  }

  /** Nós mais conectados — as abstrações centrais do grafo. */
  godNodes(projectId: string, topN?: number): Promise<GraphQueryResult> {
    return this.call(projectId, 'god_nodes', { top_n: topN });
  }

  /** Estatísticas: contagem de nós/arestas/comunidades e confiança. */
  graphStats(projectId: string): Promise<GraphQueryResult> {
    return this.call(projectId, 'graph_stats', {});
  }

  /** Caminho mais curto entre dois conceitos. */
  shortestPath(projectId: string, opts: ShortestPathOptions): Promise<GraphQueryResult> {
    return this.call(projectId, 'shortest_path', {
      source: opts.source,
      target: opts.target,
      max_hops: opts.maxHops,
      undirected: opts.undirected,
    });
  }

  // ── internos ─────────────────────────────────────────────────────────────

  /**
   * Injeta o `project_path` derivado do `projectId` (SEMPRE presente — é o
   * mecanismo de isolamento, ADR-0041 §2) e chama a tool. NUNCA lança.
   */
  private async call(
    projectId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<GraphQueryResult> {
    if (!this.enabled) {
      return { ok: false, error: 'graphify desligado (GRAPHIFY_API_KEY ausente)' };
    }
    if (!PROJECT_ID_RE.test(projectId)) {
      return { ok: false, error: `projectId inválido para consulta de grafo: ${projectId}` };
    }
    const payload = { ...args, project_path: `${GRAPHIFY_PROJECTS_HOME}/${projectId}` };
    try {
      return await this.callTool(tool, payload);
    } catch {
      // Sessão expirada / sidecar reiniciado no meio — UMA tentativa com
      // sessão fresca antes de desistir (a re-init acontece no ensureSession).
      this.session = null;
      try {
        return await this.callTool(tool, payload);
      } catch (err) {
        const error = firstLine(err instanceof Error ? err.message : String(err));
        this.logger.warn(`graphify ${tool}(${projectId}) falhou: ${error}`);
        return { ok: false, error };
      }
    }
  }

  /** `tools/call` na sessão corrente; lança em falha de transporte/sessão. */
  private async callTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<GraphQueryResult> {
    const sessionId = await this.ensureSession();
    const reply = await this.post(
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      },
      sessionId,
    );
    if (!reply) throw new Error('resposta MCP sem mensagem JSON-RPC');
    if (reply.error) {
      // Erro JSON-RPC (tool desconhecida, request inválido…) — retorno
      // tratado, sem retry: repetir não muda o resultado.
      return { ok: false, error: firstLine(reply.error.message ?? 'erro JSON-RPC sem mensagem') };
    }
    const text = (reply.result?.content ?? [])
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim();
    // O serve devolve erro de tool como CONTEÚDO ("Error executing <tool>: …"),
    // não como exceção — ex.: grafo ainda não construído (graphState != ready).
    if (reply.result?.isError || text.startsWith('Error executing ')) {
      return { ok: false, error: firstLine(text || 'tool retornou erro sem mensagem') };
    }
    return { ok: true, text };
  }

  /** Sessão corrente ou handshake novo (coalescido entre chamadas concorrentes). */
  private ensureSession(): Promise<string> {
    this.session ??= this.initialize().catch((err: unknown) => {
      this.session = null;
      throw err;
    });
    return this.session;
  }

  /** Handshake MCP: `initialize` → `mcp-session-id` → `notifications/initialized`. */
  private async initialize(): Promise<string> {
    const reply = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'kanban-ai-api', version: '0.0.0' },
      },
    });
    if (!reply || reply.error) {
      throw new Error(
        `initialize MCP falhou: ${firstLine(reply?.error?.message ?? 'sem resposta JSON-RPC')}`,
      );
    }
    const sessionId = this.lastSessionId ?? '';
    // Servidor stateful só aceita tools/call depois do notifications/initialized.
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    return sessionId;
  }

  /** `mcp-session-id` devolvido pelo último POST (setado pelo initialize). */
  private lastSessionId: string | null = null;

  /**
   * POST único no endpoint MCP. Lança `Error` LEGÍVEL (1 linha) em timeout,
   * conexão recusada ou status não-2xx (inclui 404 de sessão expirada — o
   * chamador re-inicializa). Devolve a mensagem JSON-RPC de resposta (ou
   * `undefined` para notifications, que respondem 202 sem corpo).
   */
  private async post(
    payload: Record<string, unknown>,
    sessionId?: string,
  ): Promise<RpcMessage | undefined> {
    const g = this.config.graphify;
    let res: Response;
    try {
      res = await fetch(g.mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${g.apiKey}`,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(g.queryTimeoutMs),
      });
    } catch (err) {
      const cause =
        err instanceof Error ? (err.name === 'TimeoutError' ? 'timeout' : err.message) : String(err);
      throw new Error(`graphify MCP inacessível em ${g.mcpUrl}: ${cause}`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`graphify MCP HTTP ${res.status}${text ? `: ${firstLine(text)}` : ''}`);
    }
    this.lastSessionId = res.headers.get('mcp-session-id') ?? this.lastSessionId;
    const id = payload.id as number | undefined;
    const messages = parseRpcMessages(text, res.headers.get('content-type') ?? '');
    return (
      messages.find(
        (m) => m.id === id && (m.result !== undefined || m.error !== undefined),
      ) ?? messages.find((m) => m.result !== undefined || m.error !== undefined)
    );
  }
}
