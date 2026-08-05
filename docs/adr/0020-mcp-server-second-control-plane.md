# ADR-0020 — MCP Server como segundo plano de controle

**Status:** Aceito

## Contexto

O `kanban-ai` já É um orquestrador de AIs autônomas: o **loop engine** dá `spawn`
na Copilot CLI para executar o trabalho de cada story (ver
[ADR-0016](0016-copilot-cli-subprocess-adapter.md)). Esse é o **plano de
execução** — os assignees internos fazem o trabalho.

Faltava um caminho para um **agent de AI externo** (Claude Desktop, Copilot CLI,
Cursor, qualquer cliente MCP) operar o board de fora: criar/editar/mover cards,
gerir backlog e taxonomia, e **disparar + observar** o loop engine — para usar o
kanban-ai como ferramenta e obter resultados melhores.

## Decisão

Adotar o **Model Context Protocol (MCP)** como **segundo plano de controle**,
implementado no workspace `apps/mcp` (`@kanban-ai/mcp`).

- **Cliente HTTP fino.** O MCP NÃO reimplementa regra de negócio e NÃO fala com o
  Postgres. Toda invariante (task só em Backlog/To Do, epic derivado, pontos
  Fibonacci, DOD como único gate, cascata de model) permanece na API NestJS. O
  MCP apenas traduz endpoints REST em *tools* MCP ergonômicas.
- **Transporte stdio** (padrão de clientes desktop/CLI). Modo HTTP fica para o
  futuro. Lê `KANBAN_API_URL` (default `http://localhost:3333`).
- **Erros acionáveis.** Respostas 4xx/5xx da API são traduzidas em texto que a AI
  entende e usa para se autocorrigir (ex.: "task só em Backlog/To Do; mova a story
  primeiro"). As descrições das tools documentam as invariantes proativamente.
- **Contratos compartilhados.** Os schemas reusam `@kanban-ai/shared`, como web e
  api. O MCP é mais um consumidor do contrato — mudança de contrato atualiza
  shared + api + mcp juntos (regra do AGENTS.md raiz).
- **Resources read-only.** Além de tools, o MCP expõe `kanban://board/{id}`,
  `kanban://card/{id}`, `kanban://card/{id}/chat` e `kanban://models` como
  *resources*, para a AI ler contexto sem gastar tool call.
- **Streaming via WS (fase 2).** O MCP pode abrir o WS `/ws` da API e emitir
  `notifications/resources/updated` quando chegam `agent.chunk`/`agent.question`/
  `iteration.appended`; clientes sem subscribe usam polling
  (`loop_state`/`get_chat`).
- **Sem auth no v1** ([ADR-0009](0009-no-auth-v1.md)). `KANBAN_API_TOKEN` já é
  lido e enviado como `Authorization: Bearer` quando presente, preparando o
  terreno para quando a API ganhar auth.

### Pré-requisito de API

A única feature **essencial** de domínio que a API não expunha era definir o
`loopType` da task (qual loop profile o agent executa: feature/bug/refactor/
custom). Ela foi exposta em `POST /cards` e `PATCH /cards/:id` **antes** de
construir o MCP — o MCP é cliente fino e não pode expor o que a API não tem.

## Consequências

- O kanban-ai passa a ter **dois planos complementares**: execução (loop engine
  interno) e controle (agent externo via MCP).
- Novo workspace executável `apps/mcp` com ciclo de vida próprio, como `api`.
- A API continua a fonte única de verdade das invariantes; o MCP não pode
  divergir dela.
- Conveniências não-essenciais (Column CRUD, Board create/rename, `get_iterations`
  isolado) ficam fora do v1 — o MCP opera o board por completo sem elas.

## Alternativas consideradas

- **Expor tudo via web UI apenas** — não permite orquestração por agent externo.
- **MCP falando direto com o Postgres** — rejeitado: duplicaria regra de negócio e
  quebraria as invariantes centralizadas na API.
- **`packages/mcp`** — rejeitado em favor de `apps/mcp`, pois é um executável.
