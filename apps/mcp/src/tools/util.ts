/**
 * Helpers compartilhados pelos módulos de tools: registro tipado e formatação de
 * resultado no formato esperado pelo MCP (`content: [{ type: 'text' }]`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z, ZodRawShape } from 'zod';
import { McpToolError } from '../mapping.js';

/** Resultado de tool no formato do MCP. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Serializa qualquer valor como texto JSON legível para a AI. */
export function ok(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

/** Resultado de erro (a AI lê a mensagem e se autocorrige). */
export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Argumentos inferidos a partir de um Zod raw shape. */
type Args<Shape extends ZodRawShape> = z.objectOutputType<Shape, z.ZodTypeAny>;

/**
 * Registra uma tool encapsulando o try/catch: `McpToolError` (e qualquer erro)
 * vira um `ToolResult` de erro com mensagem acionável, em vez de derrubar o MCP.
 */
export function registerTool<Shape extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (args: Args<Shape>) => Promise<ToolResult>,
): void {
  server.registerTool(
    name,
    { description, inputSchema },
    (async (args: Args<Shape>) => {
      try {
        return await handler(args);
      } catch (e) {
        if (e instanceof McpToolError) return fail(e.message);
        return fail(`Erro inesperado em ${name}: ${(e as Error).message}`);
      }
    }) as never,
  );
}
