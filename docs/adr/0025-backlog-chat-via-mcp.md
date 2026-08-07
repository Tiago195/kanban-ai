# ADR-0025 — Expor o fluxo de backlog-chat (PO) via MCP

**Status:** Aceito

## Contexto

O `kanban-ai` tem um **plano de controle externo** via MCP
([ADR-0020](0020-mcp-server-second-control-plane.md)): um agent de AI externo
(Claude Desktop, Copilot CLI, Cursor) opera o board — cria/edita/move cards,
gere taxonomia e controla/observa o loop engine.

Até agora, porém, a criação de backlog **conversacional** (falar com o Product
Owner, receber uma proposta de Epic → Stories → Tasks com HITL de descoberta e
materializar tudo no board) era **exclusiva do front-end** `/backlog-chat`. Via
MCP só era possível criar cards **manualmente** (`create_card` um a um), sem o PO
que decompõe uma intenção de alto nível em uma árvore coerente com pontos,
`loopType`, DOD, etc.

Isso é uma lacuna real: um agent externo que queira usar o kanban-ai como
ferramenta para "planejar uma feature" precisa reproduzir na unha a lógica do PO,
em vez de delegá-la ao produto.

### O que já existe

A API NestJS já expõe **todo** o fluxo como REST em
`backlog-chat/sessions` (`backlog-chat.controller.ts`):

| Endpoint | Efeito |
|---|---|
| `POST /backlog-chat/sessions` | cria sessão (`{ boardId }`) |
| `GET  /backlog-chat/sessions?boardId=` | lista sessões (retomar conversa) |
| `GET  /backlog-chat/sessions/:cid/messages` | transcript persistido (F5-safe) |
| `POST /backlog-chat/sessions/:cid/messages` | envia mensagem do humano; dispara turno da AI |
| `POST /backlog-chat/sessions/:cid/answer` | responde pergunta HITL de descoberta |
| `GET  /backlog-chat/sessions/:cid/proposal` | proposta corrente (maior versão) ou `null` |
| `POST /backlog-chat/sessions/:cid/apply` | aprova e materializa Epic + Stories no board |

Ou seja: **não falta feature de domínio na API**. Expor via MCP é puramente
tradução REST → tools, exatamente o papel do MCP como cliente fino.

Um pré-requisito de robustez — o HITL não podia travar o turno do PO
(`bug-backlog-hitl-hang`) — **já foi resolvido e validado** nesta rodada de QA.

## Decisão

**Expor um conjunto mínimo e completo do fluxo de backlog-chat via MCP**, como
tools finas 1:1 com os endpoints REST acima. Nenhuma regra de negócio nova no
MCP; toda invariante (points Fibonacci, task só em Backlog/To Do, epic derivado,
DOD como gate, cascata de model, granularidade da decomposição) continua na API.

Tools adicionadas (grupo `backlog`, `apps/mcp/src/tools/backlog.ts`):

- `start_backlog_chat` → `POST /backlog-chat/sessions`
- `list_backlog_chats` → `GET /backlog-chat/sessions`
- `send_backlog_message` → `POST /…/messages` (envia intenção; a AI responde)
- `get_backlog_messages` → `GET /…/messages` (transcript / polling do turno)
- `answer_backlog_question` → `POST /…/answer` (HITL de descoberta)
- `get_backlog_proposal` → `GET /…/proposal` (revisão corrente da árvore proposta)
- `apply_backlog_proposal` → `POST /…/apply` (materializa Epic + Stories)

### Interação (headless, sem front)

O fluxo é **assíncrono e conversacional**, então as tools são projetadas para um
loop de polling ergonômico ao LLM (sem depender de WS):

1. `start_backlog_chat { boardId }` → `{ id, title }`.
2. `send_backlog_message { cid, text }` → dispara um turno; retorna `{ ok: true }`.
3. Poll `get_backlog_messages { cid }` até aparecer resposta / pergunta HITL /
   proposta. As descrições das tools instruem esse padrão explicitamente.
4. Se houver pergunta HITL: `answer_backlog_question { cid, questionId, answer }`.
5. `get_backlog_proposal { cid }` → inspeciona a árvore (Epic → Stories → Tasks,
   points, loopType). Pode iterar com mais `send_backlog_message`.
6. `apply_backlog_proposal { cid, version }` → cria os cards no board.

### Escopo v1 (limites conscientes)

- **Sem streaming dedicado** para o chat do PO no v1: o cliente MCP faz polling de
  `get_backlog_messages`/`get_backlog_proposal` (mesmo fallback já documentado em
  ADR-0020 para o chat de tasks). Streaming do PO fica para fase 2.
- **Contrato inalterado.** As tools reusam os tipos de `@kanban-ai/shared`
  (`BacklogProposal`, `BacklogChatMessage`, `BacklogChatSessionSummary`,
  `BacklogAppliedCard`) e os endpoints existentes — **nenhuma** mudança em
  `packages/shared` nem na API.

## Consequências

- Um agent externo passa a **planejar features conversando com o PO** e a
  materializar a árvore no board, sem reimplementar a decomposição.
- O MCP ganha um 7º grupo de tools (`backlog`), mantendo o princípio de cliente
  fino: zero regra de negócio, erros acionáveis via `mapping.ts`.
- A superfície de tools cresce em 7; clientes que não usam backlog-chat as ignoram.

## Alternativas consideradas

- **Não expor (manter exclusivo do front)** — rejeitado: deixa o agent externo
  sem o PO, contrariando o propósito do MCP (ADR-0020) de operar o board por
  completo.
- **Expor via um único "mega-tool"** com um verbo `action` — rejeitado: tools
  finas 1:1 com endpoints são mais legíveis para o LLM e alinhadas ao padrão dos
  demais grupos (`board`, `cards`, `loop`).
- **Adicionar streaming do PO já no v1** — adiado: polling resolve o caso de uso
  headless; streaming é otimização, não requisito.
