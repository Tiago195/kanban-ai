# ADR-0015 — Auto-play server-side com `setInterval` in-process

**Status:** Aceito

## Contexto

O produto executa o loop de uma story como um ciclo de iterações encadeadas. No
artifact (`docs/reference/kanban.html`), o auto-play é client-side (`startAuto`/
`stopAuto` com `setInterval`). Nesta arquitetura, o loop roda **no backend** e
persiste no Postgres, emitindo eventos WS. Precisamos decidir **onde e como** a
cadência do auto-play é orquestrada.

Alternativas consideradas: (a) fila/worker externo (BullMQ/Redis); (b) cron; (c)
`setInterval` in-process no `Orchestrator`. A [ADR-0005](0005-in-process-orchestration.md)
já optou por orquestração **in-process** no v1, com ponto de extensão para BullMQ
depois.

## Decisão

O auto-play é disparado e mantido **pelo backend**, com um **`setInterval`
in-process** por story rodando, guardado num `Map` `autoTimers` **separado** do
`Map` `watchdogs` (ciclos de vida distintos). A cadência é **configurável**:
`config.agent.autoStepIntervalMs`, default **1500ms**, override por env
`AGENT_AUTO_STEP_INTERVAL_MS`.

Cada tick chama `stepStory(storyId)` (uma iteração da próxima task pronta). O
auto-play **para sozinho** quando não há mais tasks pendentes, emitindo
`auto.stopped`. `stop(storyId, mode)` suporta **graceful** (não inicia a próxima
iteração) e **hard** (aborta a sessão). `startAuto`/`stepOnce`/`stop` são expostos
por REST (`POST /cards/:id/loop/auto/start|stop`, `POST /cards/:id/loop/step`).

Mover uma story para **In Progress** dispara `onStoryEnterInProgress`, que inicia o
auto-play (respeitando `maxConcurrentSessions`).

## Consequências

- Simplicidade: sem infra extra (Redis/worker) no v1; alinhado à ADR-0005.
- Cadência ajustável por ambiente para demos vs. desenvolvimento.
- `setInterval` in-process **não sobrevive a restart**; a salvaguarda
  `reconcileOnBoot` varre stories In Progress no boot e recria o auto-play/sessão.
- Escala limitada ao processo único; a migração para BullMQ (ADR-0005) troca o motor
  de cadência sem alterar a lógica de `stepStory`.
