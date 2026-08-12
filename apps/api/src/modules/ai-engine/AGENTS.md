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
  falha vira `problem` mencionando o fluxo. **#5 (teste de mesa empírico):** para
  fechar a lacuna "suite verde ≠ fluxo coberto", quando `AGENT_REQUIRE_FLOW_COVERAGE=true`
  um fluxo que declara arquivos-**fonte** (não-spec) mas não tem spec co-located
  vira `problem` (nomeando fluxo+arquivos), e um fluxo cujos specs foram localizados
  mas **não puderam ser executados** (runner indeterminado) também vira `problem` —
  sem execução não há teste de mesa. Com o flag off, ambos os casos são apenas log.
  Quando testes direcionados
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

## Escalonamento a humano (#3) — quatro gatilhos

O caminho de resgate `escalateToHuman(...)` (marca `needsHuman`/
`needsHumanReason`, faz `stop(graceful)` e emite `card.needs_human`) é acionado
por **quatro** gatilhos independentes — todos convergem para o mesmo destino:

- **(a) Falhas de validação** — `AGENT_MAX_VALIDATION_FAILURES` (default 3):
  ao esgotar as tentativas de validação da task, para de derivar e escala.
- **(b) Cap de iterações** — `AGENT_MAX_ITERATIONS_PER_TASK` (default 30,
  **LIGADO** por padrão como salvaguarda anti-loop-infinito; 0 = desligado):
  em `enforceLoopGuards`, se a task já acumulou ≥ cap iterações persistidas,
  escala com reason de loop.
- **(c) Profundidade de derivação** — `AGENT_MAX_DERIVED_DEPTH` (default 3;
  0 = desligado): no ramo de validação, antes de derivar, se a task de origem
  já está fundo demais na cadeia de derivações (`Card.derivedDepth`), escala em
  vez de criar mais uma derivada — evita cadeia infinita de bugs derivados.
  `createDerivedTask` incrementa `derivedDepth` (origem = 0, cada derivada +1;
  migration `card_derived_depth`).
- **(d) Cap AGREGADO por problema** — `AGENT_MAX_DERIVED_PER_PROBLEM` (default 2;
  0 = desligado): fecha a brecha em que cada falha inicia uma **cadeia NOVA**
  (onde `derivedDepth` reinicia baixo) escapando do cap (c). Antes de derivar,
  `countOpenDerivedForProblem(parentId, problem.title)` conta as tasks de
  correção ABERTAS (`execState != done`) com o título canônico
  `Corrigir: ${problem.title}` sob a MESMA story. Se já há ≥1, **não duplica**
  (dedup — apenas loga e deixa a derivada existente resolver); ao atingir o cap
  agregado, **escala** em vez de multiplicar cadeias paralelas.

## Serialização de stories (por EPIC)

O loop engine roda **uma story por epic** de cada vez. Duas stories do **mesmo
epic** (mesmo `Card.parentId`) são **serializadas**: ao entrar em In Progress, a
segunda é adiada (log de "aguardando serialização") e retomada automaticamente
quando a primeira sai de In Progress (`resumeDeferredForStory`). Stories de
**épicos diferentes** rodam **concorrentes**, limitadas apenas por
`AGENT_MAX_CONCURRENT_SESSIONS`.

- Âncora de conflito: `resolveStoryEpic(storyId)` → `Card.parentId` (o epic).
- Detecção: `findConflictingActiveStory(storyId)` compara o epic da story com o
  das sessões ativas (`sessions.activeStoryIds()`).
- **Guard-rail legado opcional** — `AGENT_SERIALIZE_BY_REPO` (default `false`):
  enquanto o worktree isolado por execução for **stub** ([ADR-0019](../../../../../docs/adr/0019-api-runs-on-host-not-docker.md)),
  o agent coda direto no working tree do repo-alvo. Se **dois épicos ativos**
  apontarem para o **MESMO repo físico**, eles se sobrescreveriam. Ligue este
  flag para reforçar a serialização também por repo-alvo físico
  (`resolveStoryProject`) nesse cenário. Por default fica desligado (a
  serialização é puramente por epic).

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

### Guardas de qualidade de entrega (melhorias 🟡)

Quatro guardas fecham o ciclo métrica→ação e endurecem o gate de `done`. Todas
são configuráveis por env (ver `shared/config/config.ts`, bloco `agent`, e
`.env.example`) e **desligadas por padrão** para não afetar o comportamento atual
nem os mocks/testes:

- **Cost gate (#1 — fecha o ciclo métrica→ação)**: `enforceLoopGuards` (chamado
  cedo em `runIteration`) soma `durationMs`/`inputTokens`+`outputTokens` das
  iterações já persistidas da task. Se exceder `AGENT_MAX_TASK_DURATION_MS` ou
  `AGENT_MAX_TASK_TOKENS` (0 = desligado), escala para humano via
  `escalateToHuman(...)` (marca `needsHuman`, `stop(graceful)`, broadcast
  `card.needs_human`). Antes só media (#8); agora **age** sobre a métrica.
- **Diff no prompt (#2)**: `buildContext` carrega o `diff` da ÚLTIMA iteração
  persistida (`lastDiff`, sem rodar `git` de novo) e `buildPrompt` injeta esse
  diff acumulado do worktree (truncado a ~20KB) para a AI enxergar o que já
  mudou antes de agir.
- **Anti-thrash (#3)**: `enforceLoopGuards` usa `isThrashing` (loop-helpers) —
  compara as últimas `AGENT_THRASH_WINDOW` iterações por similaridade de Jaccard
  (`textSimilarity`) de `summary`+`nextStep`; se qualquer par consecutivo ≥
  `AGENT_THRASH_SIMILARITY`, considera a AI travada e escala para humano.
  **Desligado por default** — só roda com `AGENT_THRASH_DETECTION_ENABLED=true`
  (o loop normal/mock repete `summary`/`nextStep` legitimamente).
- **Gate de `done` verificável (#6 reforçado)**: `evidence` do contrato passou a
  aceitar `string | StructuredEvidence` (`@kanban-ai/shared`:
  `EvidenceCheck`/`StructuredEvidence`/`isVerifiableEvidence`). Quando
  `AGENT_REQUIRE_STRUCTURED_EVIDENCE=true`, o prompt pede evidência estruturada
  (JSON com `checks[]` verificáveis) e a fase `validation` só fecha se
  `isVerifiableEvidence(...)` (≥1 check `passed=true`); caso contrário a validação
  "falha" e roteia para o caminho de derivação/needs-human. A string livre legada
  continua aceita (retrocompat) e é persistida via `evidenceToString(...)`.
- **Gate de artefato mínimo por classe (US-ROB1)**: complementa o gate de
  evidência acima. Quando `AGENT_REQUIRE_MIN_ARTIFACT=true`, mesmo com a
  validação empírica passando, a fase `validation` só fecha se a conclusão
  trouxer o **artefato mínimo** da sua `ResultClass` (`@kanban-ai/shared`:
  `ResultClass`/`MinimumArtifactInput`/`minimumArtifactSatisfied`):
  `code-change` → diff não-vazio; `test-green` → ≥1 `EvidenceCheck` de teste
  com `passed=true`; `flow-artifact` → arquivos de `affectedFlows` presentes no
  worktree. A classe é derivada dos sinais em escopo no gate (diff da iteração /
  presença de `affectedFlows`); `flowFilesPresent` reusa o sinal do
  `ValidationRunner` (não duplica I/O). Faltando o artefato, `effectivePassed`
  vira false e a iteração roteia pelo caminho de derivação/needs-human
  (`outcome=derived`). Off por default (retrocompat).
- **Estado de runtime durável (US-ROB2)**: o `AgentSessionManager` mantém o `Map`
  em memória como **cache quente** e, quando `AGENT_RUNTIME_PERSIST_ENABLED=true`
  (default), espelha o estado na tabela **`AgentRuntimeState`** (Prisma):
  `sessionId` **estável** (`== storyId`, sobrevive a restart — não usar
  `Date.now()`), `livenessState` (`LivenessState` em `@kanban-ai/shared`:
  starting/alive/stalled/dead) e `tokenTotals` acumulados. `start`/`setState`/
  `abort`/`remove` persistem best-effort (fire-and-forget, guardado por flag e
  `try/catch` — uma falha de DB **nunca** derruba o loop, só gera warning). O
  orquestrador chama `sessions.addTokens(storyId, {input, output})` ao fim de
  cada iteração. No boot, `reconcileOnBoot()` **lê** `AgentRuntimeState` antes de
  re-escanear as colunas: sessões duráveis cujas stories não estão mais
  "In Progress" são marcadas `stalled` (base do recovery por lease — US-ROB4).
  O construtor do manager agora recebe `(config, prisma)`.
- **Lease/claim por execução (US-ROB4)**: quando `AGENT_CLAIM_ENABLED=true`, cada
  story em execução mantém um **lease** em `AgentRuntimeState`
  (`claimLock`/`claimExpiresAt`). `onStoryEnterInProgress` adquire o claim
  (`claimStory`); `runIteration` renova por iteração (`renewClaim`, heartbeat);
  `finishAuto` solta (`releaseClaim`). Um **tick global** in-process (cadência =
  `watchdogIntervalMs`, `unref()` + `try/catch`, **SEM Redis** — invariante 7) +
  `reconcileOnBoot` chamam `recoverStaleClaims()`: leases vencidos (`claimExpiresAt
  <= now`) têm a sessão removida, watchdog limpo, worktree liberado e a linha
  marcada `stalled`, destravando a serialização (`resumeDeferredForStory`). A
  salvaguarda #3 é preservada: o watchdog só age em sessão `dead` **ou** claim
  vencido — por isso `claimTtlMs` **deve** ser `> watchdogIntervalMs` (validado com
  warning no boot). Off por default (retrocompat total).

Ao mudar esses contratos, mantenha este arquivo em dia.

## Integração com a memória em colmeia (EP-A / ADR-0027)

O loop engine **consome** e **alimenta** a memória em colmeia — antes ele começava
"amnésico". Toda interação é **defensiva** (try/catch + fallback): a memória
NUNCA pode derrubar o loop. `sessionId = taskId` (estável entre iterações);
neurônios vivem em `modules/<modulo>.md`.

- **READ (US-A1)** — `buildContext` (async) faz um fetch best-effort de
  neurônios via `MemoryIndexService.query(...)` → `MemoryGitService.readNeuron(...)`
  (limite 5, conteúdo truncado). O resultado vai em `context.memoryNeurons` e é
  injetado por `buildPrompt` na seção **"Memória do projeto (colmeia)"** antes do
  histórico de iterações. Em falha, `memoryNeurons = []`.
- **INSTRUÇÃO (US-A2)** — o template `KANBAN_RESULT` inclui o campo opcional
  `learnings[]` (`{ path, summary, scope? }`) e uma regra explicando quando/como
  a AI deve reportar aprendizados reutilizáveis.
- **WRITE (US-A3)** — após `persistAffectedFlows`, cada item de
  `runResult.learnings` é anexado (não sobrescreve) ao neurônio via
  `MemoryIndexService.commitAndReindex({path, content, sessionId, message})`
  (git commit → reindexa Postgres → WS, na ordem invariante do ADR-0027). Um
  warning por learning em caso de falha; o loop segue.
- **BOOTSTRAP (US-A5)** — `onStoryEnterInProgress`, antes de `startAuto`, chama
  `MemoryBootstrapService.bootstrapFromRepo({repoPath, sessionId})` para semear
  neurônios iniciais por módulo do repo-alvo. É **idempotente** (pula módulos já
  existentes) e defensivo.

O contrato `learnings` é parseado em `runners/cli-adapter.ts` (`parseLearnings`)
e tipado em `runners/agent-runner.interface.ts` (`AgentRunResult.learnings`).
`MemoryModule` é `@Global`, então os 3 serviços são injetados direto no
construtor do `Orchestrator`.

## Como testar

- `npx nest build` (a partir de `apps/api`) deve passar.
- `npm test` (a partir de `apps/api`) roda os specs (`node:test` + `ts-node`,
  arquivos `src/**/*.spec.ts`). Cobertura atual em `loop-quality.spec.ts`:
  `isVerifiableEvidence`/`evidenceToString` (gate de `done`) e
  `textSimilarity`/`isThrashing` (anti-thrash). `orchestrator-guards.spec.ts`
  cobre o NÚCLEO via fakes leves (estratégia 1 — `new Orchestrator(...fakes)`):
  cap de iterações + cost gate (`enforceLoopGuards`), decisão de derivação vs
  escalonamento por `derivedDepth`, `escalateToHuman` (needsHuman + stop
  graceful + `card.needs_human`), `createDerivedTask` (derivedDepth+1 +
  dependência reversa), idempotência do watchdog, `stop` graceful vs hard
  (AbortController) e `reconcileOnBoot` (retoma story ativa / no-op sem
  stories). Os specs são excluídos do build via `tsconfig.build.json`.
- Ao implementar `runIteration`, adicione testes cobrindo: encadeamento de
  iterações, idempotência do watchdog, stop graceful vs hard, e reconciliação no
  boot.
