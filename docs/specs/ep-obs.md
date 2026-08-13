# EP-OBS — Observabilidade & Resiliência de Frota (design-spec implementável)

> **Público-alvo:** agents de AI autônomos que vão implementar este épico **sem
> acesso ao autor**. Este documento é a fonte-da-verdade: todos os caminhos,
> símbolos e contratos aqui foram **verificados no código atual** (branch de
> trabalho). Não "descubra" contratos — eles estão descritos abaixo. Antes de
> tocar qualquer módulo, leia também o `AGENTS.md` da raiz e o do módulo.

---

## 0. Sumário do épico

`EP-OBS` cobre quatro stories que aumentam a **observabilidade da frota de
agents** e a **resiliência do ambiente de execução**. Todas se apoiam na
fundação já existente do loop engine (`apps/api/src/modules/ai-engine`), no
painel de métricas do web (`LoopMetricsPanel`) e nos contratos type-safe de
`packages/shared`.

| ID | Título | Persona | Esforço | Valor | Bloqueio |
|----|--------|---------|---------|-------|----------|
| **US-OBS1** | Dashboard de frota (`GET /dashboard`) | Paperclip | Baixo | Alto | Nenhum |
| **US-OBS2** | Worktree resiliente (mirror ignored/submodules/patch-preserve) | Cline | Alto | Médio | **Parcial** — depende do worktree isolado real (ADR-0008) que **ainda não existe** |
| **US-OBS3** | Review inline por linha + auto-commit/PR opcional | Cline | Alto | Alto | Nenhum (mas o auto-commit é mais valioso após US-OBS2) |
| **US-OBS4** | Multi-agent adapters (Claude/Codex/Gemini) | Cline | Alto | Médio (futura) | Nenhum técnico |

### Ordem recomendada de implementação

1. **US-OBS1 — Dashboard de frota.** Baixo esforço, alto valor, **zero
   dependências**. Reusa `computeStoryMetrics` e leituras do board. Entrega valor
   imediato de observabilidade. **Comece por aqui.**
2. **US-OBS3 — Review inline por linha.** A parte de **comentários por linha
   persistidos como evidência** é independente e entregável já. A parte de
   **auto-commit/PR** é entregável já (o engine já faz git via `captureDiff`),
   mas ganha muito valor quando o worktree isolado existir (US-OBS2), porque hoje
   o commit é feito **direto no working tree do repo-alvo do usuário**.
3. **US-OBS2 — Worktree resiliente.** **Parcialmente bloqueada.** O pré-requisito
   (worktree isolado por execução, ADR-0008) **não está implementado** — hoje o
   agent roda **direto no repo-alvo** (ver §US-OBS2/Estado atual). Só a
   **interface e a política** podem ser especificadas/estubadas agora; o mirror
   de ignored paths, `submodule --init` e patch-preserve **só fazem sentido
   depois** que `resolveWorkdir` criar um worktree real. Documentado abaixo o que
   dá pra fazer já vs. o que fica bloqueado.
4. **US-OBS4 — Multi-agent adapters.** Futura. Alto esforço, sem dependência
   técnica das demais. Faça por último para não desestabilizar o runner default
   (`copilot-cli`) enquanto as outras stories evoluem.

### Tabela de rastreabilidade (US → artefatos afetados)

| US | Contratos (`packages/shared`) | API (`apps/api`) | Web (`apps/web`) | Prisma |
|----|------------------------------|------------------|------------------|--------|
| OBS1 | `domain.ts`: `FleetDashboard`, `FleetColumnCount`, `FleetStaleStory`, `FleetCostSummary` (novos) + `index.ts` re-export | novo `dashboard/` (module+controller+service) registrado em `app.module.ts`; reusa `Orchestrator.computeStoryMetrics` | novo `features/dashboard/` (hook+apiClient method+queryKey+página/painel) | — |
| OBS2 | (opcional) `domain.ts`: `WorktreePolicy` config | `modules/ai-engine/workspaces/workspace.service.ts` (`resolveWorkdir`, `cleanupWorktree`); `shared/config/config.ts` (flags) | — | — |
| OBS3 | `domain.ts`: `ReviewComment`, `ReviewCommentInput`, `CommitOutcome` (novos) + `events.ts`: `ReviewCommentAddedEvent` + `index.ts` | novo `modules/review/` ou extensão de `cards/`; integração com `orchestrator.ts` (`captureDiff`/`appendIteration`) e `workspaces` (commit); `ai-engine.controller.ts` ou novo controller | `features/review/` (UI de comentários por linha) | novo model `ReviewComment` |
| OBS4 | `domain.ts`: `AgentAdapterKind`, `AgentAdapterDescriptor` (novos) | `modules/ai-engine/runners/` (novo `agent-adapter.registry.ts`, adapters por vendor); `ai-engine.module.ts` (DI); `shared/config/config.ts` | (opcional) seletor de adapter | — |

---

## 1. Fundação já existente (contratos que você NÃO deve reinventar)

> Leia esta seção inteira antes de escrever qualquer linha. Tudo abaixo **já
> existe** e foi verificado.

### 1.1 Contratos compartilhados — `packages/shared/src/`

- **`enums.ts`**
  - `BOARD_COLUMNS = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done']`
  - `TASK_COLUMNS = ['To Do', 'In Progress', 'Review', 'Done']`
  - `TASK_CREATION_COLUMNS = ['Backlog', 'To Do']`
  - `ExecState`: `idle | analyzing | implementing | validating | blocked_dep | done`
    (no runtime a orchestration usa também `'blocked-dep'` string — atenção ao hífen).
