# docs/loop-engine.md — O núcleo do kanban-ai

O **loop engine** é o coração do produto: transforma uma story em "In Progress"
num ciclo de trabalho **autônomo e encadeado** executado por um **agent de AI**.
Este documento descreve os estados, o ciclo de iteração, o gate de DOD, a
validação final, a criação de task derivada, os loop profiles, os modos de parada,
o watchdog com as **4 salvaguardas** e o ponto de extensão para BullMQ.

> Estado atual: **loop engine implementado com runner MOCK server-side** (Fase 3).
> `runIteration`, `stepStory`, auto-play/stop, gate de DOD, validação, `createDerivedTask`
> e as 4 salvaguardas estão implementados no `orchestrator.ts` e persistem `Iteration`
> no Postgres emitindo eventos WS. **Ainda stub nesta fatia:** `CopilotCliRunner` e
> `WorkspaceService` (git worktrees) — a AI real e os worktrees entram na próxima fatia,
> trocando apenas `AGENT_RUNNER_KIND` (ver [ADR-0014](adr/0014-mock-agent-runner-default.md)
> e [ADR-0015](adr/0015-auto-play-server-side.md)). O `ValidationRunner` mock sempre
> passa, então o caminho de task derivada existe mas não é exercitado no E2E. Este doc é o
> **contrato** que a implementação segue. Código: `apps/api/src/modules/ai-engine/`.

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

## AgentRunner plugável (v1: Copilot CLI)

`AgentRunner` é uma **interface** (token de DI `AGENT_RUNNER`). A implementação v1,
`CopilotCliRunner`, invoca a **Copilot CLI como subprocesso** e captura o
resultado. Outras implementações (SDK, API remota) plugam sem tocar no
orquestrador. Ver [ADR-0006](adr/0006-agent-runner-pluggable.md).

**Decisões ainda em aberto** (documentar ao implementar):
- Formato exato do payload enviado à Copilot CLI e como **detectar "iteração
  terminou"** (parse de stdout, exit code, arquivo de saída).
- Estratégia de `git worktree` (diretório base, cleanup) no `WorkspaceService`.
- Valor default de `N` (limite de sessões concorrentes).

## Ponto de extensão: BullMQ + Redis

O `AgentSessionManager` fica **atrás de uma interface plugável**. No v1 é
in-process (sem Redis). No futuro pode ser trocado por **BullMQ + Redis** para
orquestração distribuída — **sem mexer** no `Orchestrator` nem nos módulos de
domínio. Ver [ADR-0005](adr/0005-in-process-orchestration.md).
