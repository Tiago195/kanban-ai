# docs/loop-engine.md — O núcleo do kanban-ai

O **loop engine** é o coração do produto: transforma uma story em "In Progress"
num ciclo de trabalho **autônomo e encadeado** executado por um **agent de AI**.
Este documento descreve os estados, o ciclo de iteração, o gate de DOD, a
validação final, a criação de task derivada, os loop profiles, os modos de parada,
o watchdog com as **4 salvaguardas** e o ponto de extensão para BullMQ.

> Estado atual: **loop engine com runner real (Copilot CLI via subprocesso) + streaming
> e HITL** (Fase 4). `runIteration`, `stepStory`, auto-play/stop, gate de DOD, validação,
> `createDerivedTask` e as 4 salvaguardas estão no `orchestrator.ts` e persistem
> `Iteration` no Postgres emitindo eventos WS. **Saíram do stub nesta fatia:**
> `CopilotCliRunner` (spawn real atrás do `CliAdapter` JSONL configurável —
> [ADR-0016](adr/0016-copilot-cli-subprocess-adapter.md)), `WorkspaceService` (git
> worktree por execução alimentando o `cwd` — [ADR-0008](adr/0008-git-worktree-per-execution.md))
> e `ValidationRunner` (heurístico mínimo por `affectedFlows`, tornando o caminho de
> **task derivada** exercitável de verdade). O `MockAgentRunner` **permanece** como
> fallback dev/test, alternável por `AGENT_RUNNER_KIND` (ver
> [ADR-0014](adr/0014-mock-agent-runner-default.md) e
> [ADR-0015](adr/0015-auto-play-server-side.md)). Novidades da fatia: **streaming ao
> vivo do "pensamento"** e um novo estado efêmero **`awaiting-input`** (HITL) — ambos via
> WebSocket ([ADR-0017](adr/0017-streaming-hitl-websocket.md),
> [ADR-0018](adr/0018-awaiting-input-in-process.md)). Este doc é o **contrato** que a
> implementação segue. Código: `apps/api/src/modules/ai-engine/`.

## Visão geral

```
story → In Progress
   │
   ▼
onStoryEnterInProgress(storyId)
   │  (respeita limite de concorrência — salvaguarda #2)
   ▼
AgentSessionManager.start(storyId)  ──► sessão { running | idle | dead }
   │
   ▼
loop de iterações encadeadas ──────────────► diário (Iteration[]) + comentários
   │        │
   │        └─ marca itens de DOD ao longo do caminho
   ▼
todos os DOD marcados?  ──não──► próxima iteração
   │ sim
   ▼
iteração de VALIDAÇÃO final (teste de mesa dos affectedFlows)
   │
   ├─ ok      ──► story pronta para Review/Done
   └─ problema ──► cria TASK DERIVADA (derivedFrom/dependsOn) → volta ao loop
```

## Estados da sessão de agent

`AgentSessionState` (em `packages/shared`):

| Estado | Significado |
|---|---|
| `running` | uma iteração está executando agora |
| `idle` | entre iterações, aguardando encadear a próxima |
| `dead` | a sessão caiu / foi interrompida (alvo do watchdog) |

O `AgentSessionManager` é **in-process** e mantém: id da sessão, estado, um
`AbortController` (para stop hard) e o controle de concorrência (`canStart()`).

## Ciclo de uma iteração

Cada iteração produz um `AgentRunResult` (ver `runners/agent-runner.interface.ts`)
e é persistida como um `Iteration` no diário:

1. **Entender** o que precisa ser feito, **onde** mexer e os **efeitos colaterais**.
2. Registrar um **`detail` minucioso** (para a próxima iteração ler na íntegra) e
   um **`summary` curto** (vira comentário no card).
3. Marcar os **`dodTouched`** — itens de DOD que a iteração concluiu.
4. Declarar **`nextStep`** — o que a próxima iteração deve fazer (handoff).
5. Sinalizar **`done`** quando o trabalho da task terminou.

A iteração roda dentro de um **git worktree isolado** (`WorkspaceService`) do
repo-alvo, com o **modelo/agent escolhido** por task/loop (opus, gpt, ...).

