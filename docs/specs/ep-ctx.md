# EP-CTX — Enriquecimento de contexto no re-dispatch (spec implementável)

> **Fonte:** `kanban.md` (rodada 2 de melhorias — Hermes N2/N7 + Paperclip #1).
> **Status:** spec-of-truth para 3 stories (US-CTX1..3). Os implementers seguem
> este documento — não re-derivam decisões. Toda mudança é **aditiva e
> retrocompatível** (colunas nullable / com default; nenhum contrato existente
> quebra; o loop atual continua funcionando com os campos vazios).

## 1. Contexto e problema

Quando uma story é **re-claim após crash** (M4 / recovery por lease) ou um
**dependente auto-inicia** (M3 / `advanceEpic` + `wakeBlockersResolvedDependents`),
o novo loop começa **sem sinal** do que já se sabe:

- **Amnésia de falha** — o `buildContext` reconstrói épico→story→task, DOD,
  histórico de iterações, siblings e memória-colmeia, mas **NÃO lê o
  `AgentRuntimeState.lastError`** (a última causa de morte da sessão anterior).
  Uma story re-claim depois de um crash não recebe "a tentativa anterior morreu
  em X".
- **Handoff pai→filho pobre** — quando a story-pai/blocker fecha, o dependente
  que auto-inicia recebe apenas o resumo textual da story no épico
  (`summarizeStoryToEpic`). Não há um **contrato estruturado** do que o pai
  entregou (arquivos mudados, como verificou, riscos residuais) para o filho
  começar assertivo.
- **Plan-only espera o watchdog** — quando uma iteração só planeja ("vou fazer
  X") sem produzir diff nem fechar DOD, o loop hoje só reage por dois caminhos
  grosseiros: (a) o `setInterval(autoStepIntervalMs)` do auto-play na próxima
  cadência, ou (b) o anti-thrash, que **só compara similaridade de summary** e
  escala para humano. Não há uma **classificação de vivacidade do run** que
  distinga `plan_only`/`empty_response` (merece um **re-wake alvo em segundos**,
  bounded) de `advanced`/`completed` (segue normal) de `blocked`/`failed`.

Maior ROI da rodada 2 no loop: cada iteração fica mais assertiva reusando o que
já se sabe, e runs improdutivos-mas-recuperáveis são retomados em segundos com
uma dica direcionada, sem gastar o orçamento do anti-thrash.

### DOD do épico

- Re-dispatch injeta **"tentativa anterior falhou em X"** no prompt (US-CTX1).
- Filho recebe **metadata estruturado do pai** no contexto (US-CTX2).
- Runs **classificados por liveness** com **continuação bounded** para
  plan-only/empty (US-CTX3).
- `npm run build && npm run lint && npm test` **verdes**; contratos **type-safe
  nos dois lados** (`packages/shared` consumido por api **e** web).

## 2. Invariantes preservados (checar em cada PR)

1. Hierarquia Epic→Story→Task num único `Card` polimórfico. **EP-CTX é
   ortogonal**: enriquece prompt/handoff/liveness, não mexe na hierarquia.
2. Epic é derivado — ninguém move epic direto. **Não alterado.**
3. Task só se cria em Backlog/To Do. **Não alterado.**
4. **Sem DOR e sem `acceptance` no v1** — único checklist é o DOD. **NÃO
   reintroduzir.** `Card.completionMetadata` é um snapshot de HANDOFF pós-done,
   **não** um checklist e **não** um critério de entrada.
5. Story points ∈ {1,2,3,5,8,13}. **Não alterado.**
6. Loop engine só dispara quando story entra em In Progress. **Não alterado** —
   as continuações bounded (US-CTX3) são re-dispatch de uma story JÁ ativa
   (`everInProgress`), via a `WakeupQueueService` durável existente.
7. Processamento in-process (sem Redis) — ADR-0019/0032. As continuações usam a
   `WakeupQueueService` (Postgres) já existente + o `setInterval` do auto-play;
   **não** um broker novo.
8. Migrations **aditivas** — colunas nullable ou com default, sem backfill
   destrutivo. Nenhuma coluna existente é removida ou renomeada.

## 3. Grafo de dependências das stories

```
US-CTX1 (prior-attempts context — só lê AgentRuntimeState.lastError + outcome)
   → INDEPENDENTE. Sem schema novo. Pode começar imediatamente.

US-CTX2 (completionMetadata JSON + parent-handoff injection)
   → depende do spec (§4/§5.1). Schema aditivo (Card.completionMetadata).

US-CTX3 (run liveness classification + bounded continuations)
   → depende do spec (§4/§5.2). Schema aditivo
     (AgentRuntimeState.continuationAttempt + livenessReason).
```

As três stories tocam o **mesmo arquivo** (`orchestrator.ts`) em regiões
diferentes; os hooks estão isolados por método (§7) para permitir paralelismo.
`enums.ts`/`domain.ts` recebem edições distintas (RunLivenessState vs
CompletionMetadata) — sem colisão.

## 4. Contratos compartilhados (`packages/shared`)

### 4.1 US-CTX2 — `CompletionMetadata` DTO (`packages/shared/src/domain.ts`)

Adicionar (aditivo, exportado pelo barrel `index.ts` se ainda não estiver):

```ts
/**
 * US-CTX2 (EP-CTX / Hermes N7) — snapshot ESTRUTURADO de handoff que uma task
 * grava ao fechar (`done`). NÃO é um checklist (invariante 4): é contexto que o
 * PRÓXIMO trabalho (dependente que auto-inicia via M3) recebe para começar
 * assertivo. Todos os campos são opcionais (retrocompatível: metadata ausente =
 * comportamento atual).
 */
export interface CompletionMetadata {
  /** Arquivos alterados pela task (caminhos relativos ao repo-alvo). */
  changed_files?: string[];
  /** Como o resultado foi verificado (ex.: "build+lint+test verdes", comandos). */
  verification?: string;
  /** Dependências/decisões que o próximo trabalho precisa conhecer. */
  dependencies?: string[];
  /** Notas de retry — o que já se tentou e não funcionou. */
  retry_notes?: string;
  /** Risco residual conhecido deixado para o próximo. */
  residual_risk?: string;
}
```

> **Regra de contrato:** consumido por **api** (grava/injeta) e por **web**
> (exibe no card, futuro). O barrel de `@kanban-ai/shared` DEVE reexportar o
> tipo. Manter o comentário — é a documentação do contrato.

### 4.2 US-CTX3 — `RunLivenessState` (`packages/shared/src/enums.ts`)

Adicionar (seguindo o padrão `LivenessState`/`WakeupState` já presentes no
arquivo — **const object `as const` + type derivado**):

```ts
/**
 * US-CTX3 (EP-CTX / Paperclip #1) — classificação de VIVACIDADE de UM run
 * (iteração) do loop. Diferente de LivenessState (estado da SESSÃO, durável) e
 * de AgentSessionState (efêmero). Alimenta a decisão de continuação bounded:
 *
 *  - completed:      run fechou a task (done + DOD/diff satisfeitos).
 *  - advanced:       progrediu (diff no worktree OU fechou ≥1 item de DOD).
 *  - plan_only:      só planejou (nextStep definido, sem diff nem avanço de DOD).
 *  - empty_response: run sem summary e sem diff e sem DOD (praticamente vazio).
 *  - blocked:        terminou bloqueado (blocked-dep / needs_input).
 *  - failed:         falhou na validação/erro do run.
 *  - needs_followup: pediu HITL (aguardando resposta humana).
 *
 * `plan_only` e `empty_response` disparam CONTINUAÇÃO BOUNDED (re-wake alvo em
 * segundos, até `continuationCap`). Os demais seguem o fluxo normal do loop.
 */
export const RunLivenessState = {
  Completed: 'completed',
  Advanced: 'advanced',
  PlanOnly: 'plan_only',
  EmptyResponse: 'empty_response',
  Blocked: 'blocked',
  Failed: 'failed',
  NeedsFollowup: 'needs_followup',
} as const;
export type RunLivenessState = (typeof RunLivenessState)[keyof typeof RunLivenessState];

/** Estados que merecem continuação bounded (re-wake alvo). */
export const CONTINUABLE_LIVENESS: readonly RunLivenessState[] = [
  RunLivenessState.PlanOnly,
  RunLivenessState.EmptyResponse,
] as const;
```

> **Regra de contrato:** reexportar pelo barrel. O type é usado no api
> (classificação + persistência) e fica disponível ao web para exibição futura.

## 5. Schema Prisma (`apps/api/prisma/schema.prisma`) + migrations

Todas as colunas são **nullable ou com default** (aditivas). Uma migration por
story que toca schema (US-CTX2 e US-CTX3; US-CTX1 não toca schema).

### 5.1 US-CTX2 — `Card.completionMetadata`

No `model Card`, adicionar:

```prisma
  /// US-CTX2 (EP-CTX) — snapshot estruturado de handoff gravado ao fechar a
  /// task (`done`). JSON conforme CompletionMetadata em @kanban-ai/shared.
  /// null = task ainda não fechou / metadata não coletado. Ver ADR-0040.
  completionMetadata Json?
```

Migration: `npx prisma migrate dev --name ctx2_card_completion_metadata --skip-generate`
depois `npx prisma generate`.

> **Gotcha Prisma Json (do EP-BLOCK):** ao gravar, o tipo `CompletionMetadata`
> NÃO é atribuível direto a `Json?`. Use:
> `import { Prisma } from '@prisma/client'` e grave
> `value as unknown as Prisma.InputJsonValue`; para o branch null
> `(value ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue`. Ao ler,
> faça `raw as unknown as CompletionMetadata` de forma defensiva (pode ser
> `null`/`JsonNull`).

### 5.2 US-CTX3 — `AgentRuntimeState.continuationAttempt` + `livenessReason`

No `model AgentRuntimeState` (logo após `lastBlockReason`), adicionar:

```prisma
  // ── Continuação bounded de run improdutivo (EP-CTX / US-CTX3) ─────────────
  /// Tentativas CONSECUTIVAS de continuação bounded (plan_only/empty_response)
  /// da story corrente. Zera em qualquer run `advanced`/`completed`. Cross-run,
  /// durável. Ver ADR-0040.
  continuationAttempt Int @default(0)

  /// Motivo/dica da última continuação (ex.: "run anterior só planejou — execute
  /// o próximo passo agora"). Injetado no próximo prompt. null = sem continuação
  /// pendente.
  livenessReason String?
```

Migration: `npx prisma migrate dev --name ctx3_runtime_continuation --skip-generate`
depois `npx prisma generate`. Prisma migrate status deve ficar **in sync** e
validate **valid**.

## 6. Config (`apps/api/src/config/*`) — US-CTX3

Adicionar ao bloco `agent` da config (seguindo o padrão de `thrashWindow` etc.):

- `continuationCap` (Int, default **2**) — máximo de continuações bounded
  consecutivas antes de deixar o fluxo normal/anti-thrash agir. `0` = feature
  desligada (comportamento atual: só watchdog/auto-step).
- `continuationDelayMs` (Int, default **1500**) — atraso do re-wake alvo (deve
  ser << `autoStepIntervalMs`/`watchdogIntervalMs` para ser "em segundos").

Mapear das env `AGENT_CONTINUATION_CAP` / `AGENT_CONTINUATION_DELAY_MS`. Documentar
no `.env.example` se existir bloco de agent lá.

## 7. Stories em detalhe

### US-CTX1 — Prior-attempts context no re-dispatch (Hermes N2) — **low**

**Objetivo:** quando uma story é re-claim (pós-crash M4), o primeiro run injeta
um bloco **"⚠️ Tentativa anterior"** com a causa da morte anterior +
`outcome` da última iteração — para o agent não repetir o mesmo erro.

**Sem schema novo.** Puro enriquecimento de `buildContext` + `buildPrompt`.

**Hooks (orchestrator.ts):**
1. `buildContext` (L3264+): estender o objeto de retorno com um campo
   `priorAttempt: { lastError: string | null; lastOutcome: string | null } | null`.
   - Ler `AgentRuntimeState` da story (`this.prisma.agentRuntimeState.findUnique({ where: { storyId } })`, defensivo — pode não existir). Pegar `lastError`.
   - Ler o `outcome` da **última** iteração persistida da task
     (`iteration.findFirst({ where: { cardId: taskId }, orderBy: { index: 'desc' }, select: { outcome: true } })`). O campo `outcome` já existe (valores `ok|derived|awaiting-input`).
   - `priorAttempt` só é **não-nulo** quando há sinal real: `lastError` presente
     **OU** já existe ≥1 iteração anterior com outcome relevante. Numa **1ª
     execução** (sem AgentRuntimeState com erro e sem iterações), retornar `null`
     → **nada é injetado** (DOD).
   - Defensivo: qualquer falha de leitura ⇒ `priorAttempt = null` (nunca derruba
     o loop, padrão da casa).
2. `buildPrompt` (L3488+): logo após o bloco de "Memória do projeto" e ANTES do
   "Histórico desta task", se `context.priorAttempt`, empilhar:
   ```
   ## ⚠️ Tentativa anterior (re-dispatch)
   A sessão anterior desta story terminou de forma anômala. NÃO repita o mesmo erro.
   - Última causa de erro registrada: <lastError>
   - Outcome da última iteração: <lastOutcome>
   ```
   Só quando os campos existem (linha a linha condicional).

**DOD (US-CTX1):**
- Story re-claim (AgentRuntimeState com `lastError`) recebe o bloco "Tentativa
  anterior" no prompt.
- 1ª execução (sem runtime state / sem iterações) **não injeta nada**.
- Specs do `buildContext`/`buildPrompt` cobrindo os dois casos (via white-box
  `priv(orch)`).

### US-CTX2 — Completion metadata estruturado + parent-handoff injection (Hermes N7) — **med**

**Objetivo:** ao fechar uma task (`done`), gravar `Card.completionMetadata`
(JSON `CompletionMetadata`); quando a story-pai fecha e o épico encadeia a
próxima story (M3 / `advanceEpic`) — ou quando um dependente é acordado
(`wakeBlockersResolvedDependents`) — injetar esse metadata no contexto do filho.

**Schema:** §5.1. **Contrato:** §4.1. **ADR-0040** (0039 já é do EP-BLOCK).

**Hooks (orchestrator.ts):**
1. **Gravar no `done`:** no caminho onde a task é finalizada com sucesso — o
   ramo `if (effectivePassed)` (~L913, após `setExecState(taskId,'done')` e antes
   de `onTaskDone(taskId)`). Compor `CompletionMetadata` a partir do que já está
   em mãos nessa iteração de validação:
   - `changed_files`: derivar dos `context.files`/`affectedFlows` da task (arquivos
     tocados) — usar `context.files` deduplicado.
   - `verification`: `evidenceToString(runResult.evidence)` (resumo curto) OU o
     `runResult.summary`.
   - `dependencies`/`retry_notes`/`residual_risk`: opcionais — derivar de
     `runResult.summary`/último `nextStep` quando disponíveis; podem ficar
     ausentes (retrocompatível). NÃO inventar; melhor omitir campo do que forjar.
   - Persistir via `card.update({ where: { id: taskId }, data: { completionMetadata: <Prisma.InputJsonValue> } })` (gotcha Json §5.1).
   - Best-effort: envolver em try/catch com `logger.warn` — nunca derruba o
     fechamento da task.
2. **Injetar no filho:** estender `buildContext` para, além do `epicNotes`/
   `siblingHandoffs` já existentes, coletar o `completionMetadata` das tasks
   **done da story-pai / do blocker resolvido** relevantes ao trabalho atual e
   expor um campo `parentHandoffs: { key: string; title: string; metadata: CompletionMetadata }[]`.
   - Fonte pragmática v1: as **siblings done** já são lidas
     (`siblingHandoffs`); adicionar o `completionMetadata` a essas linhas (ler
     `completionMetadata` no `select` das siblings) OU, quando a story tem
     dependência (EP-BLOCK `TaskDependency`), ler o metadata das tasks das
     stories-blocker resolvidas. Escolha a fonte que já está no grafo lido por
     `buildContext` para não duplicar queries; documentar no código qual foi.
   - `buildPrompt`: novo bloco `## Handoff estruturado do trabalho anterior`
     listando, por item com metadata não-vazio, os campos presentes
     (changed_files, verification, dependencies, residual_risk). Só quando há
     metadata (retrocompatível).

**DOD (US-CTX2):**
- Fechar uma task grava `completionMetadata` (verificável por leitura no banco/
  spec white-box).
- Dependente promovido/encadeado recebe o metadata do pai no prompt.
- Contrato `CompletionMetadata` exportado e consumido nos dois lados
  (type-safe). ADR-0040 escrito + linha na `docs/adr/README.md`.
- Specs cobrindo gravação e injeção.

### US-CTX3 — Run liveness classification + bounded continuations (Paperclip #1) — **med**

**Objetivo:** classificar cada run em `RunLivenessState`; em `plan_only`/
`empty_response` enfileirar uma **continuação bounded** (re-wake alvo em segundos
via wakeup queue durável) com `continuationAttempt` incrementado e
`livenessReason` no próximo prompt, até `continuationCap`. Supera o anti-thrash
(que só vê similaridade de summary) — mas **coexiste** com ele (o cap de
continuação é atingido ANTES do anti-thrash escalar).

**Schema:** §5.2. **Contrato:** §4.2. **Config:** §6.

**Hooks (orchestrator.ts):**
1. **Classificar:** após uma iteração de implementação/análise ser persistida
   (`appendIteration`, no fim de `runIteration` ~L1218) — ou num helper
   `classifyRunLiveness(runResult, iterationDiff, touched, handoffState)` puro e
   testável — mapear:
   - `completed` ⇐ `canFinish`/`handoffState==='done'`.
   - `advanced` ⇐ `iterationDiff.trim()` não-vazio **OU** `touched.length>0`
     (fechou DOD).
   - `blocked` ⇐ `handoffState` em (`blocked-dep`/`needs_input`/blocked).
   - `needs_followup` ⇐ houve `hitlExchange` (outcome `awaiting-input`).
   - `failed` ⇐ ramo de validação reprovada (`effectivePassed===false`).
   - `plan_only` ⇐ tem `runResult.summary`/`nextStep` mas **sem** diff e **sem**
     DOD fechado.
   - `empty_response` ⇐ sem summary, sem diff, sem DOD.
   Fazer disso uma função pura exportável (facilita specs por estado).
2. **Continuação bounded:** quando o estado ∈ `CONTINUABLE_LIVENESS` e
   `continuationCap>0`:
   - Ler `AgentRuntimeState.continuationAttempt` da story; se
     `< continuationCap`: incrementar, gravar `livenessReason` (dica direcionada,
     ex.: `"run anterior só planejou (plan_only) — EXECUTE o próximo passo agora,
     produza diff ou feche item de DOD"`), e **enfileirar um wakeup alvo** via a
     `WakeupQueueService` existente (     `enqueueWakeup(storyId, 'continuation')`) e/ou agendar um re-tick em
     `continuationDelayMs`. **Adicionar `'continuation'` ao `WAKEUP_REASON`**
     (const array em `packages/shared/src/enums.ts`, L104-114) de forma aditiva
     — é o tipo aceito por `WakeupQueueService.enqueue`. Documentar no comentário
     do enum.
   - Se `>= continuationCap`: **não** enfileira; deixa o fluxo normal
     (auto-step/anti-thrash) agir. `livenessReason` limpo.
   - Em qualquer run `advanced`/`completed`: **zera** `continuationAttempt` e
     limpa `livenessReason` (recuperou-se).
3. **Injetar `livenessReason`:** `buildContext` lê `AgentRuntimeState.livenessReason`
   (junto do CTX1 `priorAttempt`, se ambos existirem — cuidado para não colidir a
   edição do mesmo trecho de select; usar `select` amplo). `buildPrompt` injeta um
   bloco curto `## ➡️ Continuação direcionada` com o `livenessReason` quando
   presente.

**DOD (US-CTX3):**
- Iteração `plan_only`/`empty_response` gera re-wake alvo em segundos
  (`continuationDelayMs`), até `continuationCap`; depois cede ao fluxo normal.
- Run `advanced`/`completed` zera o contador.
- Taxonomia (`RunLivenessState`) consultável e a classificação é uma função pura
  testável.
- Specs por estado (7 estados) + spec do cap (não ultrapassa `continuationCap`).

## 8. Integração — mapa de arquivos

| Arquivo | US-CTX1 | US-CTX2 | US-CTX3 |
|---|---|---|---|
| `packages/shared/src/enums.ts` | — | — | `RunLivenessState` + `CONTINUABLE_LIVENESS` |
| `packages/shared/src/domain.ts` | — | `CompletionMetadata` | — |
| `packages/shared/src/index.ts` (barrel) | — | reexport | reexport |
| `apps/api/prisma/schema.prisma` | — | `Card.completionMetadata` | `AgentRuntimeState.continuationAttempt`+`livenessReason` |
| `apps/api/src/config/*` | — | — | `continuationCap`/`continuationDelayMs` |
| `orchestrator.ts` `buildContext` | `priorAttempt` | `parentHandoffs` | `livenessReason` read |
| `orchestrator.ts` `buildPrompt` | bloco "Tentativa anterior" | bloco "Handoff estruturado" | bloco "Continuação direcionada" |
| `orchestrator.ts` `runIteration` (done ramo) | — | grava `completionMetadata` | classifica + enfileira continuação |
| `docs/adr/0040-*.md` + `docs/adr/README.md` | — | ADR + linha | (compartilha 0040 ou nota) |
| specs `*.spec.ts` (ai-engine) | buildContext/prompt | grava+injeta | classify + cap |

## 9. Retrocompatibilidade

- **US-CTX1**: sem schema; `priorAttempt=null` numa 1ª execução ⇒ prompt idêntico
  ao atual.
- **US-CTX2**: `completionMetadata` nullable; tasks antigas sem metadata ⇒
  `parentHandoffs` vazio ⇒ prompt idêntico ao atual.
- **US-CTX3**: `continuationCap=0` desliga a feature (comportamento atual, só
  watchdog/auto-step). Campos default `0`/`null`. Anti-thrash continua ativo.
- Nenhuma coluna existente removida/renomeada; nenhum contrato existente muda de
  forma quebrável.

## 10. Plano de validação

Após cada story e ao fechar o épico:

```bash
# TS real da API (nest build é opaco):
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
# specs alvo (por story) — runner ts-node:
cd apps/api && node --require ts-node/register --test --test-reporter spec \
  src/modules/ai-engine/<arquivo>.spec.ts
# schema (US-CTX2/3):
cd apps/api && npx prisma validate && npx prisma migrate status   # in sync + valid
# suíte inteira:
npm run build && npm run lint && npm test
curl -s localhost:3333/health    # smoke da fundação
```

- Prisma migrate status **in sync**, validate **valid**.
- `npm run build && npm run lint && npm test` **verdes**.
- Contratos exportados pelo barrel e consumíveis nos dois lados.