- **`domain.ts`** (418 linhas). Símbolos relevantes já definidos:
  - `LoopMetrics` (linha 267) — **contrato agregado por story**, retornado por
    `Orchestrator.computeStoryMetrics` e exposto por `GET /cards/:id/loop/metrics`:
    ```ts
    export interface LoopMetrics {
      storyId: string;
      taskCount: number;
      iterationCount: number;
      avgIterationsPerTask: number;
      derivedTaskRate: number;   // fração de iterações que derivaram task de correção
      okIterationRate: number;   // fração de iterações com outcome 'ok'
      avgDurationMs: number | null;
      totalInputTokens: number;
      totalOutputTokens: number;
      perTask: LoopTaskMetrics[];
    }
    export interface LoopTaskMetrics {
      taskId: string; key: string; title: string; execState: string; iterations: number;
    }
    ```
  - `Iteration` — persistida por iteração (campos: `index`, `detail`, `summary`,
    `dodTouched`, `handoff*`, `evidence`, `diff`, `durationMs`, `inputTokens`,
    `outputTokens`, `outcome: 'ok'|'derived'|'failed'|'awaiting-input'`).
  - `StructuredEvidence { checks: EvidenceCheck[]; filesChanged?: string[]; note?: string }`,
    `EvidenceCheck { name: string; passed: boolean; output?: string }`,
    `isVerifiableEvidence(...)`.
  - `AffectedFlow { id; name; files: string[]; note?: string }`.
  - `Card` polimórfico (`type`, `parentId`, `key`), `DodItem`.
- **`events.ts`** — eventos WS. Ex.: `IterationAppendedEvent { type:'iteration.appended'; taskId; iteration: Iteration }`,
  `StoryEnteredInProgressEvent`. **Novos eventos WS devem ser adicionados aqui**
  e ao union type de eventos.
- **`index.ts`** — barrel que re-exporta `enums`, `domain`, `events`, `dtos`,
  `chat-format`, `backlog-chat`. **Todo tipo novo precisa ser re-exportado aqui**
  para ficar visível a web e api.

> **Regra de ouro (invariante de contrato):** mudou algo em `packages/shared`?
> Atualize os **dois** consumidores (web **e** api) na **mesma** mudança e
> re-exporte via `index.ts`. `packages/shared` é **CommonJS** — não use ESM-only.

### 1.2 Loop engine — `apps/api/src/modules/ai-engine/`

- **`orchestrator.ts`** (núcleo, ~2100 linhas). Símbolos verificados:
  - `resolveStoryProject(storyId)` (linha 271) — resolve o `aiProject` da story
    (herda do épico pai). Retorna `null` se não houver alvo.
  - Uso do workspace service (campo `this.workspaces`):
    - `this.workspaces.resolveTargetRepo(raw)` (linha 284)
    - `cwd = await this.workspaces.resolveWorkdir(storyId, context.project)` (linha 369)
    - `void this.workspaces.cleanupWorktree(storyId)` (linhas 1174, 1510, 1522)
  - `captureTreeBaseline(cwd)` (chamado ~linha 397) — snapshot do working tree
    **antes** do agent rodar (usa `GIT_INDEX_FILE` temporário).
  - `captureDiff(cwd, baseline)` — calcula o diff **desta** iteração. **Git é
    feito pelo ENGINE, nunca pelo agent** (ADR-0008: o agent não faz git).
  - `appendIteration(...)` (~linha 1979) — persiste `Iteration` via
    `prisma.iteration.create` numa transação; `index = count + 1`.
  - `computeStoryMetrics(storyId)` (~linha 1774) — monta o `LoopMetrics` acima.
  - `enforceLoopGuards(...)` (~linha 1600) — serialização e guard-rails.
- **`ai-engine.controller.ts`** — `@Controller('cards')`. Tem
  `GET /cards/:id/loop/metrics` chamando `computeStoryMetrics`. **Atenção: este
  controller é escopado em `cards`** — um endpoint `/dashboard` **não** cabe aqui;
  precisa de controller próprio (ver US-OBS1).
- **`ai-engine.module.ts`** — DI. `AGENT_RUNNER` amarrado a `CopilotCliRunner`
  via `useExisting`.

### 1.3 Runners / adapter — `apps/api/src/modules/ai-engine/runners/`

- **`agent-runner.interface.ts`**
  - `interface AgentRunner { readonly id: string; run(input: AgentRunInput): Promise<AgentRunResult>; }`
  - DI token `AGENT_RUNNER`.
  - `AgentRunResult` (campos): `detail`, `summary`, `dodTouched`, `proposedDod`,
    `affectedFlows`, `learnings`, `nextStep`, `done`, `evidence: string | StructuredEvidence`,
    `inputTokens`, `outputTokens`, `fatalError`.
- **`cli-adapter.ts`** — `CliAdapter`: `buildSpawnPlan(...)`, `parseLine(...)`
  (parse do protocolo **JSONL**), `parseTokenUsage(line)` (regex do rodapé de
  stats **não-JSON** do CLI → input/output tokens), `parseEvidence`,
  `parseAffectedFlows`, `parseLearnings`. Configurável por env:
  `AGENT_CLI_COMMAND` (default `copilot`), `AGENT_CLI_ARGS`,
  `AGENT_CLI_PROMPT_MODE` (`stdin|arg`), `AGENT_RUNNER_KIND` (`mock|copilot-cli`).
