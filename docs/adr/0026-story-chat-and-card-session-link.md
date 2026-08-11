# ADR-0026 — Chat da story no board + rastreio `Card ↔ BacklogChatSession`

**Status:** Aceito

**Relacionado:** [ADR-0023](0023-backlog-chat-story-threads.md) (threads por story
no backlog-chat, convenção de `channel`), [ADR-0024](0024-backlog-chat-rich-stories-and-draft-tasks.md)
(stories ricas + draft tasks materializadas no `apply`).

## Contexto

O backlog-chat (persona Product Owner) conduz a criação de um Epic + Stories
(+ draft tasks) e, ao aprovar, materializa tudo em cards no board. Depois disso,
porém, a story vive **no board** e o usuário ainda precisa **criar/refinar
tasks** — hoje só manualmente (botão "+ Task").

Faltavam duas coisas:

1. **Um "chat da story" no board**, no mesmo espírito do backlog-chat (transcript
   + threads por task), para o usuário decompor a story em tasks conversando com
   a IA — sem voltar ao backlog-chat.
2. **Um rastreio explícito de qual sessão de chat originou cada card.** O
   `schema.prisma` **não tinha** vínculo entre `Card` e `BacklogChatSession`, o
   que impedia (a) reusar a conversa original ao abrir o chat de uma story vinda
   do backlog e (b) diagnosticar/consertar o bug das "tasks fantasma" (sugestões
   que nunca viram card numa sessão já `applied`).

## Decisão

### 1. Rastreio `Card ↔ BacklogChatSession`

- Novo campo **`Card.backlogChatSessionId String?`** com relação opcional
  (`onDelete: SetNull`) e índice; lado inverso `BacklogChatSession.cards Card[]`.
- **Preenchido no `apply()`** do backlog-chat para **épico, story e task**
  (`backlogChatSessionId = sessionId`). Assim o board rastreia qual sessão
  originou cada card. Localizar a story-card de uma sessão:
  `prisma.card.findMany({ where: { backlogChatSessionId, type: 'story' } })`.
- Também preenchido em `openStorySession` (para stories manuais) e herdado nas
  tasks criadas por `materializeStoryTasks`.

### 2. Regra de origem do chat da story

Endpoint **`POST /backlog-chat/story/:storyId/session`** → `StoryChatSession`
(`{ sessionId, boardId, storyId, reused }`):

- **Story veio de backlog-chat** (`backlogChatSessionId` presente e a sessão
  ainda existe) → **reusa** a `BacklogChatSession` original (`reused: true`),
  preservando transcript/contexto do épico.
- **Story manual** (ou vínculo pendurado após `SetNull`) → cria uma
  `BacklogChatSession` **zerada** titulada com a story e a **vincula** ao card
  (`reused: false`).

### 3. Threads por task

Estende a convenção de `channel` do ADR-0023 (`main`, `story:<id>`) com
**`task:<taskId>`** via `backlogTaskChannel(taskId)` (+ `parseBacklogTaskChannel`).
No chat da story o usuário conversa no canal principal e abre threads por task
para refiná-las.

### 4. Materialização de tasks

