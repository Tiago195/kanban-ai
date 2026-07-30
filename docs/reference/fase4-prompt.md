# Prompt de Planejamento — kanban-ai (Fase 4: Copilot CLI real + chat de streaming + HITL)

> Cole no **modo plan** para gerar o plano de implementação da **quarta e última
> fatia** do `kanban-ai`: trocar o **runner MOCK** pela **Copilot CLI real** rodando
> como **subprocesso**, com **streaming ao vivo do "pensamento" da AI** e um
> **chat interativo (HITL)** onde a AI pode **pausar e tirar uma dúvida** antes de
> seguir para a próxima iteração. **Reusar a infra WS + shadcn já existentes — NÃO
> introduzir TanStack AI nem SSE novo.**

---

## Contexto e ponto de partida

As fatias anteriores estão **prontas e commitadas**:
- **Fatia 1** (`7cbfd7b`) — fundação: monorepo npm, NestJS+Fastify, Prisma+Postgres,
  WebSocket gateway, docs/ADRs.
- **Fatia 2** (`b9790a4`→`9d692c1`) — board funcional: drag-and-drop com DragOverlay +
  highlight de coluna alvo, cascata de modais Epic→Story→Task, mini-kanbans, CRUD
  completo, realtime via WS.
- **Fatia 3** (`f6f1d4e`) — loop engine com **runner MOCK server-side**: orchestrator
  (`runIteration`/`stepStory`/auto-play/salvaguardas), `MockAgentRunner` determinístico,
  `AiEngineController`, wire `move→In Progress`→orchestrator, TaskModal com controles de
  loop + diário reativo.

Tudo type-safe, contratos em `packages/shared`, TanStack Query + Zustand + @dnd-kit no
front. **Esta fatia é a que encarna os stubs deixados de propósito.**

---

## Fonte da verdade

- **`docs/reference/kanban.html`** — protótipo. O loop de orquestração (linhas
  ~903–1101) já foi portado na Fatia 3; **a lógica de orquestração NÃO muda** nesta
  fatia. O que muda é **o runner** (mock → CLI real) e **duas capacidades novas**
  (streaming + HITL) que **não existem no artifact** — são extensões deliberadas.
- **`docs/loop-engine.md`** — contrato do loop (estados de sessão, gate de DOD,
  validação final, task derivada, loop profiles, watchdog + 4 salvaguardas,
  `AgentRunner` plugável). **Atualizar** para refletir o runner real, o novo estado
  `awaiting-input`, e o contrato do "CLI adapter".

---

## Decisões de escopo JÁ TRAVADAS (o plano deve respeitar)

1. **Runner real = Copilot CLI como subprocesso**, implementando o `CopilotCliRunner`
   (hoje stub em `runners/copilot-cli.runner.ts`). O token DI `AGENT_RUNNER` passa a
   apontar para a CLI quando `AGENT_RUNNER_KIND=copilot-cli` (a factory já existe em
   `ai-engine.module.ts`); o `MockAgentRunner` **permanece** disponível como fallback
   (dev/test) e continua sendo o default até a CLI ser plugada.
2. **"CLI adapter" configurável.** O comando/flags/parser exatos da CLI **ainda não
   são conhecidos**. Isolar isso atrás de uma camada `CliAdapter` (comando base,
   args template, working dir, como injetar o prompt — stdin vs. arquivo, e como
   **parsear o stdout** em eventos estruturados), tudo configurável por **env**
   (`AGENT_CLI_COMMAND`, `AGENT_CLI_ARGS`, `AGENT_CLI_PROMPT_MODE`, etc.). O runner
   spawna o processo via `child_process.spawn` respeitando `input.signal`
   (AbortSignal) para stop hard. **Documentar o contrato** do parser (que linhas/
   marcadores viram "thought", "final result", "question") para plugar o comando real
   depois sem tocar no orchestrator.
3. **Streaming ao vivo do "pensamento"** — **via WebSocket** (o gateway já existe,
   tipado, usado nas fatias 2/3). Enquanto a iteração roda, o stdout da CLI é lido
   **incrementalmente** e reemitido como **chunks** por WS; a UI faz append em tempo
   real. **NÃO** criar endpoint SSE novo nem adotar TanStack AI (avaliado e descartado:
   nosso "provider" é um subprocesso sem adapter oficial; WS + shadcn cobrem tudo com
   menos acoplamento — registrar em ADR).