- **`copilot-cli.runner.ts`** — `CopilotCliRunner` (`id='copilot-cli'`, default).
  `consume(...)` faz backfill de `inputTokens/outputTokens` a partir do rodapé
  parseado quando o resultado JSONL estruturado os omite.
- **`mock-agent.runner.ts`** — runner de teste.

### 1.4 Persistência de iteração — `apps/api/src/modules/cards/`

- `iteration.mapper.ts` → `mapIteration(row): Iteration` (linha 32).
- `cards.service.ts` → usa `mapIteration` ao montar o card (linha 180).
- **O diretório `apps/api/src/modules/ai-engine/iterations/` está VAZIO** — não
  há arquivo-fonte lá; a persistência mora no `orchestrator.ts` (`appendIteration`).

### 1.5 Web — `apps/web/src/`

- `features/ai-engine/components/LoopMetricsPanel.tsx` — painel de custo/tokens
  (consome `totalInputTokens`/`totalOutputTokens` do `LoopMetrics`). **Base de UI
  para dashboard/review.**
- `features/ai-engine/hooks/useLoop.ts` — `useLoopMetrics(storyId)` com react-query
  e `queryKeys.loopMetrics(storyId)`.
- `shared/services/apiClient.ts` — padrão `getLoopMetrics(storyId)` →
  `request<LoopMetrics>('/cards/${storyId}/loop/metrics')`.
- `features/board/services/queryKeys.ts` — fábrica de query keys.

### 1.6 Schema — `apps/api/prisma/schema.prisma`

Models existentes: `Card`, `Iteration`, `AffectedFlow`, `DodItem`, `AgentMessage`.
- `Iteration` tem `evidence`, `diff`, `durationMs`, `inputTokens`, `outputTokens`,
  `outcome`.
- **NÃO existe** tabela de review-comments (US-OBS3 cria).
- **NÃO existe** agregação/endpoint de dashboard (US-OBS1 cria; é read-model, sem
  tabela nova).

### 1.7 Config — `apps/api/src/shared/config/config.ts`

Bloco de agente (~linhas 240-268): `AGENT_SERIALIZE_BY_REPO` (default `false`,
existe **justamente porque o worktree é stub** — serializa por repo-alvo para
evitar colisão), `AGENT_CLI_*`, `AGENT_RUNNER_KIND`. Novas flags seguem esta
convenção (`process.env.NOME ?? default`, coerção explícita).

---

## US-OBS1 — Dashboard de frota

### Estado atual (verificado)

- **Não existe** endpoint agregado de frota. O único endpoint de métrica é
  `GET /cards/:id/loop/metrics` em `ai-engine.controller.ts`
  (`@Controller('cards')`), que devolve `LoopMetrics` de **uma** story.
- `Orchestrator.computeStoryMetrics(storyId)` (`orchestrator.ts` ~1774) já produz
  `totalInputTokens`, `totalOutputTokens`, `iterationCount`, `derivedTaskRate`,
  `okIterationRate`, `perTask[]` por story — **reutilizável** para agregação.
- Board/colunas: `boards.controller.ts` (`@Controller('boards')`) e
  `cards.service.ts` já leem cards. Colunas em `enums.ts` (`BOARD_COLUMNS`).
- `health.controller.ts` (`@Controller('health')`) é o padrão mais simples de
  controller que retorna objeto plano.
- Web já tem o padrão completo request→hook→painel (`LoopMetricsPanel`,
  `useLoopMetrics`, `apiClient.getLoopMetrics`, `queryKeys.loopMetrics`).

### Gap

Falta um **read-model agregado da frota inteira** e a UI correspondente:
1. Contagem de cards por coluna do board.
2. Stories "stale" (paradas há muito tempo em `In Progress` sem iteração nova).
3. Burn/cost agregado (soma de tokens e iterações de todas as stories ativas).
4. Endpoint HTTP dedicado + método no `apiClient` + hook + painel/página.
5. **Não expor segredo**: o dashboard **nunca** deve retornar `aiProject`
   (caminho de FS do usuário), env, tokens de credencial, nem transcript bruto.

### Contrato proposto — `packages/shared/src/domain.ts`

Adicione (e re-exporte em `index.ts`):

```ts
/** Contagem de cards por coluna do board (frota). Compartilhado api↔web. */
export interface FleetColumnCount {
  column: string;   // um valor de BOARD_COLUMNS
  epics: number;
  stories: number;
  tasks: number;
  total: number;
}

/** Story em "In Progress" sem progresso recente (heurística de staleness). */
export interface FleetStaleStory {
  storyId: string;
  key: string;                 // US-...
  title: string;
  execState: string;           // ExecState em runtime (pode vir 'blocked-dep')
  lastIterationAt: string | null; // ISO; null se nunca iterou
  staleMinutes: number;        // minutos desde a última iteração (ou entrada In Progress)
}

/** Burn/cost agregado da frota. NUNCA inclui segredos (path/env/token). */
export interface FleetCostSummary {
  activeStories: number;       // stories com loop ativo (In Progress)
  totalIterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  derivedTaskRate: number;     // média ponderada por iterações
  okIterationRate: number;     // média ponderada por iterações
}

/** Resposta de GET /dashboard. Read-model agregado, sem segredos. */
export interface FleetDashboard {
  generatedAt: string;         // ISO
  columns: FleetColumnCount[]; // ordenado como BOARD_COLUMNS
  staleStories: FleetStaleStory[];
  cost: FleetCostSummary;
}
```

**Shape exato da resposta HTTP** de `GET /dashboard` = o objeto `FleetDashboard`
serializado como JSON. Ex.:

