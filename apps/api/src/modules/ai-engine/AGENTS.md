# AGENTS.md — módulo `ai-engine` (NÚCLEO)

> Este é o **coração** do produto. Leia
> [docs/loop-engine.md](../../../../../docs/loop-engine.md) antes de mexer aqui.

## Propósito

Orquestrar o ciclo de vida das sessões de agent: acordar um agent quando uma story
entra em **In Progress**, encadear **iterações**, marcar o **DOD**, rodar a
**validação final** e criar **tasks derivadas** em caso de falha.

## Estrutura

```
ai-engine/
├── orchestrator.ts            # Orchestrator: onStoryEnterInProgress, watchdog, stop
├── session-manager/           # AgentSessionManager (in-process: running|idle|dead)
├── runners/                   # AgentRunner (interface, token AGENT_RUNNER) + CopilotCliRunner
├── loop-profiles/             # feature | bug | refactor | __default (+ resolveLoopProfile)
├── iterations/                # diário de iterações
├── validators/                # ValidationRunner (validação final dos affectedFlows)
└── ai-engine.module.ts        # DI: AGENT_RUNNER → CopilotCliRunner (useExisting)
```

## Contratos / interfaces (não quebrar assinaturas sem atualizar consumidores)

- **`AgentRunner`** (`runners/agent-runner.interface.ts`): `run(input) => AgentRunResult`.
  Token de DI: `AGENT_RUNNER`. v1: `CopilotCliRunner` (subprocess da Copilot CLI).
- **`AgentSessionManager`**: `start`, `get`, `abort`, `canStart` — estados
  `running|idle|dead`. **Interface plugável** (ponto de extensão para BullMQ+Redis).
- **`Orchestrator`**: `onStoryEnterInProgress(storyId)`, `stop(storyId, mode)`,
  `reconcileOnBoot()`.
- **`ValidationRunner`**: valida os `affectedFlows` quando o DOD fecha. Além das
  checagens estruturais, roda **validação empírica real** (#1) — executa os scripts
  do projeto-alvo (`test`/`build`/`lint`) no worktree isolado (`cwd`) via `npm run`
  e verifica (#7) que os arquivos declarados existem no worktree; qualquer falha
  vira `problem` → task derivada. Depende de `WorkspaceService` + `APP_CONFIG`
  (configs `AGENT_VALIDATION_*` / `AGENT_VERIFY_FLOW_FILES`). Faz também
  **validação direcionada por fluxo**: para cada `affectedFlow` localiza specs
  co-located (`findRelatedTestFiles`) e os roda restritos (`runTestsForFiles`);
  falha vira `problem` mencionando o fluxo; fluxo sem cobertura vira `problem` só
  se `AGENT_REQUIRE_FLOW_COVERAGE=true` (senão log). Quando testes direcionados
  rodam, o `test` global é pulado para não rodar duas vezes (build/lint globais
  seguem). Configs `AGENT_FLOW_TESTS_ENABLED` / `AGENT_FLOW_TEST_GLOBS` /
  `AGENT_REQUIRE_FLOW_COVERAGE`.
- **Loop profiles**: `resolveLoopProfile(labelProfileId)` com fallback `__default`.

## Invariantes (NUNCA violar)

1. O loop **só** dispara em **story → In Progress**.
2. **DOD é o único gate** para a validação final (sem DOR/`acceptance` — [ADR-0007](../../../../../docs/adr/0007-remove-dor-and-acceptance.md)).
3. As **4 salvaguardas** são obrigatórias: reconciliação no boot; limite de
   concorrência; idempotência do watchdog; encerramento limpo via AbortSignal.
4. **Estado de verdade é o Postgres**, não a memória — sempre reconcilie no boot.
5. Falha na validação **cria task derivada** com `derivedFrom`/`dependsOn` —
   **exceto** ao atingir `AGENT_MAX_VALIDATION_FAILURES` falhas de validação na
   mesma task: aí o loop **desiste** (não deriva mais), marca a task com
   `needsHuman`/`needsHumanReason`, **para o auto-play da story (graceful)** e
   emite `card.needs_human`. Isso é o **destino/resgate**, não substitui caps de
   iteração/derivação.

## O que NÃO mexer

- Não remova as salvaguardas nem torne o watchdog não-idempotente.
- Não acople o `Orchestrator` a uma implementação concreta de session manager ou
  runner — use os tokens/interfaces.
- Não introduza Redis/BullMQ no v1 (é ponto de extensão futuro).

## Estado atual

**Loop engine implementado** com validação empírica real. Melhorias recentes no
contrato de iteração:

- **Histórico completo (#3)**: `buildContext`/`buildPrompt` injetam TODAS as
  iterações anteriores da task (detalhe completo só da última; demais resumidas).
- **1 DOD por iteração (#4)**: o código trunca `dodTouched` para no máximo 1 id
  (menor `position` do DOD); excedente é ignorado e logado.
- **Verificação antes de `done` (#6)**: o prompt exige que a AI rode os checks e
  preencha `evidence`. Novo campo `evidence?: string` no contrato de saída
  (`AgentRunResult` / `KANBAN_RESULT` / coluna `Iteration.evidence`).
- **Telemetria (#8)**: `Iteration` ganhou `durationMs`, `inputTokens`,
  `outputTokens`, `outcome` (todos nullable, migration `iteration_telemetry`).
  Endpoint `GET /cards/:id/loop/metrics` agrega métricas por story
  (`Orchestrator.computeStoryMetrics`). O tipo de retorno `LoopMetrics` (e
  `LoopTaskMetrics`) vive em `@kanban-ai/shared` (contrato compartilhado com o
  web); `orchestrator.ts` importa e **re-exporta** (`export type { LoopMetrics }`)
  para não quebrar consumidores. A UI consome via `apiClient.getLoopMetrics` +
  hook `useLoopMetrics`, renderizada em `LoopMetricsPanel` (feature `ai-engine`,
  seção "📊 Custo & qualidade do loop" no modal da story).
- **Diff/Replay Viewer**: `Iteration` ganhou `diff String @default("")`
  (migration `iteration_diff`). O orquestrador captura o diff do worktree ao fim
  de cada iteração via `captureDiff(cwd)` (`git add -A -N` + `git diff HEAD`,
  truncado em ~100KB) — este `git` é do ENGINE inspecionando o resultado, não do
  agent (que continua proibido de rodar git). O campo flui para o front pelo DTO
  `Iteration` (`packages/shared`), `mapIteration` e o evento `iteration.appended`;
  a UI (`IterationDiffViewer` na feature `ai-engine`) permite navegar iteração a
  iteração ("replay").

Ao mudar esses contratos, mantenha este arquivo em dia.

## Como testar

- `npx nest build` (a partir de `apps/api`) deve passar.
- Ao implementar `runIteration`, adicione testes cobrindo: encadeamento de
  iterações, idempotência do watchdog, stop graceful vs hard, e reconciliação no
  boot.
