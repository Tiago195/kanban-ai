# ADR-0032 — Wakeup queue persistente, idempotente e com coalescing

**Status:** Aceito (implementado — US-COLAB3)

**Data:** 2026-08-12

## Contexto

O loop engine acorda uma story quando ela entra em **In Progress** (invariante 6)
e serializa o trabalho **por epic**, **in-process** e **sem Redis/BullMQ**
(invariante 7 / [ADR-0005](0005-in-process-orchestration.md) /
[ADR-0019](0019-api-runs-on-host-not-docker.md)). Até aqui a "fila" de wakeups era
**100% efêmera**: o gatilho chamava `onStoryEnterInProgress` direto, e quando a
serialização detectava conflito (outra story do mesmo epic ativa) o wakeup era
simplesmente **perdido** — a retomada dependia de um re-scan do board no boot ou
de `resumeDeferredForStory`.

Isso trazia dois problemas:

- **Perda de wakeup em restart:** um wakeup em voo (ex.: task adicionada a uma
  story em progresso, ou resposta de HITL) que não virasse mudança de coluna do
  board não sobrevivia a um restart da API.
- **Sem coalescing explícito:** múltiplos gatilhos para a mesma story (move +
  task_added + stepOnce) não tinham um registro único deduplicado; a intenção de
  "acordar esta story" não era auditável nem durável.

A análise das ferramentas de referência (fila durável de intenções, separada do
executor) aponta para persistir o **estado da fila** sem trocar o executor.

## Decisão

Adicionar uma **wakeup queue persistida no Postgres**, idempotente e com
coalescing, mantendo o **processamento in-process** (sem Redis, invariante 7).

- **Modelo Prisma `WakeupQueue`** (`apps/api/prisma/schema.prisma`): `storyId`
  (FK para `Card`, `onDelete: Cascade`), `status` (`WakeupStatus`:
  `pending`/`claimed`/`done`/`failed`), `reason` (`WakeupReason`:
  `story_in_progress`/`task_added`/`hitl_answered`/`manual_step`/`reconcile`),
  `attempts` (contador de coalescing), `epicId` (serialização por epic),
  timestamps `createdAt`/`updatedAt`/`claimedAt`/`processedAt`. Relação reversa
  `wakeups WakeupQueue[]` em `Card`.
- **Coalescing forte via índice único PARCIAL:** no máximo **um** wakeup
  não-terminal por story. Como o Prisma v6 **não expressa índice parcial** no
  schema, o índice é adicionado **à mão** no SQL da migration:
  `CREATE UNIQUE INDEX "WakeupQueue_storyId_active_key" ON "WakeupQueue"("storyId") WHERE status IN ('pending','claimed');`
  O `enqueue` usa `findFirst` + `create`/`update` numa transação (o índice
  parcial é a rede de segurança contra corrida — uma inserção concorrente que
  escape do `findFirst` colide na constraint e é reconvertida em merge).
- **`WakeupQueueService`** (`apps/api/src/modules/ai-engine/wakeup-queue.service.ts`):
  `enqueue` (coalesce/merge), `claim`, `complete`, `fail`, `recoverOnBoot`
  (reabre `claimed` órfãos → `pending`), `listPending`.
- **Integração no `Orchestrator`** (todos os pontos atrás do flag e defensivos):
  `enqueue` nos gatilhos (story→In Progress e `maybeResumeLoopOnTaskAdded` em
  `cards.service.ts`, `stepOnce`, HITL resume, `reconcile` no boot); `claim` após
  criar a sessão em `onStoryEnterInProgress`; `complete` em `finishAuto` **antes**
  de `resumeDeferredForStory`; `recoverOnBoot` no início de `reconcileOnBoot`.
- **Off por default / retrocompatível:** gate por
  `AGENT_WAKEUP_QUEUE_ENABLED` (`=== 'true'`, off-default). Com o flag OFF o
  comportamento é idêntico ao legado (acorda direto, sem estado durável). O
  `WakeupQueueService` é injetado como **último parâmetro opcional** do
  construtor do `Orchestrator`, para não quebrar as specs que o instanciam com a
  assinatura anterior.

O contrato exato (schema, service, pontos de integração e DOD) está em
[`docs/specs/ep-colab.md`](../specs/ep-colab.md) (US-COLAB3, §3.3–3.7). Os enums
são exportados como constantes shared (`WAKEUP_STATUS`/`WAKEUP_REASON`) em
`packages/shared/src/enums.ts` para consumo type-safe web+api.

## Consequências

- **Positivas:** wakeups sobrevivem a restart (fonte de verdade explícita além do
  board); duplicatas colapsam num único item por story (`attempts` audita o
  coalescing); um `claimed` órfão (crash) é recuperado no boot; a serialização por
  epic ganha um registro durável (`epicId`) sem perder wakeups em conflito.
- **Negativas / riscos:** custo de I/O por gatilho (mitigado pelo coalescing e
  pelo flag off-default); **o índice único parcial é editado à mão na migration**
  — um `prisma migrate reset` regenera a migration e **PERDE** essa edição se ela
  for recriada. Mitigação: a migration é versionada, o `.sql` tem um comentário de
  aviso, e este ADR o documenta; ao recriar, re-adicionar o índice parcial.
- **Invariantes preservados:** orquestração segue **in-process** (ADR-0005 /
  ADR-0019) — a fila é só **estado durável** no Postgres, **sem Redis/BullMQ**
  (invariante 7); o gatilho continua sendo story→In Progress (invariante 6); a
  fila é a camada durável **entre** o gatilho e o executor. O executor
  (`setInterval`/`AgentSessionManager`) é inalterado.