```json
{
  "generatedAt": "2025-05-20T12:00:00.000Z",
  "columns": [
    { "column": "Backlog", "epics": 2, "stories": 5, "tasks": 0, "total": 7 },
    { "column": "In Progress", "epics": 0, "stories": 1, "tasks": 3, "total": 4 }
  ],
  "staleStories": [
    { "storyId": "c1", "key": "US-OBS2", "title": "Worktree resiliente",
      "execState": "implementing", "lastIterationAt": "2025-05-20T11:30:00.000Z",
      "staleMinutes": 30 }
  ],
  "cost": {
    "activeStories": 1, "totalIterations": 12,
    "totalInputTokens": 34012, "totalOutputTokens": 9821,
    "derivedTaskRate": 0.25, "okIterationRate": 0.75
  }
}
```

### Plano PR-a-PR

**PR-1 (contrato):** `packages/shared/src/domain.ts` (+ tipos acima) e
`packages/shared/src/index.ts` (re-export). Só o contrato — build de shared verde.

**PR-2 (API):**
1. Criar `apps/api/src/modules/dashboard/dashboard.service.ts`:
   - Injeta `PrismaService` e `Orchestrator`.
   - `columns`: `prisma.card.groupBy` por `column` + `type`, mapeado para
     `FleetColumnCount[]` na ordem de `BOARD_COLUMNS`.
   - `staleStories`: busca stories com `column === 'In Progress'`; para cada,
     pega a última `Iteration` (`orderBy index desc, take 1`) e calcula
     `staleMinutes` a partir de `updatedAt`/`createdAt` da iteração ou da story;
     ordenar desc por `staleMinutes`. Threshold configurável via nova env
     (ex.: `DASHBOARD_STALE_MINUTES`, default 30) em `config.ts`.
   - `cost`: itera as stories ativas, chama `orchestrator.computeStoryMetrics`
     (reuso) e agrega (`derivedTaskRate`/`okIterationRate` como média **ponderada
     por `iterationCount`**).
   - **Sanitização obrigatória:** o método **não** seleciona nem retorna
     `aiProject`, nem qualquer campo de env/credencial/transcript.
2. Criar `apps/api/src/modules/dashboard/dashboard.controller.ts`
   (`@Controller('dashboard')`, `@Get()` → `Promise<FleetDashboard>`).
3. Criar `apps/api/src/modules/dashboard/dashboard.module.ts` e registrá-lo no
   array `imports` de `apps/api/src/app.module.ts`.

**PR-3 (Web):**
1. `apps/web/src/shared/services/apiClient.ts`:
   `getFleetDashboard(): Promise<FleetDashboard>` → `request<FleetDashboard>('/dashboard')`.
2. `apps/web/src/features/board/services/queryKeys.ts`: adicionar
   `dashboard: () => ['dashboard'] as const`.
3. `apps/web/src/features/dashboard/hooks/useFleetDashboard.ts`: react-query com
   `queryKeys.dashboard()` (refetch por polling curto, ex.: 15s).
4. `apps/web/src/features/dashboard/components/FleetDashboardPanel.tsx`:
   reusar padrão visual do `LoopMetricsPanel` (cards de coluna, lista de stale,
   bloco de custo). Exportar via `index.ts` da feature.

### Pontos de integração

- **Orchestrator:** reuso puro de `computeStoryMetrics` (não altere a assinatura).
- **Prisma:** apenas leitura/aggregate; **nenhuma migration**.
- **Web:** mesmo pipeline request→hook→painel do `LoopMetricsPanel`.
- **app.module.ts:** registrar o novo `DashboardModule`.

### DOD verificável

- `npm run build && npm run lint && npm test` verdes na raiz.
- `curl localhost:3333/dashboard` retorna JSON com as chaves `generatedAt`,
  `columns`, `staleStories`, `cost` e **sem** `aiProject`/env/token.
- Spec novo `apps/api/src/modules/dashboard/dashboard.service.spec.ts`:
  - agrega counts por coluna corretamente;
  - marca como stale só stories em `In Progress` acima do threshold;
  - `cost` soma tokens/iterações e pondera as taxas;
  - **assert de não-vazamento**: o objeto retornado não contém a string do
    `aiProject`.

### Riscos / invariantes / retrocompat

- **Segredo:** o maior risco é vazar `aiProject`/env. O spec de não-vazamento é
  obrigatório.
- **Invariantes:** dashboard é **read-only** — não move epic (invariante 2), não
  cria task fora de Backlog/To Do (invariante 3). Só lê.
- **Retrocompat:** endpoint novo, contratos novos aditivos; nada quebra.
- **Sem dependência do worktree real.**

---

## US-OBS2 — Worktree resiliente

### Estado atual (verificado) — LEIA COM ATENÇÃO

Há **dois** `WorkspaceService` no repo, e isso muda tudo:

