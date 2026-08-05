/**
 * Cliente HTTP fino da API NestJS do kanban-ai. Não contém regra de negócio —
 * apenas faz as chamadas REST e traduz erros 4xx/5xx em `McpToolError` com
 * mensagens acionáveis para a AI.
 */
import { actionableError, extractApiMessage, McpToolError, type ApiErrorBody } from './mapping.js';

export interface KanbanClientOptions {
  baseUrl: string;
  token?: string;
}

type Query = Record<string, string | number | boolean | undefined>;

export class KanbanClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(opts: KanbanClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    // Só declara Content-Type quando há corpo: o Fastify da API rejeita
    // (400 "Body cannot be empty") um POST com application/json e sem body
    // — caso de loop_step / loop_start_auto, que o usuário faz pelo front.
    if (hasBody) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const hasBody = opts.body !== undefined;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(hasBody),
        body: hasBody ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new McpToolError(
        `Não foi possível conectar à API em ${this.baseUrl}. A API está de pé? (npm run dev no host). Detalhe: ${(e as Error).message}`,
      );
    }

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;

    if (!res.ok) {
      const apiMsg = extractApiMessage(parsed as ApiErrorBody);
      throw new McpToolError(actionableError(res.status, apiMsg, path), res.status);
    }
    return parsed as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
