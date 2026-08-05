/**
 * Tradução de erros da API em mensagens acionáveis para a AI. O diferencial de
 * um bom MCP é fazer a AI se autocorrigir: em vez de devolver um 400 cru,
 * devolvemos texto orientado à ação.
 */

/** Erro estruturado devolvido pela API NestJS (ZodValidationPipe / exceptions). */
export interface ApiErrorBody {
  message?: string | string[];
  error?: string;
  statusCode?: number;
}

/**
 * Erro que carrega uma mensagem já pronta para a AII ler. As tools capturam e
 * devolvem `isError: true` com este texto.
 */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** Extrai a mensagem textual de um corpo de erro da API (string ou array Zod). */
export function extractApiMessage(body: ApiErrorBody | undefined): string | undefined {
  if (!body) return undefined;
  if (Array.isArray(body.message)) return body.message.join('; ');
  return body.message ?? body.error;
}

/**
 * Enriquece a mensagem da API com dicas de domínio quando reconhece o padrão do
 * erro — ajuda a AI a se corrigir sem uma nova rodada de tentativa e erro.
 */
export function actionableError(status: number, apiMessage: string | undefined, path: string): string {
  const base = apiMessage ?? `Falha HTTP ${status} em ${path}`;

  if (status === 404) {
    return `${base}. Use list_cards/list_boards para descobrir ids válidos.`;
  }
  if (status === 400) {
    if (/backlog|to do/i.test(base)) {
      return `${base}. Crie a task numa coluna Backlog/To Do (ids via get_board) ou mova a story primeiro.`;
    }
    if (/points|fibonacci|1,2,3,5,8/i.test(base)) {
      return `${base}. story points ∈ {1,2,3,5,8,13}; tasks não têm pontos.`;
    }
    if (/loopType/i.test(base)) {
      return `${base}. Use list_loop_profiles para ver os profiles válidos do board.`;
    }
    return base;
  }
  return base;
}
