# Plano — kanban-ai · Fase 3: AI Engine Loop (runner MOCK server-side)

> Fatia atual. Coração do produto: transformar uma story em In Progress num ciclo
> de iterações encadeadas **executado no backend**, com auto-play + passo manual,
> persistindo `Iteration` no Postgres e refletindo tudo em tempo real via WS.
> **Sem invocar a Copilot CLI ainda** — runner é um MOCK determinístico portado do
> artifact (`mockIterationContent`). A integração real da CLI + git worktrees vem
> na fatia seguinte.

Fonte da verdade: `docs/reference/kanban.html` (loop JS linhas 903–1101) e
`docs/loop-engine.md` (contrato). Não reintroduzir DOR/acceptance (ADR-0007).

---

## Decisões de escopo (travadas com o usuário)

1. **Runner MOCK server-side** — portar `mockIterationContent`/`nextPhaseFor` do
   artifact para o `AgentRunner` mock. NÃO spawnar processo. `CopilotCliRunner`
   permanece stub; adicionamos um `MockAgentRunner` e o `AGENT_RUNNER` aponta pra
   ele nesta fatia (flag/config).
2. **Auto-play com cadência configurável (~1–2s) + botão "Rodar 1 iteração"**,
   ambos disparados pelo **backend**. Move → In Progress dispara auto-play.
3. **Validação sempre PASSA** (sem `Math.random`, sem forçar bug). O fluxo de task
   derivada fica **implementado no orchestrator** mas só será exercitado pela AI
   real depois. `ValidationRunner` mock retorna `{passed:true, problems:[]}`.
4. **WorkspaceService fica stubado** (mock não usa worktree).
5. **Sem migration nova** — schema já tem `Iteration`, `execState`, `derivedFromId`,
   `TaskDependency`, `handoff*`.

---

## Contrato (shared) — já existe, revisar/expandir

Enums (`enums.ts`): `ExecState`, `IterationPhase`, `ValidationStrategy`,
`AgentSessionState`, `StopMode` — OK.
Eventos (`events.ts`): `iteration.appended`, `task.state.changed`, `task.derived`,
`auto.started`, `auto.stopped`, `agent.session.state_changed`,
`story.entered_in_progress`, `dod.checked` — OK.

**A revisar:** os payloads dos eventos batem com o que o orchestrator vai emitir?
(ex.: `TaskDerivedEvent.originTaskId/derivedTaskId`; `iteration.appended` carrega o
`Iteration` inteiro serializado do Prisma). Adicionar tipos/DTO só se faltar.

> **⚠️ Achado (descompasso de contrato pré-existente, BLOQUEIA F2/F3):** o
> `GET /cards/:id` (`cards.service.ts findOne`) devolve o `Iteration` **cru do
> Prisma** — campos achatados `handoffState/handoffNextStep/handoffFiles/handoffDodIds`
> e `ts: DateTime`. O tipo `Iteration` do shared (consumido por `apps/web`) espera
> `handoff:{state,nextStep,targets{files,dodIds}}` aninhado e `ts: number` (epoch ms).
> Hoje o front só usa `phase/summary/detail/index/ts`, então o bug está latente, mas
> assim que a Fase 3 popular `handoff`/`ts` de verdade ele aparece. **O mapper
> Prisma→shared é obrigatório nesta fatia** (não opcional) e deve ser aplicado tanto no
> `GET /cards/:id` quanto no payload de `iteration.appended`. → vira a tarefa **B0**.

---

## FASES E TAREFAS

### Trilha SHARED (primeiro — desbloqueia api+web)

- **S1 — Auditar contratos do loop no shared.**
  Objetivo: garantir que eventos/enums/DTO do loop cobrem o que orchestrator emite e
  web consome (iteration serializada, exec states, auto start/stop, task.derived).
  Arquivos: `packages/shared/src/{events,enums,domain}.ts`.
  Pronto: build do shared passa; tipos usados por api e web sem `any`.

### Trilha BACKEND

- **B0 — Mapper `Iteration` Prisma→shared (desbloqueia diário/realtime).**
  Objetivo: função única (ex. `ai-engine/iteration.mapper.ts` ou em `cards`) que
  converte o registro cru do Prisma (`handoffState/handoffNextStep/handoffFiles/
  handoffDodIds` achatados, `ts: DateTime`) no tipo `Iteration` do shared
  (`handoff:{state,nextStep,targets{files,dodIds}}`, `ts: number`). Aplicar no
  `findOne`/`findAll` do `cards.service.ts` E no payload de `iteration.appended`.
  Arquivos: `modules/cards/cards.service.ts` (ou novo `iteration.mapper.ts`),
  `ai-engine/orchestrator.ts` (ao emitir o evento).
  Pronto: `GET /cards/:id` devolve `iterations[].handoff` aninhado e `ts` numérico;
  o tipo bate com `apps/web` sem cast.

