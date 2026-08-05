# docs/mcp-server-plan.md — Plano do MCP Server do kanban-ai

Este documento planeja um **MCP Server** (Model Context Protocol) para o
`kanban-ai`, cujo objetivo é permitir que **um agent de AI externo** (Claude
Desktop, Copilot CLI, Cursor, qualquer cliente MCP) opere o board de forma
autônoma: criar / editar / mover cards, gerir o backlog, disparar e acompanhar o
loop engine — **usando a ferramenta para obter resultados melhores**.

> Meta-observação: o produto já É um orquestrador de AIs autônomas (o loop engine
> spawna a Copilot CLI). O MCP adiciona um **segundo plano de controle**: um agent
> externo que manipula o board como um "gerente de projeto AI", enquanto os
> assignees internos executam o trabalho. Os dois planos são complementares.

---

## 1. Objetivo e princípios

1. **Cobertura total das features da API** (mapa na §3), traduzidas em *tools* MCP
   ergonômicas para uma AI — nomes verbais, descrições ricas, schemas de entrada
   validados.
2. **Type-safe end-to-end.** Os schemas das tools reusam os contratos de
   `packages/shared` (`CardType`, `StoryPoints`, `ValidationStrategy`, DTOs). O MCP
   é mais um consumidor do contrato compartilhado, como web e api.
3. **Guard-rails de domínio expostos, não escondidos.** As invariantes (task só em
   Backlog/To Do, epic derivado, pontos Fibonacci, DOD como único gate) viram
   descrições de tool + mensagens de erro acionáveis, para a AI se autocorrigir.
4. **Não reimplementar regra de negócio.** O MCP é um **cliente HTTP fino** da API
   NestJS existente. Toda a lógica (transações, cascata de model, derivação de
   epic) continua na API. O MCP nunca fala direto com o Postgres.
5. **Observabilidade do loop.** O agent externo precisa não só disparar o loop, mas
   **ler o estado e o transcript** para decidir o próximo passo (HITL, retomar,
   parar).

---

## 2. Arquitetura

```
┌────────────────────┐   MCP (stdio/JSON-RPC)   ┌──────────────────┐   HTTP    ┌─────────────┐
│  Agent externo     │ ───────────────────────► │  kanban-ai-mcp   │ ────────► │  API NestJS │
│ (Claude/Copilot/…) │ ◄─────────────────────── │  (MCP Server)    │ ◄──────── │  :3333      │
└────────────────────┘      tools / resources    └──────────────────┘   REST    └─────────────┘
                                                          │  (opcional)
                                                          │  WS /ws  ──────────► stream do loop
                                                          ▼
                                                   resources/notifications
```

- **Transporte:** `stdio` (padrão para clientes desktop/CLI). Um modo `--http`
  (Streamable HTTP) pode ser adicionado depois para uso remoto.
- **Backend:** o MCP recebe `KANBAN_API_URL` (default `http://localhost:3333`) e
  faz chamadas REST. Sem estado próprio.
- **SDK:** `@modelcontextprotocol/sdk` (TypeScript), coerente com a stack do
  monorepo. Novo workspace `packages/mcp` (ou `apps/mcp`).

### Localização proposta no monorepo

```
kanban-ai/
├── apps/
│   ├── web/
│   ├── api/
│   └── mcp/              # ← NOVO: MCP server (Node + @modelcontextprotocol/sdk)
│       ├── src/
│       │   ├── main.ts            # bootstrap stdio; lê KANBAN_API_URL
│       │   ├── client.ts          # cliente HTTP fino da API (fetch tipado)
│       │   ├── tools/             # 1 arquivo por grupo de tools (cards, loop, board…)
│       │   ├── resources/         # board/card como MCP resources (read)
│       │   └── mapping.ts         # helpers de erro/validação → texto p/ a AI
│       ├── package.json
│       └── AGENTS.md
```

> `apps/mcp` (não `packages/`) porque é um **executável** com ciclo de vida
> próprio, como `api`. Reusa `@kanban-ai/shared` para os tipos.

---

## 3. Mapa: endpoints da API → tools MCP

A API expõe **41 endpoints** (sem prefixo global, porta 3333). Agrupamento das tools:

### 3.1 Grupo `board` (leitura de contexto)