4. **HITL (human-in-the-loop) — a AI pode pausar e perguntar.** Novo estado de sessão/
   exec **`awaiting-input`**: quando a CLI sinaliza uma pergunta, a iteração **pausa**
   (não avança de fase, não fecha task), emite-se um evento `agent.question`, e a
   **story permanece em In Progress** com um **badge "aguardando você"** no card
   (decisão travada — **não** criar coluna/estado "Blocked" novo no board). O usuário
   responde por um endpoint dedicado → a resposta é escrita no **stdin** do subprocesso
   → a iteração **retoma**. Watchdog/salvaguardas existentes cobrem timeout de espera.
5. **Chat bonito com shadcn puro** dentro do TaskModal: bolhas por papel
   (AI / você / sistema), render de markdown, indicador "pensando…/digitando…",
   auto-scroll, badges de fase por mensagem, campo de resposta habilitado só em
   `awaiting-input`. Consistente com o design do resto do app. **Sem TanStack AI.**
6. **`WorkspaceService` (git worktrees) sai do stub** — a CLI real precisa de um
   diretório de trabalho isolado. Implementar `ensureWorktree`/`cleanupWorktree`
   (`git worktree add/remove`) usando `config.agent.workspacesDir`. O `input.cwd`
   passado ao runner passa a ser a worktree real.
7. **`ValidationRunner` real (mínimo viável).** Sai do stub para exercer a estratégia
   por `affectedFlows` (o mock sempre passava). Definir no plano até onde vai a
   validação real nesta fatia vs. o que continua heurístico — mas o caminho de **task
   derivada** (já implementado na Fatia 3) agora pode ser **exercitado de verdade**.
8. **SEM migration destrutiva.** Preferir **não** exigir migration. Se o estado
   `awaiting-input` precisar persistir (ex.: novo valor no enum `ExecState` ou
   `AgentSessionState`, ou colunas p/ a pergunta pendente), **isso é o único ponto
   onde uma migration aditiva pode ser aceitável** — o plano deve decidir explicitamente
   entre (a) persistir (migration aditiva mínima) ou (b) manter em memória na sessão
   in-process. Justificar a escolha (reconciliação no boot vs. simplicidade).

---

## Estado atual do código (o que já existe vs. o que falta)

### Backend `apps/api/src/modules/ai-engine/`
- `runners/agent-runner.interface.ts` — `AgentRunner` (`run(AgentRunInput):
  Promise<AgentRunResult>`), `AgentRunInput` **já tem** `cwd`, `model`, `phase`,
  `prompt`, `context?`, `signal?`; `AgentRunResult` tem `detail/summary/dodTouched/
  nextStep/done`. **Falta**: um canal de **streaming** (a interface hoje é
  request→response única, sem chunks) e um canal de **pergunta/resposta**. O plano
  deve estender a interface (ex.: callbacks `onChunk`/`onQuestion` no input, ou um
  `EventEmitter`/async-iterator) **de forma type-safe e compartilhada**, sem quebrar o
  `MockAgentRunner`.
- `runners/copilot-cli.runner.ts` — **STUB** (retorna resultado fake). Alvo principal:
  spawn real, parser de stdout, mapeamento para `AgentRunResult` + emissão de chunks +
  detecção de pergunta.
- `runners/mock-agent.runner.ts` — funcional; **manter** como fallback. Se a interface
  ganhar streaming/pergunta, o mock deve implementar os novos membros de forma trivial
  (emitir alguns chunks fake, nunca perguntar).
- `orchestrator.ts` — `runIteration`/`stepStory`/auto-play/`createDerivedTask`/4
  salvaguardas **prontos** (Fatia 3). **Falta**: (a) repassar chunks do runner para o
  WS; (b) tratar o novo estado `awaiting-input` (pausar a iteração, guardar a pergunta
  pendente, retomar ao receber resposta); (c) integrar `WorkspaceService` real (obter
  worktree antes de rodar, limpar depois); (d) integrar `ValidationRunner` real.
- `session-manager/agent-session-manager.ts` — `AgentSessionState`
  (`running|idle|dead`) + `canStart`/`start`/`setState`/`abort`/... **Falta**:
  suportar o estado de espera (`awaiting-input`) e guardar handle do subprocesso +
  pergunta pendente + como responder (stdin).
