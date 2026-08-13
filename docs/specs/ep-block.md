# EP-BLOCK — Inteligência de bloqueio & dependência (spec implementável)

> **Fonte:** `kanban.md` (rodada 2 de melhorias — Hermes N1/N6 + Paperclip #5/#8).
> **Status:** spec-of-truth para 4 stories (US-BLOCK1..4). Os implementers seguem
> este documento — não re-derivam decisões. Toda mudança é **aditiva e
> retrocompatível** (colunas nullable / com default; `Card.blocked Boolean`
> permanece).

## 1. Contexto e problema

Hoje o bloqueio é um `Boolean` único no `Card` (`blocked` + `needsHuman` +
`needsHumanReason`). Todo bloqueio colapsa num só balde:

- Não distingue **"esperando dependência"** (auto-resumível, sem humano) de
  **"esperando humano"** (HITL) de **"gap de capacidade"** (permanente) de
  **"transiente"** (retry).
- Um **blocker que completa NÃO acorda o bloqueado** — o reverso do M3 (fan-out
  story→task on done) nunca foi implementado para arestas `dependsOn`.
- Recorrência da mesma causa de bloqueio pode **ciclar** `blocked↔unblocked`
  indefinidamente sem nunca escalar a um humano.

Maior ROI da rodada 2: reduz ruído de HITL e destrava stories sozinho.

### DOD do épico

- Bloqueio carrega **tipo** (`BlockKind`).
- **Dependency-block** re-enfileira sozinho quando a dependência fecha.
- `needs_input`/`capability` **sobem a humano** (`needsHuman`).
- Recorrência da mesma causa **N vezes (cross-run)** escala em vez de ciclar.
- `npm run build && npm run lint && npm test` **verdes**; contratos **type-safe
  nos dois lados** (`packages/shared` consumido por api **e** web).

## 2. Invariantes preservados (checar em cada PR)

1. Hierarquia Epic→Story→Task num único `Card` polimórfico. **EP-BLOCK é
   ortogonal**: mexe em atributos de bloqueio do card, não na hierarquia.
2. Epic é derivado — ninguém move epic direto. **Não alterado.**
3. Task só se cria em Backlog/To Do. **Não alterado.**
4. **Sem DOR e sem `acceptance` no v1** — único checklist é o DOD. **NÃO
   reintroduzir** nenhum campo/estado que ressuscite DOR/acceptance.
5. Story points ∈ {1,2,3,5,8,13}. **Não alterado.**
6. Loop engine só dispara quando story entra em In Progress. **Não alterado** —
   os wakes de unblock são re-dispatch de stories já `everInProgress`.
7. Processamento in-process (sem Redis) — ADR-0019/0032. Todos os wakes usam a
   `WakeupQueueService` durável já existente (Postgres), **não** um broker.
8. Migrations **aditivas** — colunas nullable ou com default, sem backfill
   destrutivo; `Card.blocked Boolean` e `needsHuman Boolean` continuam existindo.

## 3. Grafo de dependências das stories

```
US-BLOCK1 (enum BlockKind + Card.blockKind + roteamento de unblock)  ← BASE
   ├── US-BLOCK2 (blockedDescriptor + auto-notify owner)   [depende de BLOCK1]
   └── US-BLOCK4 (loop-breaker cross-run)                  [depende de BLOCK1]
US-BLOCK3 (blocker-dependency auto-wake)   [independente do schema de BLOCK1;
                                            alinha o CONTRATO de wake — usa a
                                            reason 'blockers_resolved' definida
                                            em BLOCK1/§4.1]
```

**Ordem de execução:** BLOCK1 primeiro (base de schema/enum). Depois BLOCK2,
BLOCK3, BLOCK4 em paralelo. BLOCK3 só precisa de BLOCK1 para a constante
`WAKEUP_REASON` ganhar `'blockers_resolved'` — se preferir, BLOCK1 adiciona esse
valor e BLOCK3 o consome.

## 4. Contratos compartilhados (`packages/shared`)

> **Regra:** todo enum/DTO/evento novo vive em `packages/shared/src` e é
> consumido por api **e** web na MESMA mudança. `packages/shared` é CommonJS —
> exportar via os barrels existentes.

### 4.1 `packages/shared/src/enums.ts`

Adicionar (US-BLOCK1):

```ts
/**
 * Taxonomia de bloqueio (EP-BLOCK / ADR-0039). null = comportamento pré-BLOCK
 * (bloqueio genérico), retrocompatível.
 *  - dependency:  esperando uma dependência (dependsOn) fechar. AUTO-RESUMÍVEL,
 *                 sem humano. Volta a "To Do" e re-valida quando o blocker fecha.
 *  - needs_input: esperando resposta humana (HITL). Marca needsHuman.
 *  - capability:  gap de capacidade / falta ferramenta. Marca needsHuman
 *                 (permanente até intervenção).
 *  - transient:   falha passageira (rede, rate-limit). Elegível a retry
 *                 automático; NÃO marca needsHuman por si só.
 */
export const BLOCK_KIND = ['dependency', 'needs_input', 'capability', 'transient'] as const;
export type BlockKind = (typeof BLOCK_KIND)[number];
```

Adicionar a `WAKEUP_REASON` (US-BLOCK1, consumido por BLOCK2/BLOCK3):

```ts
export const WAKEUP_REASON = [
  'story_in_progress',
  'task_added',
  'hitl_answered',
  'manual_step',
  'reconcile',
  'blockers_resolved', // US-BLOCK3: todos os blockers dependsOn fecharam
  'issue_unblock',     // US-BLOCK2: owner=agent notificado para destravar
] as const;
```

### 4.2 `packages/shared/src/domain.ts`

Adicionar o descriptor de unblock (US-BLOCK2):

```ts
/** Dono responsável por destravar um card bloqueado (US-BLOCK2). */
export type BlockedOwner = string | 'board'; // agentId ou o board (humano)

/** Descriptor typed exigido ao mover um card para blocked (US-BLOCK2). */
export interface BlockedDescriptor {
  owner: BlockedOwner;   // agentId => auto-notify por wake; "board" => needs_attention humano
  action: string;        // o que precisa acontecer para destravar (prosa curta)
}
```

Estender o DTO de card (o DTO público de card em `domain.ts`) com campos
**opcionais**: `blockKind?: BlockKind | null` e
`blockedDescriptor?: BlockedDescriptor | null`. **Nunca** serializar campos
internos de lock/lease.

### 4.3 `packages/shared/src/events.ts`

O evento `card.updated`/`card.moved` já carrega o card serializado; garantir que
`blockKind` e `blockedDescriptor` fluem por ele (são apenas campos novos do DTO).
Não é preciso um evento WS novo — mas **BLOCK2** deve reusar o evento existente
para a UI refletir o owner/kind em tempo real.

## 5. Schema Prisma (`apps/api/prisma/schema.prisma`) + migrations

> Cada story cria **uma migration aditiva** própria. Verificar os números de
> linha reais antes de editar (as referências abaixo são aproximadas).

### 5.1 US-BLOCK1 — `Card.blockKind`

No `model Card` (região de `blocked`/`needsHuman`, ~L170-176):

```prisma
enum BlockKind {
  dependency
  needs_input
  capability
  transient
}

// dentro de model Card:
blockKind BlockKind? // EP-BLOCK: taxonomia do bloqueio. null = genérico (pré-BLOCK).
```

Migration aditiva: cria o enum + coluna nullable. Sem backfill.

### 5.2 US-BLOCK2 — `Card.blockedDescriptor` + `Card.blockedOwnerNotifiedAt`

```prisma
// dentro de model Card:
blockedDescriptor      Json?     // { owner, action } — US-BLOCK2. null = sem descriptor.
blockedOwnerNotifiedAt DateTime? // anti re-fire do wake de unblock (US-BLOCK2).
```

Migration aditiva, ambos nullable.

### 5.3 US-BLOCK4 — `AgentRuntimeState.consecutiveBlockCount` + `lastBlockReason`

No `model AgentRuntimeState` (~L381; já tem `lastError`, `livenessState`):

```prisma
// dentro de model AgentRuntimeState:
consecutiveBlockCount Int     @default(0)  // US-BLOCK4: recorrências da MESMA causa (cross-run).
lastBlockReason       String?              // assinatura da última causa de bloqueio.
```

Migration aditiva com default 0.

> **US-BLOCK3 não precisa de schema novo** — usa `TaskDependency`
> (`dependentId`/`dependsOnId`, ~L249) e a `WakeupQueue` existentes.

## 6. Stories em detalhe

### US-BLOCK1 — Typed block reasons (`BlockKind`) + unblock routing — **low**

**Objetivo:** dar tipo ao bloqueio e rotear o unblock por tipo.

**Mudanças:**
- `packages/shared`: `BLOCK_KIND`/`BlockKind` (§4.1); estender DTO de card com
  `blockKind?` (§4.2); adicionar `'blockers_resolved'` e `'issue_unblock'` a
  `WAKEUP_REASON` (§4.1) — necessários por BLOCK2/BLOCK3.
- Prisma: `enum BlockKind` + `Card.blockKind BlockKind?` (§5.1) + migration.
- `apps/api/src/modules/ai-engine/loop-helpers.ts`: enriquecer a transição para
  `blocked` e o `escalateToHuman` para gravar `blockKind`. **Roteamento:**
  - `dependency` → volta o card para **"To Do"** e re-valida/auto-resume quando
    o blocker fechar (reusa a máquina de `resolveDependents` do orchestrator,
    ~L1229-1280). **NÃO** marca `needsHuman`.
  - `needs_input` → marca `needsHuman = true` + `needsHumanReason` (HITL).
  - `capability` → marca `needsHuman = true` (permanente até intervenção).
  - `transient` → elegível a retry automático; **não** marca `needsHuman` por si.
- `apps/api/src/modules/ai-engine/orchestrator.ts`: onde hoje se seta `blocked`,
  passar/derivar o `blockKind` correspondente.

**DOD:** bloqueio grava `kind`; `dependency` volta a To Do e auto-resume;
`needs_input`/`capability` marcam `needsHuman`; specs cobrindo **cada** kind.

**ADR:** criar **`docs/adr/0039-typed-block-taxonomy-and-auto-unblock.md`**
(0038 já é EP-PROJECT). Registrar: por que uma taxonomia typed de bloqueio
substitui o balde único, o roteamento por kind (auto-resume vs HITL vs
permanente vs retry), e o auto-unblock por dependência. Indexar em
`docs/adr/README.md`. **O implementer de BLOCK1 escreve este ADR.**

**Specs:** `apps/api/src/modules/ai-engine/*.spec.ts` novo/estendido cobrindo
cada BlockKind → roteamento esperado. Reforçar que **invariante 4** (sem
DOR/acceptance) não é violado.

### US-BLOCK2 — Routable blocked: unblock descriptor + auto-notify owner — **low-med**

**Depende de US-BLOCK1.**

**Objetivo:** ao bloquear, exigir um descriptor typed e notificar o dono certo.

**Mudanças:**
- `packages/shared`: `BlockedOwner`/`BlockedDescriptor` (§4.2); estender DTO de
  card com `blockedDescriptor?`.
- Prisma: `Card.blockedDescriptor Json?` + `Card.blockedOwnerNotifiedAt
  DateTime?` (§5.2) + migration.
- Ao mover para `blocked` (loop-helpers/orchestrator): **exigir**
  `blockedDescriptor`. Regras:
  - `owner` é um `agentId` → enfileirar **1 wake idempotente** ao agent certo via
    `WakeupQueueService.enqueue({ storyId, reason: 'issue_unblock' })`. A
    idempotência é garantida pelo **coalescing por story já existente** (no
    máx. 1 wake não-terminal por story — ver `wakeup-queue.service.ts` L31-75) +
    por `blockedOwnerNotifiedAt` que **evita re-fire** (só notifica se
    `blockedOwnerNotifiedAt` for null ou anterior à entrada em blocked).
    Chave lógica de dedupe descrita no épico: `issue-unblock:{cardId}:{ts}` — na
    prática o coalescing + `blockedOwnerNotifiedAt` implementam isso sem uma
    coluna de chave extra.
  - `owner === 'board'` (ou **prose-only sem descriptor**) → cai em
    **needs_attention** humano (`needsHuman`/badge). Prose-only == descriptor
    ausente ou malformado.
- `blockedOwnerNotifiedAt` é setado ao disparar o wake; limpo quando o card sai
  de blocked (unblock/resume/done).

**DOD:** blocked com `owner=agent` dispara **1** wake ao agent certo; prose-only
sem descriptor cai em needs_attention; specs de idempotência (dois blocks
seguidos não geram 2 wakes; coalescing respeitado).

**Specs:** idempotência do wake (merge/coalescing), roteamento owner=agent vs
owner=board vs sem-descriptor, reset de `blockedOwnerNotifiedAt` no unblock.

### US-BLOCK3 — Blocker-dependency auto-wake (`blockers_resolved`) — **low**

**Independente do schema de BLOCK1** (usa só a reason nova). Reverso do M3.

**Objetivo:** quando **todos** os blockers de uma story fecham, acordar o
bloqueado exatamente uma vez.

**Mudanças:**
- Hook no fechamento de card (`apps/api/src/modules/cards/cards.service.ts` na
  transição status→`done`, e/ou no orchestrator ~L1229-1280 onde já se reage a
  `dependsOnId: taskId`). Ao fechar um card `X`:
  1. Achar os dependentes via `TaskDependency where dependsOnId = X`.
  2. Para cada dependente/story, verificar se **TODOS** os `dependsOn` estão
     `done`. **`cancelled` NÃO satisfaz** um blocker** — só `done` conta; um
     blocker cancelado deixa a aresta **aberta** (a story permanece bloqueada).
  3. Se o conjunto de blockers ficou totalmente resolvido, enfileirar **1** wake
     ao assignee via `WakeupQueueService.enqueue({ storyId, reason:
     'blockers_resolved' })`. Dedupe lógico por `(storyId, blockerSetHash)` — na
     prática o coalescing por story já garante no-máx-1 wake não-terminal; o
     `blockerSetHash` (hash ordenado dos `dependsOnId`) evita re-disparar para o
     MESMO conjunto se a story voltar a bloquear por outra causa. Guardar o hash
     de forma leve (ex.: no `stateJson` do `AgentRuntimeState` ou derivado on the
     fly — **não** criar coluna se puder ser recomputado).
- **Não** usar `cancelled` como satisfação de blocker em NENHUM caminho.

**DOD:** fechar o **último** blocker acorda o bloqueado; `cancelled` deixa a
aresta aberta (não acorda); **sem** wake duplicado; specs de cadeia
(A→B→C: fechar A não acorda C enquanto B aberto; fechar B acorda C).

**Specs:** cadeia de dependências, cancelled-não-satisfaz, idempotência
(fechar/reabrir não dispara 2 wakes).

### US-BLOCK4 — Block-recurrence loop-breaker (cross-run) — **low-med**

**Depende de US-BLOCK1.**

**Objetivo:** impedir ciclo infinito `blocked↔unblocked` da MESMA causa através
de recoveries (M4).

**Mudanças:**
- Prisma: `AgentRuntimeState.consecutiveBlockCount Int @default(0)` +
  `lastBlockReason String?` (§5.3) + migration.
- Ao entrar em `blocked`: computar uma **assinatura da causa** (ex.:
  `blockKind` + hash curto de `needsHumanReason`/`blockedDescriptor.action`).
  - Se `assinatura === lastBlockReason` → `consecutiveBlockCount++`.
  - Senão → `lastBlockReason = assinatura`, `consecutiveBlockCount = 1`.
- Se `consecutiveBlockCount >= N` (**default 2**, configurável via env, ex.:
  `AGENT_MAX_CONSECUTIVE_BLOCKS`) → **`escalateToHuman`** (reusa o helper) em vez
  de re-ciclar. Ler o default do config em `apps/api/src/shared/config/config.ts`.
- **Reset:** ao `complete` da story (mesmo lugar que `WakeupQueueService.complete`
  / `escalateToHuman` de sucesso), zerar `consecutiveBlockCount` e limpar
  `lastBlockReason`. Cross-run: o contador vive em `AgentRuntimeState` (durável),
  então sobrevive a recovery/restart (M4).

**DOD:** N-ésima recorrência da **mesma** causa escala; contador **reseta** ao
concluir; specs com **fake timer** cobrindo o cenário cross-run (bloqueia →
recovery → bloqueia mesma causa → escala).

**Specs:** contador incrementa só para mesma causa; causa diferente reseta para
1; N-ésima escala; complete zera.

## 7. Integração — mapa de arquivos

| Área | Arquivo | O quê |
|---|---|---|
| Contratos | `packages/shared/src/enums.ts` | `BLOCK_KIND`, `WAKEUP_REASON`+2 |
| Contratos | `packages/shared/src/domain.ts` | `BlockedDescriptor`, DTO card+2 campos |
| Schema | `apps/api/prisma/schema.prisma` | `enum BlockKind`, `Card.blockKind/blockedDescriptor/blockedOwnerNotifiedAt`, `AgentRuntimeState.consecutiveBlockCount/lastBlockReason` |
| Loop | `apps/api/src/modules/ai-engine/loop-helpers.ts` | roteamento por kind, escalate, assinatura de causa |
| Loop | `apps/api/src/modules/ai-engine/orchestrator.ts` | set blockKind, resolveDependents (~L1229-1280), reset no complete |
| Wake | `apps/api/src/modules/ai-engine/wakeup-queue.service.ts` | reusar `enqueue` (coalescing) — não reescrever |
| Cards | `apps/api/src/modules/cards/cards.service.ts` | hook status→done → blockers_resolved (BLOCK3) |
| Config | `apps/api/src/shared/config/config.ts` | `AGENT_MAX_CONSECUTIVE_BLOCKS` (default 2) |
| Web | `apps/web/src/features/board/**` | refletir blockKind/owner no card (badge) |
| ADR | `docs/adr/0039-typed-block-taxonomy-and-auto-unblock.md` | + index em README |

## 8. Idempotência dos wakes (resumo)

Todos os wakes usam `WakeupQueueService.enqueue`, que **coalesce por story**: no
máximo **1** wakeup não-terminal (`pending|claimed`) por story; um segundo wake
para a mesma story faz **merge** (incrementa `attempts`, atualiza `reason`). Isso
já garante "sem wake duplicado" no nível de story. As chaves lógicas dos épicos
(`issue-unblock:{id}:{ts}`, `(storyId, blockerSetHash)`) são implementadas por:
- **BLOCK2:** coalescing + `blockedOwnerNotifiedAt` (anti re-fire).
- **BLOCK3:** coalescing + `blockerSetHash` (evita re-disparo para o mesmo
  conjunto de blockers).

## 9. Retrocompatibilidade

- `Card.blocked Boolean` e `needsHuman Boolean` **permanecem** — `blockKind` é um
  refinamento nullable (null = comportamento pré-BLOCK).
- `blockedDescriptor`/`blockedOwnerNotifiedAt` nullable — cards antigos sem
  descriptor caem em needs_attention (comportamento seguro).
- `consecutiveBlockCount` default 0, `lastBlockReason` nullable — estados de
  runtime antigos continuam válidos.
- Todas as migrations são aditivas; sem backfill destrutivo.

## 10. Plano de validação

1. **Unit/integration:** `npm test` (api). Cada story adiciona specs (§6). Alvo:
   manter os 345 verdes atuais + os novos.
2. **Gate completo (root):** `npm run build && npm run lint && npm test` verdes.
3. **Smoke empírico** (fresh API, `AGENT_RUNNER_KIND=mock`):
   - Bloquear card como `dependency` → volta a To Do; fechar o blocker → 1 wake
     `blockers_resolved`, story re-dispatch.
   - Bloquear como `needs_input`/`capability` → `needsHuman=true`, sem wake.
   - Blocked com `owner=agent` → 1 wake `issue_unblock`; repetir → sem 2º wake
     (coalescing + `blockedOwnerNotifiedAt`).
   - Blocked prose-only sem descriptor → needs_attention.
   - Bloquear mesma causa N=2 vezes cross-run → escala a humano; `complete` zera
     o contador.
   - `cancelled` de um blocker → NÃO acorda o dependente.
4. Mover EP-BLOCK para `# done` em `kanban.md` com as 4 US marcadas + resumo de
   validação.