Endpoint **`POST /backlog-chat/story/:storyId/tasks`** (`{ titles: string[] }`) →
`{ cards }`. Reusa **`CardsService.create({ type:'task', parentId, backlogChatSessionId })`**,
que já garante os invariantes ("task só nasce em Backlog/To Do", "task sem
pontos", auto-drop em To Do) e retoma o loop quando a story está In Progress.
Ao criar **≥1 task**, limpa `needsHuman`/`needsHumanReason` da story e emite
`card.updated` (badge "Precisa de você" some).

### 5. UI

`StoryChatSheet` (feature `backlog-chat`) espelha o backlog-chat: transcript +
"✨ Sugerir tasks" + materialização. Aberto a partir do `StoryModal` do board
(botão "💬 Chat da história"). Reusa `useBacklogChat` sobre a sessão resolvida
por `useStoryChat` → `openStoryChatSession`.

## Consequências

- **Base para o fix das "tasks fantasma":** com o rastreio `backlogChatSessionId`,
  é possível localizar a story-card de uma sessão e materializar tasks
  incrementalmente mesmo com a sessão `applied`.
- Contratos novos vivem em `packages/shared` (`backlogTaskChannel`,
  `parseBacklogTaskChannel`, `StoryChatSession`) e são consumidos por web + api.
- Migration `20260810182331_card_backlog_chat_session` adiciona coluna, índice e
  FK `ON DELETE SET NULL`.

## Adendo — fix das "tasks fantasma" (bug-ghost-tasks)

Numa sessão **já aplicada**, o `StoryThreadSheet` (thread da story dentro da
_proposta_) mantinha "✨ Sugerir tasks" pedindo à IA para rascunhar tasks na
proposta — mas a proposta não vira mais card (o `apply` está bloqueado por
`ConflictException` para não duplicar), gerando "tasks fantasma".

Correção:

- **Backend:** `resolveAppliedStoryCard(sessionId, title)` +
  `POST /backlog-chat/sessions/:cid/story-card` → localiza a **story-card real**
  do board (via `backlogChatSessionId` + `type:'story'`, casando pelo título;
  fallback para a única story-card da sessão). Não afrouxa o guard do `apply`.
- **Front:** em sessão `applied`, o botão da thread vira **"✨ Materializar
  tasks"** e redireciona para o `StoryChatSheet`, onde
  `POST /backlog-chat/story/:storyId/tasks` cria cards `type:task` de verdade em
  To Do e invalida as queries de cards do board. O botão "✓ Aprovar" continua
  **oculto** em sessão `applied` (`ProposalCard applied`).

## Adendo — fixes do chat da story (2026-08-11)

Dois bugs surgiram no uso do chat da story:

1. **Clique dentro do `StoryChatSheet` fechava todo o stack de modais.** O overlay
   `modal-layer` (`BoardView`) fecha com `onClick={closeAllModals}`. Como o
   `StoryChatSheet` é um Radix `Sheet` renderizado via **portal** no `body`, mas é
   filho JSX do `StoryModal`, os eventos React sintéticos **borbulham pela árvore
   de componentes** (não pela DOM) até o overlay — e o `stopPropagation` do painel
   não alcança o portal. **Fix:** guard `backdropClose(onClose)` que só fecha
   quando `event.target === event.currentTarget`, aplicado em todos os overlays
   `modal-layer` de `BoardView.tsx` e nos 2 overlays de `App.tsx`.

2. **O chat da story abria sem conhecer a story** — o PO perguntava _"qual é a
   história?"_. Sessões de story **manual/zerada** (Caminho B) começam sem
   history/proposta/focus, então o prompt não tinha contexto algum.
   **Fix:** `resolveStoryCardContext(sessionId)` no orchestrator resolve a **única
   story-card** vinculada à sessão (via `Card.backlogChatSessionId` +
   `type:'story'`; **retorna `undefined` se houver 0 ou >1 story** — nesse caso é
   um backlog-chat geral, não um chat de story), carregando descrição, aiSummary,
   aiNotes, pontos, DoD, épico pai e tasks já existentes. Esse contexto é injetado
   como `storyCard` em `buildBacklogPrompt`, que passa a renderizar o bloco
   **"CHAT DE UMA STORY QUE JÁ EXISTE no board"** instruindo o PO a **não**
   perguntar e já ajudar a decompor a story em tasks (que o humano materializa
   pelo botão). Cobertura: 4 specs novos em `backlog-chat-story-chat.spec.ts`.

## Adendo — tasks estruturadas clicáveis no chat da story (2026-08-11)

O chat da story emitia tasks como **texto puro**, quebrando a paridade com o
backlog-chat (onde stories são cartões clicáveis que abrem threads). Agora o chat
da story reproduz o MESMO padrão para tasks:

1. **Protocolo `KANBAN_TASKS` / `KANBAN_TASKS_PATCH`** (espelha `KANBAN_BACKLOG`).
   O PO emite a lista **completa** de tasks num bloco de controle
   `<<<KANBAN_TASKS>>>{json}<<<END_KANBAN_TASKS>>>`; refinamentos cirúrgicos numa
   thread de task usam `KANBAN_TASKS_PATCH` (ops estilo JSON Patch:
   `/tasks/<i>/title`, `/tasks/<i>/description`, `/tasks/-` add, `/tasks/<i>`
   remove, `/rationale`). Contratos em `packages/shared/src/backlog-chat.ts`
   (`BacklogTaskProposal`, `BacklogTaskProposalItem`, `BacklogTaskProposalPatch`).

2. **Adapter** (`docker/copilot-cli-adapter.mjs`) extrai os blocos em
   `emitTerminalEvents` — **patch antes de proposta** — e emite
   `{kind:'task_patch'|'task_proposal', ...}`. Os blocos são suprimidos do
   transcript visível.

3. **Persistência SEM migração:** a proposta de tasks vira uma
   `BacklogChatMessage(kind:'task_proposal')` com o JSON na coluna `proposal`.
   `persistTaskProposal` atribui **ids estáveis** (âncora das threads `task:<id>`)
   e incrementa `version`; `applyTaskPatch` aplica as ops e regrava com
   `version+1`. `getCurrentTaskProposal` lê a última msg desse kind.

4. **Thread `task:<id>`:** quando o canal é `task:<id>`, o orchestrator injeta a
   task em foco (`focusTask`) e a proposta corrente (`currentTaskProposalJson`) no
   prompt, instruindo o PO a refinar **apenas** aquela task via patch.

5. **Broadcast WS** `backlog.task_proposal` reidrata a lista em tempo real.

6. **Front:** `TaskProposalCard` (espelha `ProposalCard`) renderiza as tasks
   clicáveis no `StoryChatSheet` via `renderMessageBody`; clicar abre a thread
   `task:<id>` (`setActiveTaskThread`). O botão **"Materializar em To Do"** usa os
   títulos da proposta corrente (a antiga textarea manual foi removida). O
   `openStorySession` devolve a `taskProposal` corrente, que é semeada no store ao
   abrir o sheet. Cobertura: specs de `buildBacklogPrompt` (`focusTask`,
   `currentTaskProposalJson`, emissão de `KANBAN_TASKS`) e de `applyTaskPatch` em
   `backlog-chat-story-chat.spec.ts` (26/26 verdes).
