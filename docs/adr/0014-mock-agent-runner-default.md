# ADR-0014 — Runner MOCK determinístico como default na fatia do loop engine

**Status:** Aceito

## Contexto

A fatia do loop engine (Fase 3) precisa exercitar o `Orchestrator` end-to-end —
iterações encadeadas, gate de DOD, validação, auto-play, salvaguardas — **sem** ainda
depender da Copilot CLI real nem de git worktrees. A [ADR-0006](0006-agent-runner-pluggable.md)
já estabeleceu o `AgentRunner` como interface plugável via o token de DI
`AGENT_RUNNER`, mas apontava o `CopilotCliRunner` como default do v1.

Invocar a CLI real nesta fatia acoplaria o desenvolvimento do orquestrador a
subprocessos, worktrees e não-determinismo — dificultando teste e revisão.

## Decisão

Nesta fatia, o token `AGENT_RUNNER` passa a resolver, **por configuração**
(`AGENT_RUNNER_KIND`, default `mock`), o **`MockAgentRunner`** — um runner
**determinístico e in-process** que porta `mockIterationContent`/`nextPhaseFor` do
artifact (`docs/reference/kanban.html`, linhas 903–1101). Ele gera
`detail/summary/dodTouched/nextStep/done` por fase a partir da story pai
(affectedFlows, aiProject, aiNotes), **sem spawnar processo**.

O `CopilotCliRunner` e o `WorkspaceService` (git worktrees) **permanecem stub** e
serão ativados na fatia seguinte, trocando apenas `AGENT_RUNNER_KIND` — o
`Orchestrator` não muda.

O `ValidationRunner` mock retorna sempre `{passed:true, problems:[]}`; o fluxo de
**task derivada** (`createDerivedTask`) fica **implementado** no orquestrador mas só
será exercitado pela AI real depois (coberto por revisão de código, não pelo caminho
feliz do mock).

## Consequências

- Loop engine testável de ponta a ponta de forma determinística e sem efeitos
  colaterais externos.
- A troca para a CLI real é uma mudança de configuração + retirada do stub, sem tocar
  o orquestrador.
- O caminho de task derivada existe mas não é validado por E2E nesta fatia (validação
  sempre passa por decisão de escopo).