- **B1 — MockAgentRunner (portar mockIterationContent).**
  Objetivo: novo `runners/mock-agent.runner.ts` implementando `AgentRunner`, gerando
  `detail/summary/dodTouched/nextStep/done` por fase (analysis/implementation/
  validation/reproduce) a partir da story pai (affectedFlows, aiProject, aiNotes).
  Determinístico. `AGENT_RUNNER` passa a apontar para ele (config `AGENT_RUNNER_KIND`).
  Arquivos: `ai-engine/runners/mock-agent.runner.ts`, `ai-engine.module.ts`, `config.ts`.
  Pronto: `runner.run()` devolve conteúdo coerente por fase; unit test cobre as 4 fases.

- **B2 — Loop core no Orchestrator: `runIteration(taskId)`.**
  Objetivo: implementar o núcleo (espelha artifact 993–1051): resolver loop profile,
  `nextPhaseFor` (1ª fase→…→validation quando DOD completo), chamar `runner.run`,
  **persistir `Iteration`** (index, phase, detail, summary, handoff*, dodTouched) em
  transação, marcar DOD tocados, atualizar `execState`, emitir `iteration.appended`,
  `dod.checked`, `task.state.changed`. Na fase validation: chamar `ValidationRunner`;
  se passar → `execState=done` + `onTaskDone`; se achar problema → `createDerivedTask`.
  Arquivos: `ai-engine/orchestrator.ts` (+ helpers `ai-engine/loop-helpers.ts`).
  Pronto: mover uma story com 1 task por todas as fases persiste N iterations e fecha
  a task em `done`; unit/integration test verde.

- **B3 — Serial por story: `stepStory` + `pickNextTask` + `onTaskDone` + deps.**
  Objetivo: portar seleção serial de tasks (respeita `TaskDependency`/`dependsOn`,
  `blocked-dep`), re-validação da origem quando derivada fecha (artifact 1053–1078).
  Arquivos: `ai-engine/orchestrator.ts`, `loop-helpers.ts`.
  Pronto: com 2 tasks dependentes, roda em ordem; task derivada (quando existir) volta
  a origem para re-validar. (Derivada não dispara no mock, mas o caminho existe.)

- **B4 — createDerivedTask (implementado, não exercitado no mock).**
  Objetivo: portar artifact 926–946: cria task-bug filha da mesma story, label Bug,
  `derivedFromId`, dependência reversa (origem `dependsOn` a derivada, `blocked-dep`),
  DOD padrão, emite `task.derived`. Tudo em transação.
  Arquivos: `orchestrator.ts`.
  Pronto: unit test chamando o método cria a task e liga a dependência corretamente.

- **B5 — Auto-play + passo manual + stop (server-side).**
  Objetivo: `startAuto(storyId)` = `setInterval(config.agent.autoStepIntervalMs)` que
  chama `stepStory`; para sozinho quando não há tasks pendentes (`auto.stopped`).
  `stepOnce(storyId)` = um `stepStory`. `stop(storyId, mode)` já existe — completar
  graceful (não inicia próxima) e hard (abort). Reusar `watchdogs` map ou um
  `autoTimers` separado (espelha artifact). Emite `auto.started`/`auto.stopped`.
  Arquivos: `orchestrator.ts`, `config.ts` (`autoStepIntervalMs`, default 1500).
  Pronto: auto-play avança as tasks sozinho até tudo `done`, então para e emite stop.

- **B6 — Salvaguardas: reconcileOnBoot + concorrência + idempotência + watchdog.**
  Objetivo: `reconcileOnBoot` varre stories em In Progress no Postgres e recria
  auto-play/sessão. `canStart()` respeita `maxConcurrentSessions`. Watchdog só age em
  `dead`/idle-travado. Encerramento limpo (abort) já ok.
  Arquivos: `orchestrator.ts`, `agent-session-manager.ts`.
  Pronto: reiniciar a api com uma story In Progress recria o loop; limite de sessões
  respeitado.

- **B7 — Endpoints REST do loop.**
  Objetivo: expor num **`AiEngineController` dedicado** (decisão 1):
  `POST /cards/:id/loop/step` (1 iteração), `POST /cards/:id/loop/auto/start`,
  `POST /cards/:id/loop/auto/stop` (body `{mode}`), `GET /cards/:id/loop/state`
  (execState/isAutoRunning/sessão). Validação de entrada (schema).
  Ligar `move → In Progress` para chamar `orchestrator.onStoryEnterInProgress`
  (hoje só emite evento). Importar `AiEngineModule` no `CardsModule` (ou fiar o
  disparo via o próprio AiEngine ouvindo o move).
  Arquivos: `ai-engine/ai-engine.controller.ts`, `cards.service.ts` (fiar o move),
  `ai-engine.module.ts` (controller + exports), `cards.module.ts`.
  Pronto: `curl` nos 4 endpoints funciona; mover story para In Progress inicia o loop.

### Trilha FRONTEND