1. **`apps/api/src/modules/ai-engine/workspaces/workspace.service.ts`** — **é o
   REAL e é o que o orchestrator usa** (importado por `ai-engine.module`). **NÃO
   é stub.** Métodos públicos verificados:
   - `resolveWorkdir(key, targetRepoPath?)` (linha 54) — resolve o repo-alvo,
     valida (existe, é git, não é o próprio kanban-ai via `isInsideSelfRepo`),
     garante commit inicial (`ensureInitialCommit`) e **retorna o caminho do
     próprio repo-alvo — SEM criar worktree**. Log literal:
     `"workdir do agent resolvido para o repo-alvo (sem worktree)"`.
   - `resolveTargetRepo(targetRepoPath?)` (linha 104), `cleanupWorktree(key)`
     (linha 366 — **não** roda `git worktree remove`; só solta tracking em
     memória, senão apagaria o trabalho do agent), `runProjectChecks`,
     `findRelatedTestFiles`, `runTestsForFiles`, `fileExistsInWorktree`,
     `ensureInitialCommit`.
   - **Conclusão:** o agent trabalha **DIRETO no working tree do repo-alvo**
     (`aiProject`). Não há isolamento por worktree, nem branch, nem commit
     automático. A colisão entre stories é resolvida por **SERIALIZAÇÃO** (uma
     story `In Progress` por repo-alvo), não por isolamento — daí a flag
     `AGENT_SERIALIZE_BY_REPO` em `config.ts`.

2. **`apps/api/src/workspaces/workspace.service.ts`** — **é o STUB**, com
   `ensureWorktree(storyId, targetRepo)` que loga `"ensureWorktree() STUB"` e
   retorna `${base}/${storyId}` (TODOs), e `cleanupWorktree()` stub. Está
   registrado num `WorkspacesModule` `@Global()` (`apps/api/src/workspaces/workspaces.module.ts`,
   importado em `app.module.ts` linhas 5 e 22). **Mas o orchestrator NÃO chama
   `ensureWorktree`** — ele chama `resolveWorkdir`/`cleanupWorktree` do serviço
   **do módulo ai-engine**. Ou seja, o stub top-level está **efetivamente morto**
   no caminho do loop (é o vestígio da fundação inicial).

### Gap e **PRÉ-REQUISITO de desbloqueio (obrigatório antes do escopo funcional)**

A US-OBS2 pede: **espelhar ignored paths (node_modules), init submodules,
preservar patch ao trash/restart**. Todos esses requisitos **pressupõem um
worktree isolado por execução** (ADR-0008). Esse worktree **não existe** hoje
(ver Estado atual). Logo:

> **PRÉ-REQUISITO BLOQUEANTE:** implementar o **worktree isolado real por
> execução** dentro de `apps/api/src/modules/ai-engine/workspaces/workspace.service.ts`,
> transformando `resolveWorkdir(key, targetRepoPath)` para criar/retornar um
> **worktree git** (`git worktree add <path> <branch>`) em vez do próprio
> repo-alvo, com `cleanupWorktree` fazendo `git worktree remove` de verdade. Ver
> **ADR-0008** (git-worktree-per-execution) e **ADR-0019** (API roda no host
> justamente porque o `cwd` do spawn é um worktree no FS do usuário).

**Enquanto o worktree isolado não existir, os itens funcionais de mirror/
submodule/patch-preserve ficam BLOQUEADOS** (não há para onde espelhar). Não os
implemente contra o repo-alvo direto — isso poluiria o repositório do usuário e
violaria o espírito do ADR-0008.

**O que dá para especificar/entregar já (sem desbloquear tudo):**
- **Contrato/política de worktree** (tipos + flags de config) — abaixo.
- **Guard-rails de segurança** já existentes a preservar (`isInsideSelfRepo`,
  validação git, `ensureInitialCommit`).
- **Testes de política** (unidade) que exercitam a decisão de mirror/submodule
  como funções puras, mesmo antes do worktree existir.

### Contrato proposto

**(a) Config — `apps/api/src/shared/config/config.ts`** (novas flags, mesma
convenção do bloco de agente):

```ts
// Worktree resiliente (US-OBS2). Só têm efeito quando o worktree isolado real
// (ADR-0008) estiver implementado em resolveWorkdir().
worktreeIsolated: (process.env.AGENT_WORKTREE_ISOLATED ?? 'false') === 'true',
worktreeMirrorIgnored: (process.env.AGENT_WORKTREE_MIRROR_IGNORED ?? 'true') === 'true',
worktreeInitSubmodules: (process.env.AGENT_WORKTREE_INIT_SUBMODULES ?? 'true') === 'true',
worktreePreservePatch: (process.env.AGENT_WORKTREE_PRESERVE_PATCH ?? 'true') === 'true',
```

**(b) (opcional) Tipo de política — `packages/shared/src/domain.ts`:**

```ts
export interface WorktreePolicy {
  isolated: boolean;         // usa git worktree add por execução
  mirrorIgnoredPaths: boolean; // espelha paths ignorados (ex.: node_modules)
  initSubmodules: boolean;   // git submodule update --init --recursive
  preservePatchOnTrash: boolean; // stash/diff ao descartar/reiniciar
}
```

### Plano PR-a-PR

> Os PRs 2+ **só devem ser abertos após o PR de desbloqueio** (worktree real).

**PR-0 (desbloqueio — pré-requisito):** em
`modules/ai-engine/workspaces/workspace.service.ts`, atrás de
`config.worktreeIsolated`:
1. `resolveWorkdir` cria um branch de execução (ex.: `kanban-ai/<key>`) e um
   worktree isolado (`git worktree add <base>/<safeKey> <branch>`), retornando o
   caminho do worktree. Fallback para o comportamento atual quando
   `worktreeIsolated=false` (retrocompat).
2. `cleanupWorktree` passa a rodar `git worktree remove --force` **apenas** para
   worktrees isolados (nunca contra o repo-alvo direto).
3. Preservar todos os guard-rails atuais (`isInsideSelfRepo`, `ensureInitialCommit`).
4. Specs cobrindo criação/remoção do worktree isolado.