> ⚠️ **O agent NÃO faz operações de git.** O worktree e a branch (`kanban/<key>`)
> são criados e mantidos **exclusivamente** pelo `WorkspaceService`. O agent apenas
> **edita arquivos** no `cwd` e deixa as mudanças no working tree (não commitadas).
> Se o agent commitar, trocar de branch ou mexer no worktree, o snapshot que o gate
> de validação inspeciona fica **dessincronizado** do trabalho real — os arquivos
> declarados em `affectedFlows` aparecem como inexistentes (verificação #7) e o
> sistema **deriva tasks de correção duplicadas em loop infinito**. A proibição está
> explícita no prompt (`buildPrompt`, seção "PROIBIDO — operações de git").

### Fases (`IterationPhase`)

`reproduce | analysis | implementation | validation` — quais fases se aplicam e em
que ordem depende do **loop profile** (abaixo).

## Gate de DOD

O **DOD (Definition of Done)** é o **único** checklist do v1 (sem DOR, sem
`acceptance` — ver [ADR-0007](adr/0007-remove-dor-and-acceptance.md)). O loop só
avança para a validação final quando **todos os itens de DOD estão marcados**.
Marcações emitem `dod.checked` via WebSocket.

## Iteração de validação final

Quando o gate de DOD fecha, roda uma **iteração especial de validação**
(`ValidationRunner`), que valida **empiricamente TUDO** que foi implementado via
**teste de mesa** dos **fluxos afetados**. A story declara esses fluxos no campo
**`affectedFlows`** (`{ name, files[], note }`) — é isso que torna a validação
acertiva e localizada.

- **Se passa:** a story está apta a ir para Review/Done.
- **Se encontra problema:** cria uma **task derivada** na mesma story, com todos os
  campos preenchidos e uma ligação **`derivedFrom` / `dependsOn`** com a task de
  origem — para a próxima AI atacar já com o contexto completo. Emite
  `task.derived`.

## Guardas de qualidade de entrega

Além do gate de DOD e da validação empírica, quatro guardas opcionais fecham o
ciclo **métrica → ação** e endurecem o critério de `done`. Todas são
**configuráveis por env** (bloco `agent` em `config.ts` / `.env.example`) e
**desligadas por padrão** — não alteram o comportamento atual nem os mocks:

| Guarda | Env | Efeito |
|---|---|---|
| **Cost gate** | `AGENT_MAX_TASK_DURATION_MS`, `AGENT_MAX_TASK_TOKENS` (0 = off) | soma duração/tokens das iterações da task; ao estourar, **escala para humano** |
| **Anti-thrash** | `AGENT_THRASH_DETECTION_ENABLED` (def. false), `AGENT_THRASH_SIMILARITY` (def. 0.9), `AGENT_THRASH_WINDOW` (def. 2) | detecta iterações quase idênticas (AI travada) e **escala para humano** |
| **Diff no prompt** | — (sempre que houver diff) | injeta o diff acumulado do worktree (última iteração, ~20KB) no prompt |
| **Evidência verificável** | `AGENT_REQUIRE_STRUCTURED_EVIDENCE` (def. false) | `done` só fecha com `StructuredEvidence` contendo ≥1 check `passed=true` |

**Cost gate + anti-thrash** rodam em `enforceLoopGuards`, chamado no início de
cada `runIteration`. Antes o engine só **media** (métricas `#8`); agora **age**:
quando um limite estoura ou a AI está travada, `escalateToHuman(...)` marca
`needsHuman`, faz `stop(graceful)` e emite `card.needs_human`. O anti-thrash usa
similaridade de Jaccard (`textSimilarity`) sobre `summary`+`nextStep` das últimas
`AGENT_THRASH_WINDOW` iterações.

**Diff no prompt**: `buildContext` carrega o `diff` já persistido da última
iteração (`Iteration.diff`, sem rodar `git` novamente) e `buildPrompt` o injeta,
para a AI ver o que já mudou no worktree antes de agir.

**Evidência verificável**: o contrato de saída aceita `evidence: string |
StructuredEvidence` (`@kanban-ai/shared`). Com o gate ligado, o prompt pede um
JSON com `checks[]` (test/lint/build e seus resultados) e a fase `validation` só
fecha se `isVerifiableEvidence(...)` — do contrário a validação "falha" e roteia
para derivação/needs-human. A string livre legada continua aceita (retrocompat).

## Loop profiles (por tipo de label)

O comportamento do loop **depende do tipo da label** da task. Perfis embutidos
(`loop-profiles/loop-profiles.ts`, portados do artifact):

| Profile | Fases | Estratégia de validação |
|---|---|---|
| `feature` | analysis → implementation → validation | `flows+regression` |
| `bug` | reproduce → analysis → implementation → validation | `bug-gone+regression` |
| `refactor` | implementation → validation | `regression-only` |
| `__default` | (fallback quando a label não tem perfil próprio) | — |

Uma label pode apontar para um perfil via `loopProfileId`. `resolveLoopProfile`
faz o fallback para `__default`.

## Modos de parada (ambos disponíveis)

| Modo | Comportamento |
|---|---|
| **graceful** | espera a iteração atual terminar e **não inicia a próxima** |
| **hard / abort** | interrompe **imediatamente** via `AbortSignal` no subprocess |

Ambos limpam o watchdog e emitem `auto.stopped` com o `mode`.

## Watchdog + as 4 salvaguardas

Enquanto a story está viva em In Progress, um **`setInterval` de ~2 min**
(`agent.watchdogIntervalMs`) verifica a sessão e retoma o fluxo se algo travou. O
interval **morre** quando a story vai para Review/Done ou no stop manual.

As **4 salvaguardas obrigatórias** (todas in-process, sem Redis no v1):

1. **Reconciliação no boot** (`reconcileOnBoot`): ao subir, varrer as stories em
   In Progress no **Postgres** e **recriar os watchdogs**. O estado de verdade é o
   **banco**, não a memória.
2. **Limite de concorrência**: no máximo `N` sessões ativas; o excedente aguarda
   slot (`AgentSessionManager.canStart()`).
3. **Idempotência do watchdog**: o "cutucão" **não** inicia uma segunda iteração se
   uma já estiver `running`; o watchdog só age em sessões `dead` ou travadas em
   `idle`.
4. **Encerramento limpo**: cancelar a iteração em curso via **`AbortSignal`** no
   subprocess da Copilot CLI (stop hard).

## AgentRunner plugável (Copilot CLI real + streaming + HITL)

`AgentRunner` é uma **interface** (token de DI `AGENT_RUNNER`). A implementação real,
`CopilotCliRunner`, invoca a **Copilot CLI como subprocesso** atrás de um `CliAdapter`
configurável e mapeia a saída para `AgentRunResult`. Outras implementações (SDK, API
remota) plugam sem tocar no orquestrador. O `MockAgentRunner` permanece como fallback,
alternável por `AGENT_RUNNER_KIND` (`mock` | `copilot-cli`). Ver
[ADR-0006](adr/0006-agent-runner-pluggable.md) e
[ADR-0016](adr/0016-copilot-cli-subprocess-adapter.md).

### Contrato do CliAdapter (JSONL)

O prompt/handoff é entregue por **stdin** (default; `AGENT_CLI_PROMPT_MODE`). O stdout
é lido **linha a linha** como **JSONL** — uma linha JSON por evento:

| `kind` | payload | efeito |
|---|---|---|
| `thought` | `{text}` | chunk de raciocínio → `onChunk` → `agent.chunk` (WS) |
| `output` | `{text}` | chunk de saída/ação → `onChunk` → `agent.chunk` (WS) |
| `question` | `{id, prompt, options?}` | pausa HITL → `onQuestion` → `agent.question` (WS) |
| `result` | `{detail, summary, dodTouched[], nextStep, done}` | resultado final → `AgentRunResult` |

Linhas **não-JSON** são toleradas e viram `thought` (fallback). Config por env:
`AGENT_CLI_COMMAND`, `AGENT_CLI_ARGS`, `AGENT_CLI_PROMPT_MODE`,
`AGENT_STREAM_IDLE_TIMEOUT_MS`, `AGENT_HITL_TIMEOUT_MS`.

### Interface estendida (streaming + pergunta)

`AgentRunInput` ganhou dois callbacks opcionais (mantendo o mock trivial e o
orquestrador fazendo `await runner.run(input)`):
- `onChunk?(chunk)` — chamado por evento de stream; o orchestrator repassa como
  `agent.chunk` no WebSocket.
- `onQuestion?(q): Promise<string>` — chamado quando a CLI emite `question`; **bloqueia**
  até o usuário responder e resolve com o texto da resposta (escrito no **stdin** da
  mesma sessão).

### Fluxo HITL / `awaiting-input`

Quando a CLI emite `question`, a iteração **pausa** (não avança de fase, não fecha
task) e a story **permanece em In Progress** com um badge **"aguardando você"**
(derivado do evento WS, **não** é coluna/estado novo). O orchestrator emite
`agent.question`, registra a `PendingQuestion` no `AgentSessionManager`
(`waitForAnswer`) e aguarda. O usuário responde via
**`POST /cards/:id/loop/answer`** (id = story) → `resolveQuestion` → resposta no
stdin → iteração retoma → emite `agent.answered`. O estado é **in-process** (sem
migration; ver [ADR-0018](adr/0018-awaiting-input-in-process.md)); um restart mata o
subprocesso e a sessão é reconciliada no boot. `AGENT_HITL_TIMEOUT_MS` rejeita esperas
longas demais. Streaming e HITL trafegam pelo **WebSocket** existente — sem SSE nem
TanStack AI (ver [ADR-0017](adr/0017-streaming-hitl-websocket.md)).

### Validação real (mínimo viável)

O `ValidationRunner` saiu do stub: percorre os `affectedFlows` da story aplicando a
`ValidationStrategy` do profile como checagem heurística e retorna `problems[]`. Quando
há `problems`, o caminho de **task derivada** (Fatia 3) é exercitado de verdade.
Validação profunda (rodar testes no worktree) fica como evolução futura.

## Ponto de extensão: BullMQ + Redis

O `AgentSessionManager` fica **atrás de uma interface plugável**. No v1 é
in-process (sem Redis). No futuro pode ser trocado por **BullMQ + Redis** para
orquestração distribuída — **sem mexer** no `Orchestrator` nem nos módulos de
domínio. Ver [ADR-0005](adr/0005-in-process-orchestration.md).