| Tool MCP | Endpoint | Uso pela AI |
|---|---|---|
| `list_boards` | `GET /boards` | Descobrir boards e colunas disponíveis |
| `get_board` | `GET /boards/:id` | Snapshot completo (colunas, labels, assignees, profiles) — **contexto inicial** |
| `set_board_model` | `PATCH /boards/:id/model` | Definir modelo default do quadro (raiz da cascata) |
| `list_models` | `GET /agents/models` | Listar modelos de AI disponíveis + default |

### 3.2 Grupo `cards` (o coração — criar/editar/mover)

| Tool MCP | Endpoint | Notas de domínio embutidas na descrição |
|---|---|---|
| `list_cards` | `GET /cards?boardId=` | epics trazem `epicStatus` derivado |
| `get_card` | `GET /cards/:id` | detalhe com dod, flows, iterations, deps |
| `create_card` | `POST /cards` | `type∈{epic,story,task}`; **task só em Backlog/To Do**; points Fibonacci |
| `update_card` | `PATCH /cards/:id` | title/description/points/blocked + aiContext (`aiSummary`,`aiProject`,`aiNotes`) + `model` |
| `move_card` | `PATCH /cards/:id/move` | **nunca mover epic** (derivado); mover story→In Progress dispara o loop |
| `delete_card` | `DELETE /cards/:id` | cascata para descendentes |

### 3.3 Grupo `context` (memória/histórico — chave p/ qualidade da AI)

Estes dados são o **contexto histórico** que faz a AI decidir melhor: resumos de
handoff, log de atividade e o grafo de dependências entre tasks. Endpoints
adicionados à API para viabilizar o MCP (antes só eram legíveis embutidos).

| Tool MCP | Endpoint | Uso pela AI |
|---|---|---|
| `list_comments` | `GET /cards/:id/comments` | ler handoffs/resumos anteriores |
| `add_comment` | `POST /cards/:id/comments` (`text`, `authorId?`) | deixar handoff/resumo p/ a próxima iteração |
| `add_dependency` | `POST /cards/:id/dependencies` (`dependsOnId`) | montar o grafo: esta task espera outra terminar |
| `remove_dependency` | `DELETE /cards/:id/dependencies/:dependsOnId` | desfazer dependência |

> `activities` e `derivedFrom` permanecem **read-only** (via `get_card`/resource):
> o log de atividade e a origem de uma task derivada são gerados só pelo loop
> engine — escrevê-los manualmente corromperia a integridade do histórico.

### 3.4 Grupo `checklist` (DOD — único gate)

| Tool MCP | Endpoint |
|---|---|
| `add_dod_item` | `POST /cards/:id/dod` |
| `update_dod_item` | `PATCH /dod/:itemId` (`text?`, `done?`) |
| `remove_dod_item` | `DELETE /dod/:itemId` |

### 3.5 Grupo `taxonomy` (labels, assignees, flows, loop profiles)

| Tool MCP | Endpoint |
|---|---|
| `list_labels` / `create_label` / `update_label` / `delete_label` | `/labels` CRUD |
| `attach_label` / `detach_label` | `POST /cards/:id/labels`, `DELETE /cards/:id/labels/:labelId` |
| `list_assignees` / `create_assignee` / `delete_assignee` | `/assignees` (assignee = agent autônomo: `name`,`model?`,`instructions`) |
| `attach_assignee` / `detach_assignee` | `/cards/:id/assignees[...]` |
| `add_flow` / `remove_flow` | `POST /cards/:id/flows`, `DELETE /flows/:flowId` |
| `list_loop_profiles` / `create_loop_profile` / `update_loop_profile` / `delete_loop_profile` | `/loop-profiles` |

### 3.6 Grupo `loop` (AI Engine — controlar e observar a execução)

| Tool MCP | Endpoint | Observação |
|---|---|---|
| `loop_state` | `GET /cards/:id/loop/state` | id = **story** |
| `loop_step` | `POST /cards/:id/loop/step` | executa 1 iteração manual |
| `loop_start_auto` | `POST /cards/:id/loop/auto/start` | inicia auto-play server-side |
| `loop_stop_auto` | `POST /cards/:id/loop/auto/stop` | `mode: graceful\|hard` |
| `loop_answer` | `POST /cards/:id/loop/answer` | **HITL**: responde pergunta (`questionId`,`answer`) |
| `get_chat` | `GET /cards/:id/chat` | id = **task**; transcript persistido |

