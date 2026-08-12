# ADR-0033 — `@mention` delegation no backlog-chat

**Status:** Aceito

**Relacionado:** [ADR-0023](0023-backlog-chat-story-threads.md) (threads por story;
convenção de `channel`), [ADR-0026](0026-story-chat-and-card-session-link.md)
(rastreio `Card ↔ BacklogChatSession`; materialização de tasks via
`CardsService.create`), [ADR-0007](0007-remove-dor-and-acceptance.md) (único gate
é o DOD), [ADR-0013](0013-epic-status-derived.md) (epic derivado). Épico:
`docs/specs/ep-colab.md` (US-COLAB4).

## Contexto

No backlog-chat (persona Product Owner), o humano refina um backlog conversando
com a IA. Depois que a story existe no board, **não havia forma de, a partir do
texto do chat, delegar trabalho a um agent**: escrever `@backend` numa mensagem
era texto puro. Queríamos que uma menção `@<handle>` numa mensagem:

1. fosse **parseada** (extrair as menções do texto);
2. **criasse uma task** na story corrente da sessão, respeitando os invariantes;
3. **atribuísse** essa task ao assignee mencionado e/ou definisse o `loopType` do
   perfil mencionado.

O mecanismo de assignees (`Assignee` + `CardAssignee`) e a criação segura de tasks
(`CardsService.create`, que impõe os invariantes e retoma o loop) **já existiam** —
faltava só o parser e a cola de delegação. Nenhuma mudança de schema é necessária.

## Decisão

### 1. Contrato do parser (puro, no `packages/shared`)

Em `packages/shared/src/backlog-chat.ts`:

- `MENTION_PATTERN = /@([A-Za-z0-9_-]+)/g` — regex canônica de menção.
- `interface MentionDirective { handle: string; taskTitle: string }`.
- `parseMentions(text): MentionDirective[]` — função **pura** (sem I/O). Para cada
  menção, o `taskTitle` é o trecho entre a menção e a próxima menção (ou o fim do
  texto), com espaços normalizados. Texto sem `@` retorna `[]` (retrocompat).

É consumível pela api (delegação) e opcionalmente pela web (realce). Sem migração.

### 2. Delegação no `BacklogChatOrchestrator`

`sendMessage(sessionId, text, channel)`, **antes** de disparar `runTurn`, processa
as menções (determinísticas — não precisam da CLI) via `delegateFromMentions`:

- Resolve a **story-card da sessão** por `Card.backlogChatSessionId` + `type:'story'`
  (mesmo caminho de `resolveStoryCardContext`/`materializeStoryTasks`). Sem story
  materializada → ignora (retrocompat).
- Para cada menção distinta (**dedup por `handle`**, no máx. 1 task por handle por
  mensagem), cria a task via **`CardsService.create({ type:'task', parentId,
  boardId, title, loopType? })`** e, se houver assignee, chama
  **`CardsService.attachAssignee`**. Não duplica lógica nem escreve no Prisma direto.

`AssigneesService` foi adicionado ao construtor do orchestrator e `AssigneesModule`
ao `BacklogChatModule`.

### 3. Resolução do handle → alvo (política determinística)

Dado um `handle` (case-insensitive):

- **(a) Assignee** do board cujo `name` bate (case-insensitive).
- **(b) `loopType`** se o handle for um profile válido para o board — builtin
  (`feature`/`bug`/`refactor`/…) **ou** custom (`LoopProfile`). A validade é
  checada pelo **mesmo critério** de `CardsService.validateLoopType` (não
  hardcodamos a lista; perfis futuros como `orchestrator` da US-COLAB2 passam a
  funcionar assim que existirem).

**Política em caso de ambiguidade** (o handle bate em assignee **e** em profile):
a task é criada **com o `loopType`** e o assignee é **anexado** (assignee-first +
loopType). Assim nenhuma informação da menção é perdida e o comportamento é
determinístico. **Menção desconhecida** (nem assignee nem profile) é **ignorada** —
nunca cria task órfã.

## Consequências

- **Invariante 3** preservado: a task nasce por `CardsService.create` → coluna
  Backlog/To Do garantida. Nunca burlado por escrita direta no Prisma.
- **Invariante 5**: task não recebe `points` (o `create` já rejeitaria).
- **Invariante 6**: se a story já está In Progress, `maybeResumeLoopOnTaskAdded`
  (disparado por `create`) retoma o loop — a task delegada entra no loop
  naturalmente.
- **Retrocompat total**: sem `@`, `parseMentions` retorna `[]`, `runTurn` roda
  igual e nada muda no chat.
- **Realtime**: `card.created` e `assignee.attached` já são emitidos por
  `create`/`attachAssignee` → o board atualiza sozinho (ADR-0012).
- **Mitigação de spam**: dedup por handle limita a 1 task por handle por mensagem.
- **Sem schema novo**: reusa `Assignee` + `CardAssignee` + `Card.loopType`.

## Alternativas consideradas

- **loopType-first na ambiguidade** (ignorar o assignee homônimo): descartado —
  perderia a atribuição explícita que o humano quis.
- **Criar task só com assignee OU só com loopType**: descartado — a política de
  anexar assignee **e** setar loopType é mais expressiva e ainda determinística.
- **Responder um aviso no chat para menção desconhecida**: possível melhoria de UX
  futura; no v1 apenas ignoramos (sem task órfã), sem ruído no transcript.
