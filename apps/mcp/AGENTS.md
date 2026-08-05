# AGENTS.md — apps/mcp (MCP Server)

> Regras locais deste módulo. Leia também o `AGENTS.md` da raiz.

## O que é

`@kanban-ai/mcp` é o **MCP Server** do kanban-ai: um **segundo plano de controle**
que permite a um agent de AI externo (Claude Desktop, Copilot CLI, Cursor, etc.)
operar o board — criar/editar/mover cards, gerir taxonomia e **controlar/observar
o loop engine**.

## Princípios (NUNCA violar)

1. **Cliente HTTP fino.** O MCP NÃO tem regra de negócio nem fala com Postgres.
   Toda invariante vive na API NestJS (`:3333`). O MCP só traduz endpoints em
   *tools* ergonômicas.
2. **Erros acionáveis.** 4xx/5xx da API viram texto que a AI entende e usa para se
   autocorrigir (`src/mapping.ts`). Nunca vaze stack traces crus.
3. **Contratos de `@kanban-ai/shared`.** Enums e tipos vêm do pacote compartilhado.
   Se um contrato mudar, atualize shared + api + este módulo juntos.
4. **stdout é sagrado.** Só JSON-RPC vai no stdout. Logs vão no **stderr**.

## Estrutura

```
apps/mcp/src/
├── main.ts        # bootstrap stdio; lê KANBAN_API_URL / KANBAN_API_TOKEN; wiring
├── client.ts      # cliente HTTP tipado da API + tradução de erro
├── mapping.ts     # McpToolError + erros acionáveis
├── streaming.ts   # WS /ws → notifications/resources/updated (chat de tasks)
├── tools/         # 1 arquivo por grupo (board, cards, loop, context, …)
│   └── util.ts    # registerTool() + ok()/fail()
└── resources/     # board/card como MCP resources (read-only)
```

## Streaming (WS → notificações MCP)

`streaming.ts` abre um WS com a API (`{KANBAN_API_URL}/ws`, path via
`KANBAN_WS_PATH`, default `/ws`) e emite `notifications/resources/updated` para
`kanban://card/{taskId}/chat` ao receber `agent.chunk` / `agent.question` /
`agent.answered` / `iteration.appended`. Só notifica URIs que o cliente
subscreveu (`resources/subscribe`); a capability `resources.subscribe` é
declarada no `main.ts`. Clientes sem subscribe usam o fallback: polling de
`loop_state` + `get_chat`. Reconexão automática com backoff fixo.

## Como adicionar uma tool

Use `registerTool(server, name, description, zodShape, handler)` de `tools/util.ts`.
O helper já encapsula try/catch → `ToolResult` de erro. A descrição deve
documentar as invariantes de domínio proativamente (ex.: "task só em Backlog/To
Do", "não mover epic").

## Rodar / validar

```bash
npm run build -w @kanban-ai/mcp   # tsc → dist
npm run lint  -w @kanban-ai/mcp
# smoke via stdio (API precisa estar de pé):
node apps/mcp/dist/main.js        # fala JSON-RPC no stdin/stdout
```

Config de cliente (ex.: Claude Desktop):

```json
{
  "mcpServers": {
    "kanban-ai": {
      "command": "node",
      "args": ["/caminho/kanban-ai/apps/mcp/dist/main.js"],
      "env": { "KANBAN_API_URL": "http://localhost:3333" }
    }
  }
}
```

## Auth

v1 sem auth (ADR-0009). `KANBAN_API_TOKEN` já é lido e enviado como
`Authorization: Bearer` quando presente — preparado para quando a API ganhar auth.