> **HITL — quick replies:** a pergunta do agent (`AgentMessage` role=ai) pode
> carregar `options` (respostas rápidas). `GET /chat` **já serializa `options` e
> `questionId`** (ai-engine.controller L100–102) — a AI externa lê essas `options`
> e responde uma opção válida via `loop_answer`, em vez de texto livre às cegas.

> **Padrão para o loop:** o agent externo tipicamente faz
> `move_card`(story→In Progress) → `loop_state`(poll) → se pergunta pendente,
> `loop_answer` (usando `options` quando houver) → `get_chat` para inspecionar →
> `loop_stop_auto` ao concluir.

### 3.7 `health` (diagnóstico)

| Tool MCP | Endpoint |
|---|---|
| `health_check` | `GET /health` — usado internamente para validar conectividade no boot |

**Total: ~39 tools** cobrindo 100% dos endpoints de mutação e leitura.

---

## 4. MCP Resources (leitura como contexto, não como ação)

Além de tools, o MCP deve expor **resources** — o cliente MCP os injeta como
contexto sem "gastar" uma chamada de tool:

| Resource URI | Conteúdo |
|---|---|
| `kanban://board/{id}` | snapshot do board (`GET /boards/:id`) |
| `kanban://board/{id}/cards` | lista de cards do board |
| `kanban://card/{id}` | detalhe de um card |
| `kanban://card/{id}/chat` | transcript de uma task |
| `kanban://models` | catálogo de modelos |

Vantagem: uma AI pode "ler o board" via resource antes de agir, reduzindo tool
calls e melhorando a qualidade das decisões (o objetivo do pedido).

---

## 5. Schemas de entrada (reuso de `packages/shared`)

As tools usam Zod (a API já valida com Zod; o MCP pré-valida para dar erro cedo,
em linguagem que a AI entende). Os enums vêm de `@kanban-ai/shared`:

```ts
// exemplo: create_card
{
  boardId: z.string().uuid(),
  type: z.enum(['epic', 'story', 'task']),
  title: z.string().min(1),
  description: z.string().optional(),
  parentId: z.string().uuid().optional(),   // story→epic, task→story
  points: z.union([z.literal(1),z.literal(2),z.literal(3),
                   z.literal(5),z.literal(8),z.literal(13)]).optional(),
  columnId: z.string().uuid().optional(),   // task: deve ser Backlog/To Do
}
```

Os schemas espelham `apps/api/src/modules/cards/cards.schema.ts` — **fonte da
verdade compartilhada**. Se um contrato mudar, atualiza-se `shared` e ambos os
lados (regra do AGENTS.md raiz).

---

## 6. Tratamento de erros → mensagens acionáveis

O diferencial de um bom MCP é **fazer a AI se autocorrigir**. O cliente HTTP
traduz respostas 4xx da API em texto orientado à ação:

| Situação | Mensagem devolvida à AI |
|---|---|
| Task fora de Backlog/To Do (400) | "Tasks só podem ser criadas em Backlog ou To Do. Crie na coluna 'To Do' (id=…) ou mova a story primeiro." |
| Tentar mover epic | Tool `move_card` **rejeita `type=epic` no schema**, com dica: "Epics são derivados das stories; mova as stories filhas." |
| Points inválido | "points deve ser um de 1,2,3,5,8,13 (Fibonacci)." |
| `loop_step` em não-story (404) | "O loop opera sobre stories. Informe o id de uma story." |
| Card inexistente (404) | "Card {id} não existe. Use list_cards para ver os ids válidos." |

As descrições das tools também documentam as invariantes **proativamente**, para
a AI acertar de primeira.

---

## 7. Streaming do loop (opcional, fase 2)

O loop engine emite eventos WS (`agent.chunk`, `agent.question`, `iteration.appended`).
Duas abordagens para o agent externo acompanhar em tempo real:

1. **Polling (v1, simples):** `loop_state` + `get_chat` em intervalo. Suficiente
   para a maioria dos clientes MCP (que são request/response).
2. **MCP notifications (v2):** o MCP abre um WS `/ws` com a API e emite
   `notifications/resources/updated` para `kanban://card/{taskId}/chat` quando
   chegam chunks — clientes que suportam subscribe recebem push. Requer o cliente
   suportar subscriptions.

Recomendação: **v1 com polling**, pois clientes MCP são majoritariamente
síncronos e o HITL já funciona bem por poll (`loop_state` → `loop_answer`).

