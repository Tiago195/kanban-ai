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
├── main.ts        # bootstrap stdio + Streamable HTTP (MCP_HTTP_PORT); KANBAN_API_URL/TOKEN; wiring
├── client.ts      # cliente HTTP tipado da API + tradução de erro
├── mapping.ts     # McpToolError + erros acionáveis
├── streaming.ts   # WS /ws → notifications/resources/updated (chat de tasks)
├── tools/         # 1 arquivo por grupo (board, cards, loop, context, memory, …)
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

## Transporte remoto (Streamable HTTP — EP-C / US-C1)

Além do **stdio** (default, uso local), o `main.ts` expõe o server MCP via
**Streamable HTTP** do SDK (`@modelcontextprotocol/sdk` `^1.30.0` — expõe
`StreamableHTTPServerTransport`) para agents **externos** por rede:

- Ligue setando `MCP_HTTP_PORT`. Host configurável por `MCP_HTTP_HOST` (default
  `127.0.0.1` — não expõe a rede sem intenção). Endpoint: `http://<host>:<port>/mcp`.
- **O stdio é preservado** e roda em conjunto quando `MCP_HTTP_PORT` está setado
  (opt-out via `MCP_HTTP_ONLY=true`). Sem `MCP_HTTP_PORT`, o comportamento é o
  histórico: só stdio.
- Padrão **stateful**: um `StreamableHTTPServerTransport` + `McpServer` por sessão,
  indexado pelo header `mcp-session-id` (retornado no `initialize`). O
  `buildServer()` factory garante que ambos os transportes registram as mesmas
  tools/resources/streaming.

```bash
# sobe HTTP (+ stdio) — smoke: initialize -> tools/list lista as memory_* tools
MCP_HTTP_PORT=39217 node apps/mcp/dist/main.js
```

Guia de integração de um agent externo (fluxo acquire→read→write→release, auth,
contrato de erros, exemplos curl): ver
[docs/how-to-plug-an-agent-into-the-hive.md](../../docs/how-to-plug-an-agent-into-the-hive.md).

## Auth

O plano de controle de **cards/board** v1 não tem auth (ADR-0009). O plano de
controle de **memória**, porém, é protegido (EP-C / US-C2): quando a API tem
`MEMORY_API_TOKENS` configurada, as rotas `/memory/*` exigem
`Authorization: Bearer <token>`. `KANBAN_API_TOKEN` é lido e enviado como
`Authorization: Bearer` quando presente — configure-o com um token de
`MEMORY_API_TOKENS` para que os writes de memória via MCP herdem a
identidade/escopo (`agentId`/`scope`) corretos. Sem `MEMORY_API_TOKENS`, a auth de
memória fica desligada (dev local).