**PR-1 (config + política):** flags em `config.ts` + (opcional) `WorktreePolicy`
em shared/index. Specs de coerção das flags.

**PR-2 (mirror de ignored paths):** ao criar o worktree, se
`worktreeMirrorIgnored`, materializar paths ignorados pesados (ex.: `node_modules`)
via **symlink** (preferencial, barato) ou cópia, lendo `.gitignore`/`git check-ignore`.
Spec: dado repo com `node_modules` ignorado, o worktree tem o link/cópia.

**PR-3 (submodules):** se `worktreeInitSubmodules`, rodar
`git submodule update --init --recursive` no worktree. Spec: repo com submódulo
fica populado.

**PR-4 (patch-preserve):** ao trash/restart de uma sessão, se
`worktreePreservePatch`, capturar o patch (reuso do padrão de
`captureTreeBaseline`/`captureDiff` do orchestrator — **git é do engine**) e
reaplicá-lo no worktree recriado. Spec: patch não-commitado sobrevive a um
restart simulado.

### Pontos de integração

- **`orchestrator.ts`**: chama `resolveWorkdir` (linha 369) e `cleanupWorktree`
  (1174/1510/1522). A assinatura pública **não deve mudar** — só o comportamento
  interno atrás da flag.
- **`captureTreeBaseline`/`captureDiff`**: reuso para patch-preserve. **O agent
  continua proibido de fazer git** (ADR-0008).
- **`config.ts`**: flags novas.
- **STUB morto:** avaliar remover `apps/api/src/workspaces/` (stub top-level) e
  seu `WorkspacesModule` **em PR separado** de limpeza, para não confundir
  futuros implementadores. Confirmar antes que nada mais o injeta (hoje só
  `app.module.ts` o importa; o orchestrator usa o serviço do módulo ai-engine).

### DOD verificável

- `npm run build && npm run lint && npm test` verdes.
- Com `AGENT_WORKTREE_ISOLATED=true`: uma execução cria worktree isolado
  (`git worktree list` mostra o path), o agent roda lá, e `cleanupWorktree`
  remove o worktree **sem** tocar o repo-alvo.
- Specs de mirror/submodule/patch-preserve verdes.
- Retrocompat: com a flag `false`, comportamento idêntico ao atual (roda direto
  no repo-alvo).

### Riscos / invariantes / retrocompat / dependência do worktree real

- **Dependência dura:** sem o PR-0 (worktree real) os PRs 2-4 são **inúteis**.
  Deixe explícito no PR e no board que OBS2 espera OBS2/PR-0.
- **Risco de poluir o repo do usuário:** nunca espelhar/commitar contra o
  repo-alvo direto. Só dentro do worktree isolado.
- **Invariante ADR-0008:** o **agent não faz git**; todo git é do engine.
- **Invariante ADR-0019:** API roda no host; o `cwd` do spawn é caminho arbitrário
  do FS — mantenha caminhos absolutos e `isInsideSelfRepo`.
- **Serialização:** enquanto worktree não for isolado, mantenha
  `AGENT_SERIALIZE_BY_REPO` como rede de proteção.

---

## US-OBS3 — Review inline por linha + auto-commit/PR opcional

### Estado atual (verificado)

- **Evidência estruturada já existe**: `StructuredEvidence`/`EvidenceCheck` em
  `domain.ts`; `isVerifiableEvidence()`; a `Iteration` guarda `evidence` e `diff`.
- **Diff por iteração já existe**: `captureTreeBaseline` + `captureDiff` no
  `orchestrator.ts` (git pelo engine). O `diff` fica na `Iteration`.
- **NÃO existe** model de comentário de review por linha no
  `schema.prisma`, nem endpoint para criá-los/listá-los, nem evento WS.
- **Auto-commit/PR**: o engine já sabe fazer git (captura diff), mas **não há**
  fluxo de commit/PR opt-in. Hoje as mudanças ficam no working tree do repo-alvo
  (ver US-OBS2 — sem worktree isolado).

### Gap

1. Persistir **comentários de review por linha** (arquivo + linha + corpo),
   vinculados à task/iteração, tratáveis como **evidência**.
2. UI para exibir/adicionar comentários por linha no diff.
3. **Auto-commit/PR opcional**: commitar (e opcionalmente abrir PR) **somente
   após validação verde** (`EvidenceCheck.passed` em todos os checks
   verificáveis) **e** com **opt-in** explícito (flag/por-card).

### Contrato proposto

**(a) Prisma — `apps/api/prisma/schema.prisma`** (novo model + relação):

```prisma
model ReviewComment {
  id          String   @id @default(cuid())
  cardId      String                 // task ou story alvo do comentário
  card        Card     @relation(fields: [cardId], references: [id], onDelete: Cascade)
  iterationId String?                // iteração que originou o comentário (opcional)
  filePath    String                 // caminho relativo no repo-alvo
  line        Int                    // linha (1-based) no arquivo pós-diff
  body        String                 // corpo do comentário (markdown)
  author      String                 // 'agent:copilot-cli' | 'human:<id>'
  resolved    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([cardId])
  @@index([cardId, filePath])
}
```
> Adicionar o lado inverso em `Card`: `reviewComments ReviewComment[]`.
> Migration: `npm run db:migrate` (nome ex.: `add_review_comment`). Sem seed novo.

**(b) TS — `packages/shared/src/domain.ts`** (+ `index.ts`):