---

## 8. Autenticação

A API v1 **não tem auth** ([ADR-0009](adr/0009-no-auth-v1.md)) e roda em
`localhost`. O MCP herda isso: sem credenciais no v1. Quando a API ganhar auth, o
MCP passará um token via env (`KANBAN_API_TOKEN`) no header `Authorization`.

---

## 9. Configuração de exemplo (cliente MCP)

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

Pré-requisito: a API precisa estar de pé (`npm run dev` no host — ver
[ADR-0019](adr/0019-api-runs-on-host-not-docker.md)).

---

## 10. Roadmap de implementação

> **Status de entrega (v1):** ✅ **F0–F6 entregues e verificados** (build + lint
> verdes; smoke stdio lista 42 tools + 5 resources; streaming WS validado
> end-to-end). ADR-0020 registra a decisão. As conveniências O1–O3 (a "F7" de
> conveniências abaixo) permanecem **fora do v1**, conforme escopo aprovado.

| Fatia | Entrega | Status |
|---|---|---|
| **F0 — Pré-requisito de API (ANTES do MCP)** | Implementar **B1** (§10.2): expor `loopType` em `create_card`/`update_card` (schema Zod + service + validação contra profiles). **Bloqueia a F1** — é a única feature essencial que a API não expõe. | ✅ entregue |
| **F1 — Scaffolding** | `apps/mcp` como workspace; `@modelcontextprotocol/sdk`; `client.ts` (fetch tipado + tradução de erro); tool `health_check` + `list_boards`; smoke via cliente MCP. | ✅ entregue |
| **F2 — CRUD de cards** | `list_cards`, `get_card`, `create_card` (incl. `loopType`), `update_card` (incl. `loopType`), `move_card`, `delete_card` + guard-rails no schema. | ✅ entregue |
| **F3 — DOD + taxonomia** | grupos `board`, `checklist` e `taxonomy` completos. | ✅ entregue |
| **F4 — Loop engine** | grupo `loop`/`context` completo (state/step/auto/answer/metrics/chat + comments/deps). | ✅ entregue |
| **F5 — Resources** | `kanban://board`, `kanban://board/cards`, `kanban://card`, `kanban://card/chat`, `kanban://models`. | ✅ entregue |
| **F6 — Streaming** | `notifications/resources/updated` via WS (`/ws`) para `kanban://card/{taskId}/chat`; capability `resources.subscribe`; fallback por polling. | ✅ entregue |
| **F7 — Conveniências (opcional, depende de API)** | Após O1–O3 (§10.3): `get_iterations`, column management (WIP, protected), board create/rename. **Não bloqueia o MCP.** | ⏳ fora do v1 |

Cada fatia mantém `npm run build` e `npm run lint` verdes (não quebrar a fundação).

---

## 10.1 Auditoria de cobertura

> ⚠️ **Duas coberturas distintas.** Contar endpoints prova só que todo *endpoint*
> virou tool. Não prova que toda *feature de domínio* está exposta — uma feature
> pode viver no Prisma schema, no loop-engine ou nos eventos WS **sem rota HTTP**.
> Esta auditoria foi refeita cruzando os **15 modelos Prisma**, os **eventos WS** e
> os métodos públicos do `orchestrator`, não só os controllers.

### A) Cobertura de endpoints REST: **100% (41/41)**

Todo endpoint HTTP existente tem tool correspondente (matriz completa nas §3.1–3.7).

### B) Cobertura de features de domínio