- **F1 — Serviço + hooks do loop (TanStack Query mutations).**
  Objetivo: `features/ai-engine/services/` com `stepLoop`, `startAuto`, `stopAuto`,
  `getLoopState`; hooks `useLoopState`, `useStepLoop`, `useAutoPlay`. Invalidação do
  card ao mutar.
  Arquivos: `features/ai-engine/{services,hooks}/*`.
  Pronto: hooks tipados chamando os endpoints B7.

- **F2 — UI do loop no TaskModal (exec badge + botões + diário reativo).**
  Objetivo: no modal de task, mostrar exec-state badge (EXEC_STATE_META), select de
  loop profile (read-only nesta fatia ok), botões **"▶ Rodar 1 iteração"** e
  **"⏩ Auto-play / ⏸ Parar"** (estado vem do backend), lista de dependências.
  Espelha artifact 1804–1848. Diário de iterações já renderiza — garantir realtime.
  Arquivos: `features/board/components/BoardView.tsx` (TaskModal ~790–890),
  `index.css` (exec badge já existe? conferir).
  Pronto: clicar "Rodar 1 iteração" adiciona iteração ao diário sem F5; auto-play
  avança sozinho; badge de exec-state atualiza.

- **F3 — Realtime dos eventos do loop.**
  Objetivo: no `features/realtime`, tratar `iteration.appended`, `task.state.changed`,
  `task.derived`, `auto.started`, `auto.stopped`, `agent.session.state_changed`,
  `dod.checked` → invalidar/atualizar cache do card/story. Cobrir 2ª aba.
  Arquivos: `features/realtime/*`, mapa de handlers de WS.
  Pronto: numa 2ª aba, iterações e exec-state aparecem em tempo real.

- **F4 — Sinais de auto no board/mini-kanban (opcional, fiel ao artifact).**
  Objetivo: indicar visualmente story com loop rodando (badge/pulse) como no artifact.
  Arquivos: `BoardView.tsx`, `index.css`.
  Pronto: story em auto-play tem indicador visível.

### Trilha DOCS/ADR

- **D1 — ADRs.**
  - ADR: runner mock nesta fatia (AGENT_RUNNER plugável, CLI real depois).
  - ADR: auto-play server-side com setInterval in-process (cadência configurável).
  - Atualizar `docs/loop-engine.md` (marcar o que saiu de stub).
  Pronto: ADRs criados; loop-engine.md reflete o estado real.

### VALIDAÇÃO FINAL

- **V1 — build + lint 3 workspaces; E2E manual.**
  `npm run build` e `npm run lint` verdes em web/api/shared.
  E2E: criar story c/ tasks + DOD → mover p/ In Progress → loop roda sozinho →
  iterações aparecem no diário em tempo real (2ª aba) → tasks fecham em `done` →
  auto-play para → epic recalcula. Passo manual também funciona.

---

## Dependências (ordem)

```
S1 ─┬─► B0 ─► B1 ─► B2 ─► B3 ─► B4
    │                      └─► B5 ─► B6 ─► B7 ─┬─► F2 ─► F3 ─► F4
    └─► F1 (adianta com contrato de S1) ───────┘         │
D1 em paralelo.                                V1 fecha ◄─┘
```
Backend B0→B7 é a espinha (B0 primeiro: desbloqueia o diário/realtime do front).
Front F2→F4 depende de B7 (endpoints) + B0 (mapper). F1 pode adiantar com o contrato
de S1.

---

## Decisões tomadas (antes eram "em aberto")

1. **Endpoints do loop → `AiEngineController` dedicado** (`ai-engine/ai-engine.controller.ts`),
   mais coeso; o `AiEngineModule` passa a expor o controller e importar o que precisar
   (Prisma/Realtime já vêm por DI). Rotas ainda sob o recurso card:
   `POST /cards/:id/loop/step`, `POST /cards/:id/loop/auto/start`,
   `POST /cards/:id/loop/auto/stop` (`{mode}`), `GET /cards/:id/loop/state`.
2. **`autoTimers` em `Map` separado** do `watchdogs` (espelha o artifact) — auto-play e
   watchdog têm ciclos de vida distintos; misturar complica o stop graceful.
3. **Mapper `Iteration` Prisma→shared** = tarefa **B0**, aplicado no `GET /cards/:id`
   e no `iteration.appended`. Único ponto de verdade.
4. **Loop profile no mock**: nesta fatia basta `resolveLoopProfile(task.loopType)`
   com fallback `__default`. Derivação por label (`loopProfileId`) fica anotada como
   melhoria futura (não bloqueia o loop mock).
5. **`execState` inicial**: manter `idle` até a 1ª iteração (fiel ao artifact); a 1ª
   iteração move para `analyzing`/`implementing` conforme a fase.
6. **Cadência default do auto-play**: `autoStepIntervalMs = 1500` (config, override
   por env `AGENT_AUTO_STEP_INTERVAL_MS`).