```ts
export interface ReviewComment {
  id: string;
  cardId: string;
  iterationId: string | null;
  filePath: string;
  line: number;         // 1-based
  body: string;
  author: string;       // 'agent:<runnerId>' | 'human:<id>'
  resolved: boolean;
  createdAt: string;    // ISO
  updatedAt: string;    // ISO
}

export interface ReviewCommentInput {
  cardId: string;
  iterationId?: string | null;
  filePath: string;
  line: number;
  body: string;
  author: string;
}

/** Desfecho do auto-commit/PR opcional (US-OBS3). */
export interface CommitOutcome {
  committed: boolean;
  commitSha?: string;
  branch?: string;
  prUrl?: string;       // presente só se PR foi aberto
  skippedReason?: string; // ex.: 'validation-not-green' | 'opt-in-disabled'
}
```

**(c) Evento WS — `packages/shared/src/events.ts`** (+ union):

```ts
export interface ReviewCommentAddedEvent {
  type: 'review.comment_added';
  cardId: string;
  comment: ReviewComment;
}
```

### Plano PR-a-PR

**PR-1 (contrato + schema):** `schema.prisma` (model `ReviewComment` + inverso em
`Card`) + migration; `domain.ts`/`events.ts`/`index.ts`. `npm run db:migrate`.

**PR-2 (API — comentários):**
1. `apps/api/src/modules/review/review.service.ts`: `addComment(input)`,
   `listByCard(cardId)`, `resolve(id)`. Usa `PrismaService`.
2. Controller `@Controller('cards')` estendido **ou** novo `review.controller.ts`
   com rotas `POST /cards/:id/review/comments`, `GET /cards/:id/review/comments`,
   `PATCH /cards/:id/review/comments/:commentId/resolve`.
3. `review.module.ts` registrado em `app.module.ts`.
4. Emitir `ReviewCommentAddedEvent` pelo mesmo canal WS dos demais eventos.
5. **Ponte de evidência:** ao persistir um comentário de agent, mapear para um
   `EvidenceCheck` (`name='review:<file>:<line>'`, `passed=resolved`) ou anexar
   ao `StructuredEvidence.note` da iteração corrente (decidir no PR; documentar).

**PR-3 (Web — UI):** `features/review/` com componente de diff anotável (reusa o
diff da `Iteration`), hook `useReviewComments(cardId)`, métodos no `apiClient`
(`addReviewComment`, `getReviewComments`, `resolveReviewComment`) e query keys.

**PR-4 (auto-commit/PR opcional):**
1. Nova flag `AGENT_AUTO_COMMIT` (default `false`) + `AGENT_AUTO_PR` (default
   `false`) em `config.ts`; opt-in por-card via campo do `Card` (avaliar) ou só
   por env no v1.
2. No `orchestrator.ts`, **após a validação da iteração**: só commitar se
   **todos** os `EvidenceCheck` verificáveis tiverem `passed=true`
   (`isVerifiableEvidence`) **e** o opt-in estiver ligado. Reusar o padrão de git
   do engine (nunca o agent). Se worktree isolado (US-OBS2) existir, commit vai no
   branch de execução; senão, **abortar auto-commit** e retornar
   `CommitOutcome.skippedReason='no-isolated-worktree'` (evita commitar no working
   tree do usuário sem isolamento).
3. PR opcional (`AGENT_AUTO_PR`) via `gh`/API — só se houver `commitSha` e
   `prUrl` retornável. Nunca commitar/abrir PR com validação vermelha.

### Pontos de integração

- **`orchestrator.ts`**: `appendIteration` (anexar comentário/evidência),
  `captureDiff` (base do diff anotável), gate de validação verde para auto-commit.
- **`workspaces/workspace.service.ts`**: commit vai no worktree isolado (depende
  de US-OBS2 para ter valor pleno).
- **WS**: novo evento `review.comment_added`.
- **Web**: nova feature `review/` reusando o diff da iteração.

### DOD verificável

- `npm run build && npm run lint && npm test` verdes; `npm run db:migrate` aplica
  o model novo.
- Spec API: `addComment` persiste e é listado por card; `resolve` alterna
  `resolved`; evento `review.comment_added` é emitido.
- Spec do gate: auto-commit **não** ocorre com evidência não-verde
  (`isVerifiableEvidence` falso ou algum `passed=false`) **nem** com opt-in
  desligado (`CommitOutcome.committed=false` + `skippedReason`).
- Spec de isolamento: sem worktree isolado, auto-commit é pulado com
  `skippedReason='no-isolated-worktree'`.

### Riscos / invariantes / retrocompat

- **Risco de commitar no repo do usuário sem isolamento** — mitigado pelo gate
  `no-isolated-worktree` (amarra a US-OBS2).
- **Invariante ADR-0007:** review por linha **não** reintroduz DOR/acceptance; o
  único gate de conclusão continua sendo o **DOD**. Comentários de review são
  evidência/observabilidade, **não** um novo checklist obrigatório.
- **Invariante ADR-0008:** commit é do **engine**, nunca do agent.
- **Retrocompat:** tudo aditivo; auto-commit é opt-in (default off).

---

## US-OBS4 — Multi-agent adapters (Claude / Codex / Gemini)

### Estado atual (verificado)

- Abstração de runner já existe: `AgentRunner` (`runners/agent-runner.interface.ts`)
  com `run(input): Promise<AgentRunResult>` e `readonly id`; DI token `AGENT_RUNNER`.
- `CopilotCliRunner` (`id='copilot-cli'`) é o **default**, amarrado por
  `useExisting` em `ai-engine.module.ts`.