> **Análise refeita corretamente** partindo do conjunto de features que a **API
> NÃO expõe** (não das que expõe). Cruzando os 15 modelos Prisma, os schemas de
> `create`/`update` e o loop-engine, há **uma feature essencial sem endpoint**:
> **definir/alterar o `loopType` da task**. As demais features não-expostas são
> conveniências. (Ler handoff/iterations e `options` do HITL **já são expostos** —
> via `GET /cards/:id` e `GET /chat` — então **não** entram na lista de "não
> expõe".)

Matriz das features que a **API não expõe hoje**, classificada por essencialidade:

| Feature não-exposta | Modelo | Como é setada hoje | Essencial? | Impacto |
|---|---|---|---|---|
| **Definir/alterar `loopType` da task** (`feature`\|`bug`\|`refactor`\|custom) | `Card.loopType` | **só seed + interno** (`create`/`update` **não** expõem) | 🔴 **SIM** | muda as **fases da iteração** e a **estratégia de validação** do agent (ex.: `bug` → fase `reproduce` + `bug-gone+regression`). Sem isso, toda task criada pela AI cai no `__default` e valida errado. **Ataca direto o objetivo do MCP (resultados melhores).** |
| Criar/editar/mover/deletar **Column** (`wipLimit`,`protected`) | `Column` | nenhum (`// TODO`) | 🟡 não | colunas vêm do **seed**; task-columns são `protected`; AI **move cards** entre as existentes (ids via `get_board`). Gerir WIP é *tuning*. |
| Criar/renomear **Board** | `Board` | nenhum (`// TODO`, só `PATCH /model`) | 🟡 não | board já existe (seed); AI opera *dentro* de um board. Setup. |
| Ler `Iteration`/handoff **isolado** | `Iteration` | **já vem** em `GET /cards/:id` | ⚪ já exposto | endpoint dedicado seria só otimização |
| Escrita de `Activity`/`Iteration`/`derivedFrom` | vários | só orchestrator | ⚪ não | read-only por integridade |

## 10.2 Pré-requisito de API — DESENVOLVER ANTES DO MCP

> **Regra do plano:** *toda feature essencial que a API não expõe deve ser
> implementada na API **antes** de o MCP ser construído* — o MCP é um cliente HTTP
> fino e não pode expor o que não existe.

**Bloqueia o início do MCP (F0 — antes da F1):**

| # | Endpoint a criar na API | Tool MCP que habilita | Por que é essencial |
|---|---|---|---|
| **B1** | Expor `loopType` em `POST /cards` (task) e `PATCH /cards/:id` — validar contra profiles builtin + `LoopProfile` do board | campo `loopType` em `create_card`/`update_card` | define qual loop profile o agent executa; sem isso a AI não escolhe a estratégia (feature/bug/refactor) e o resultado degrada |

> Contrato compartilhado: `loopType` já existe em `packages/shared/domain.ts` e no
> Prisma — o dev é adicionar o campo aos schemas Zod `createCardSchema`/
> `updateCardSchema` e ao service (com validação). Alinha com a regra do AGENTS.md
> raiz (atualizar `shared` + api juntos).

## 10.3 Melhorias futuras (opcionais — NÃO bloqueiam o MCP)

Nenhum item aqui é essencial: o MCP opera o board por completo sem eles.

| # | Endpoint a criar na API | Tool habilitada | Prioridade | Por que NÃO é essencial |
|---|---|---|---|---|
| O1 | `GET /cards/:id/iterations` | `get_iterations` | baixa | handoff **já vem** em `get_card` |
| O2 | `POST/PATCH/DELETE /columns` + `PATCH /columns/:id/move` | `create_column`,`update_column` (WIP), `move_column`,`delete_column` | baixa | colunas vêm do seed e são `protected` |
| O3 | `POST /boards`, `PATCH /boards/:id` | `create_board`,`update_board` | baixa | board já existe; criar novos é setup |

> **Nota histórica:** endpoints de `comments` (GET/POST) e `dependencies`
> (POST/DELETE) foram implementados nesta linha de trabalho — por isso aparecem
> como cobertos em §3.3.

## 11. Decisões em aberto (para revisão humana)

1. **`apps/mcp` vs `packages/mcp`** — proposto `apps/mcp` (é executável). Confirmar.
2. **Escopo v1** — este plano assume **cobertura completa incl. loop engine**
   (alinhado ao pedido "criar/editar/mover tudo" + "ajudar a AI a ter resultados
   melhores"). Se preferir começar só com board management, cortar §3.6 na F1.
3. **Streaming** — proposto polling no v1; WS notifications adiado.
4. **Pré-requisito de API antes do MCP (F0/B1)** — a única feature **essencial**
   que a API não expõe é **definir o `loopType` da task**; deve ser implementada
   na API **antes** de construir o MCP (§10.2). As demais features não-expostas
   (column/board management, `get_iterations` isolado) são **conveniências
   opcionais** (§10.3, O1–O3 / F7) — decidir se entram num v1.1 ou ficam adiadas.
5. **ADR** — recomenda-se registrar um `ADR-0020 — MCP como segundo plano de
   controle` ao iniciar a implementação.