- `validators/validation.runner.ts` — **STUB** (`{passed:true}`). Alvo do item 7.
- `workspaces/workspace.service.ts` — **VAZIO/stub**. Alvo do item 6.
- `ai-engine.controller.ts` — endpoints do loop (Fatia 3). **Falta**: endpoint
  `POST` de **resposta à pergunta** (HITL) e, se preciso, `GET` do transcript/chat de
  uma task.
- `ai-engine.module.ts` — factory `AGENT_RUNNER` por `runnerKind` **pronta**; adicionar
  `WorkspaceService` aos providers se ainda não estiver, e a config do CLI adapter.
- `shared/config/config.ts` — bloco `agent` tem `defaultModel`, `maxConcurrentSessions`,
  `watchdogIntervalMs`, `workspacesDir`, `runnerKind`, `autoStepIntervalMs`. **Falta**:
  config do **CLI adapter** (`cliCommand`, `cliArgs`, `promptMode`, timeouts de
  streaming/espera de input).
- `modules/cards/cards.service.ts` — `move→In Progress`→orchestrator **fiado** (Fatia 3).

### Shared `packages/shared/src/`
- `enums.ts` — `ExecState` (`idle|analyzing|implementing|validating|blocked-dep|done`),
  `AgentSessionState` (`running|idle|dead`), `IterationPhase`, `StopMode`, etc.
  **Falta**: representar `awaiting-input` (novo valor de `ExecState` e/ou
  `AgentSessionState`) — decidir junto com o item 8.
- `events.ts` — união `ServerEvent` já tem `iteration.appended`, `task.state.changed`,
  `task.derived`, `auto.started/stopped`, `agent.session.state_changed`,
  `story.entered_in_progress`, `dod.checked`. **Falta (adicionar tipados)**:
  `agent.chunk` (streaming incremental: taskId, iterationId?, delta, kind:
  thought|output), `agent.question` (taskId, questionId, prompt, opções?),
  `agent.answered` (questionId), e transição para/de `awaiting-input`.
- `domain.ts` — `Iteration`/handoff/campos de loop no `Card`. **Falta**: tipos do
  **chat/transcript** (mensagens por papel) e da pergunta pendente, se forem expostos
  no `GET /cards/:id`.

### Frontend `apps/web/src/`
- `features/board/components/BoardView.tsx` — `TaskModal` já tem `TaskLoopControls`
  (exec-badge, profile, deps, step/auto-play) + diário reativo (Fatia 3). **Falta**:
  a **UI do chat** (streaming + HITL) — provavelmente um novo componente
  `TaskChat`/`AgentChat` dentro do TaskModal; badge **"aguardando você"** no card do
  board quando a task/story está em `awaiting-input`.
- `features/ai-engine/hooks/useLoop.ts` — hooks de loop (Fatia 3). **Falta**: hook do
  chat (`useAgentChat`?) que acumula chunks do WS num buffer reativo e expõe
  `answer(questionId, text)` chamando o novo endpoint.
- `features/realtime/useRealtime.ts` — trata eventos do loop (Fatia 3). **Falta**:
  handlers para `agent.chunk`/`agent.question`/`agent.answered` (append no
  buffer/cache; cobrir 2ª aba).
- `shared/types/api.ts` / `apiClient` — tipos de loop + métodos (Fatia 3). **Falta**:
  método `answerQuestion(...)` e tipos do chat/transcript.

---

## O que esta fatia deve ENTREGAR

1. **Backend**:
   - `CopilotCliRunner` real via `child_process.spawn` atrás de um **CliAdapter
     configurável** (comando/args/prompt-mode/parser por env), com **streaming** de
     stdout → chunks e **detecção de pergunta** → pausa; respeita `AbortSignal`.
   - `WorkspaceService` real (git worktree add/remove) alimentando `input.cwd`.
   - Orchestrator: repassa chunks ao WS; trata **`awaiting-input`** (pausa/retoma);
     integra worktree e `ValidationRunner` real (mínimo viável, exercitando task
     derivada de verdade).
   - Endpoint HITL `POST /.../answer` (escreve no stdin do subprocesso) e, se
     necessário, `GET` do transcript.
   - Extensão **type-safe** da interface `AgentRunner` p/ streaming+pergunta, com o
     `MockAgentRunner` ainda compilando e funcional.