- `CliAdapter` (`runners/cli-adapter.ts`) isola comando/flags/parse JSONL e o
  parse do rodapé de tokens (`parseTokenUsage`), configurável por env
  (`AGENT_CLI_COMMAND`, `AGENT_CLI_ARGS`, `AGENT_CLI_PROMPT_MODE`,
  `AGENT_RUNNER_KIND` `mock|copilot-cli`).
- `mock-agent.runner.ts` mostra o segundo runner possível.

### Gap

Não há **registry** de adapters por vendor nem seleção de adapter além de
`mock|copilot-cli`. Falta abstrair a camada para suportar Claude/Codex/Gemini
**mantendo `copilot-cli` como default** e sem mudar o `AgentRunner`.

### Contrato proposto — `packages/shared/src/domain.ts` (+ `index.ts`)

```ts
export type AgentAdapterKind = 'copilot-cli' | 'claude' | 'codex' | 'gemini' | 'mock';

export interface AgentAdapterDescriptor {
  kind: AgentAdapterKind;
  displayName: string;
  isDefault: boolean;
  available: boolean;   // binário/credencial presentes (sem expor a credencial!)
}
```

### Plano PR-a-PR

**PR-1 (contrato):** `AgentAdapterKind`/`AgentAdapterDescriptor` em shared+index.

**PR-2 (registry):** `runners/agent-adapter.registry.ts` que mapeia
`AgentAdapterKind → AgentRunner`. `AGENT_RUNNER` passa a resolver via registry a
partir de nova env `AGENT_ADAPTER` (default `copilot-cli`). Manter `useExisting`
do `CopilotCliRunner` como fallback. `config.ts` ganha `AGENT_ADAPTER`.

**PR-3 (adapters por vendor):** cada vendor é um `AgentRunner` que **reusa
`CliAdapter`** com comando/flags/parse próprios (Claude/Codex/Gemini têm seus
próprios CLIs e formatos). Implementar 1 por PR, começando pelo que estiver
disponível no ambiente. `available` reflete presença do binário/credencial
**sem** logar/retornar segredo.

**PR-4 (endpoint/registro):** (opcional) `GET /agents/adapters` →
`AgentAdapterDescriptor[]` para a UI listar/selecionar o adapter (nunca expor
credencial). **Já existe** `apps/api/src/modules/models/models.controller.ts`
com `@Controller('agents')` (expõe `GET /agents/models`) — adicione a rota
`adapters` **neste** controller/módulo para não criar um controller solto. Web:
seletor de adapter por-card/global (o `apiClient` já consome `/agents/models`,
padrão a espelhar).

### Pontos de integração

- **`ai-engine.module.ts`**: DI de `AGENT_RUNNER` via registry.
- **`runners/cli-adapter.ts`**: reuso do parse JSONL/token para novos vendors.
- **`config.ts`**: `AGENT_ADAPTER` + envs por vendor.
- **Web (opcional):** seletor de adapter.

### DOD verificável

- `npm run build && npm run lint && npm test` verdes.
- Com `AGENT_ADAPTER=copilot-cli` (default), comportamento idêntico ao atual
  (nenhuma regressão no runner default).
- Spec do registry: resolve o runner certo por `AgentAdapterKind`; default é
  `copilot-cli`; `available` não vaza credencial.
- Cada adapter novo tem spec de parse (JSONL + rodapé de tokens) com fixture do
  vendor.

### Riscos / invariantes / retrocompat

- **Risco de regressão no default:** manter `copilot-cli` como default e cobrir
  com spec de "sem regressão".
- **Segredo:** `available`/descriptors **nunca** expõem chaves/credenciais.
- **Invariantes:** contrato `AgentRunner`/`AgentRunResult` **não muda** — vendors
  se adaptam a ele.
- **Retrocompat:** tudo aditivo; feature futura, faça por último.

---

## Anexo — Comandos de validação (todas as US)

```bash
# na raiz do monorepo
npm run build && npm run lint && npm test

# smoke do backend
curl localhost:3333/health
curl localhost:3333/dashboard      # US-OBS1

# banco (US-OBS3 adiciona model)
npm run db:migrate
npm run db:seed
```

> Em ambientes onde o Prisma Query Engine não abre TCP de saída, rode as
> operações de banco dentro da rede do Docker (ver `CONTRIBUTING.md`).

## Anexo — Invariantes do domínio (releitura obrigatória antes do commit)

1. Hierarquia **Epic → Story → Task** num `Card` polimórfico (`key` `EP-/US-/TK-`).
2. **Epic é derivado** das stories — ninguém move epic direto.
3. **Task só se cria** em `Backlog`/`To Do` (`TASK_CREATION_COLUMNS`).
4. **Sem DOR e sem `acceptance`** (ADR-0007) — o único gate é o **DOD**. **Não
   reintroduzir** (atenção especial em US-OBS3).
5. Story points ∈ `{1,2,3,5,8,13}` (só story/epic).
6. Loop dispara quando **story → In Progress**.
7. Concorrência **por-story serializada por epic**, **in-process** (sem Redis).
8. **Agent não faz git** (ADR-0008); **API roda no host** (ADR-0019).

## Anexo — Higiene de commits

Commits atômicos, mensagem semântica no imperativo. Exemplos:

```
feat(dashboard): adiciona GET /dashboard com counts, stale e cost agregados
feat(shared): adiciona contratos FleetDashboard e ReviewComment
feat(review): persiste comentários de review por linha como evidência
feat(workspaces): worktree isolado por execução atrás de flag (ADR-0008)
```

Inclua o trailer:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```