2. **Shared**: novos eventos (`agent.chunk`, `agent.question`, `agent.answered`),
   representação de `awaiting-input`, tipos do chat/transcript — tudo tipado e
   consumido por web e api.
3. **Frontend**: **chat bonito com shadcn** no TaskModal (bolhas por papel, markdown,
   "pensando…", auto-scroll, badges de fase, campo de resposta habilitado só em
   `awaiting-input`); badge **"aguardando você"** no card; realtime dos novos eventos
   (cobrindo 2ª aba); **sem TanStack AI**.
4. **Docs/ADR**: ADR "Copilot CLI real via subprocesso + CliAdapter configurável";
   ADR "Streaming + HITL via WebSocket (rejeitando TanStack AI/SSE — justificativa)";
   ADR do estado `awaiting-input` (persistir vs. in-process); atualizar
   `docs/loop-engine.md` marcando o que saiu de stub e o novo fluxo de pergunta.
5. **Validação**: `npm run build` e `npm run lint` verdes nos 3 workspaces; E2E manual
   com **`AGENT_RUNNER_KIND=copilot-cli`** apontando para um **comando fake que exercita
   o contrato do CliAdapter** (emite chunks e uma pergunta) — provar streaming ao vivo,
   pausa em `awaiting-input`, resposta via chat retomando a iteração, e task fechando
   em `done`; provar também o fallback `mock`. E2E na 2ª aba (realtime).

---

## O que o plano deve produzir

- **Lista de fases/tarefas** ordenada, trilhas **shared → backend → frontend → docs**,
  com dependências e paralelismo explícitos. Para cada tarefa: **objetivo**,
  **arquivos/dirs afetados**, **critério de "pronto"**.
- **Resolver as decisões em aberto**:
  1. **Forma de estender a interface `AgentRunner`** para streaming+pergunta:
     callbacks (`onChunk`/`onQuestion`/`waitForAnswer`) no `AgentRunInput` **vs.**
     async-iterator/`EventEmitter` retornado por `run()`. Escolher a que mantém o
     mock trivial e o orchestrator limpo.
  2. **`awaiting-input`: persistir (migration aditiva mínima) vs. in-process.**
     Decidir e justificar (reconcileOnBoot vs. simplicidade). Se persistir, a
     migration deve ser **aditiva** e mínima.
  3. **Contrato do parser de stdout do CliAdapter**: como distinguir chunk de
     pensamento, resultado final estruturado (dodTouched/nextStep/done) e pergunta.
     Definir um formato (ex.: linhas com prefixo/JSONL) documentado para o comando
     real plugar depois.
  4. **Como o `prompt`/handoff é entregue à CLI** (stdin vs. arquivo temporário) e
     como a **resposta HITL** volta (stdin da mesma sessão vs. re-spawn com contexto).
  5. **Escopo do `ValidationRunner` real** nesta fatia (quanto é heurístico vs.
     efetivo) e como isso interage com a task derivada agora exercitável.
  6. **Concorrência do subprocesso** com `maxConcurrentSessions`, watchdog e stop
     graceful/hard (matar processo, limpar worktree) — mapear nas 4 salvaguardas
     existentes.
  7. **Timeouts**: de espera por input do usuário (HITL) e de inatividade de stream
     — valores default e configuráveis.

## Restrições
- **npm** (não pnpm/yarn).
- **Não** reintroduzir DOR/acceptance (ADR-0007) — só DOD.
- **Não** adotar **TanStack AI** nem criar **SSE** novo — streaming e HITL via **WS**
  já existente; chat com **shadcn puro**.
- Preferir **não** exigir migration; se `awaiting-input` precisar persistir, migration
  **aditiva mínima** é o único ponto aceitável (decidir no plano).
- Reusar os módulos/arquitetura existentes (ai-engine, cards, features/ai-engine,
  features/realtime) — não criar arquitetura nova.
- **Manter o `MockAgentRunner` funcional** (fallback dev/test); a troca é por
  `AGENT_RUNNER_KIND`.
- Tudo **type-safe**; contratos no `packages/shared`, consumidos por web e api; eventos
  WS tipados; mutações em **transação**; respeitar `AbortSignal` no subprocesso.
