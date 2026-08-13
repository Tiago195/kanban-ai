# EP-ROB — Robustez do Loop Engine (design-spec implementável)

> **Público-alvo:** agents de AI autônomos que vão implementar este épico **sem
> acesso ao autor deste documento**. Tudo o que você precisa para não adivinhar
> um contrato está aqui: caminhos de arquivo reais, nomes de símbolo e linhas
> **verificadas** no código em `HEAD`. Onde o texto disser "ESTENDER", **não
> reescreva** o símbolo citado — adicione ao redor dele.
>
> **Antes de tocar qualquer arquivo**, releia:
> - [`apps/api/src/modules/ai-engine/AGENTS.md`](../../apps/api/src/modules/ai-engine/AGENTS.md) (regras do módulo, 4 salvaguardas)
> - [`docs/loop-engine.md`](../loop-engine.md)
> - [ADR-0022](../adr/0022-hitl-survives-restart-via-cli-session-id.md) (HITL sobrevive a restart)
> - [ADR-0019](../adr/0019-api-runs-on-host-not-docker.md) (API roda no host; loop dá spawn no repo-alvo)
> - [ADR-0027](../adr/0027-memory-as-a-living-service.md) + módulo `memory` (padrão de **lease/TTL + scheduler** que vamos espelhar em US-ROB4)

---

## 1. Sumário do épico

O loop engine já funciona (uma story In Progress acorda um agent que itera, marca
o DOD e valida por `affectedFlows`), mas tem **quatro buracos de robustez** que
aparecem em execução real e sob restart do processo:

| US | Título | Problema-raiz | Natureza |
|----|--------|---------------|----------|
| **US-ROB1** | Gate de completude anti-"falso sucesso" | `done` pode fechar sem artefato verificável **por classe de resultado** | **Estender** validação existente |
| **US-ROB2** | Estado de runtime persistido | Sessão é 100% in-process; some no restart | **Novo model Prisma** + wiring |
| **US-ROB3** | Auto-start de dependentes | Filho fica pronto quando o pai fecha, mas **ninguém o promove** | **Nova lógica** no orquestrador |
| **US-ROB4** | Stale-claim recovery por TTL | Não há lease/claim; recuperação só no boot | **Novas colunas** + tick do watchdog |

**Invariantes do domínio que NENHUMA US pode violar** (cite-os no PR quando tocar
o ponto relevante):

1. Hierarquia **Epic → Story → Task** num `Card` polimórfico (`type`, `parentId`, `key` `EP-`/`US-`/`TK-`).
2. **Epic é derivado** — status vem das stories filhas (`deriveEpicStatus`, chamado em `advanceEpic`). Ninguém move epic direto.
3. **Task só se cria** em Backlog ou To Do (`TASK_CREATION_COLUMNS`).
4. **Sem DOR e sem `acceptance` no v1** — único checklist é o **DOD** ([ADR-0007](../adr/0007-remove-dor-and-acceptance.md)). **Não reintroduzir.**
5. Story points ∈ `{1,2,3,5,8,13}` (só story/epic; task não tem pontos).
6. O loop engine **só dispara** quando uma story entra em In Progress (`Orchestrator.onStoryEnterInProgress`).
7. **Concorrência é por-story, serializada por epic** — uma story In Progress por epic; epics diferentes concorrem. **Orquestração in-process, SEM Redis** (invariante; Redis/BullMQ é ponto de extensão futuro, ver `AgentSessionManager` doc-comment).

### 1.1 As 4 salvaguardas existentes (NUNCA remover — só estender)

Documentadas em `agent-session-manager.ts` (linhas ~34-40) e implementadas no
orquestrador:

1. **Reconciliação no boot** — `Orchestrator.reconcileOnBoot` (`onModuleInit`).
2. **Limite de concorrência** — `AgentSessionManager.canStart()` vs `config.agent.maxConcurrentSessions` (default 3).
3. **Watchdog idempotente** — `Orchestrator.tickWatchdog` só age em sessão `state === 'dead'`.
4. **Abort limpo** — `AgentSessionManager.abort()` via `AbortController`/`AbortSignal`.

US-ROB4 **estende a salvaguarda #3** (watchdog passa a recuperar leases vencidos,
mantendo a idempotência). US-ROB2 dá **durabilidade** à salvaguarda #1.

---

## 2. Ordem recomendada de implementação

```
US-ROB1  →  US-ROB2  →  US-ROB4  →  US-ROB3
(gate)      (persist)    (lease)     (auto-start)
```

**Justificativa:**

- **US-ROB1 primeiro**: é a de menor blast-radius (estende símbolos puros já
  existentes, atrás de flag off-by-default) e endurece o critério de `done` — o
  que torna as três seguintes observáveis com confiança (um `done` só fecha com
  artefato real).
- **US-ROB2 antes de US-ROB4**: o model `AgentRuntimeState` criado em US-ROB2 é o
  lugar natural para as colunas `claimLock`/`claimExpiresAt` do lease de US-ROB4
  (o lease é um dado de runtime da sessão). Fazer ROB2 primeiro evita **duas
  migrations tocando a mesma área**.
- **US-ROB4 antes de US-ROB3**: a recuperação de claim vencido (ROB4) pode
  destravar stories cujos dependentes o ROB3 então promove — a ordem evita
  interações não-testadas entre um claim preso e a promoção.
- **US-ROB3 por último**: depende do caminho `onTaskDone` estar sólido e é o que
  mais mexe no fluxo de fila da story.

Cada US é um PR (ou conjunto de PRs) independente e **deploy-safe isolado**: com
suas flags off, o comportamento é idêntico ao atual.

---

## 3. Tabela de rastreabilidade

| US | Arquivos que muda | Contrato novo/estendido | Config nova | Spec de DOD |
|----|-------------------|-------------------------|-------------|-------------|
| ROB1 | `packages/shared/src/domain.ts`, `apps/api/.../validators/validation.runner.ts`, `apps/api/.../orchestrator.ts` (gate ~586-707), `config.ts` | `ResultClass`, `minimumArtifactSatisfied()` (estende `isVerifiableEvidence`) | `AGENT_REQUIRE_MIN_ARTIFACT` | `validation-coverage.spec.ts`, `loop-quality.spec.ts` |
| ROB2 | `apps/api/prisma/schema.prisma` (+migration), `apps/api/.../session-manager/agent-session-manager.ts`, `apps/api/.../orchestrator.ts` (boot/hooks), `packages/shared/src/enums.ts` | model `AgentRuntimeState`, enum `LivenessState` | `AGENT_RUNTIME_PERSIST_ENABLED` | `agent-runtime-state.spec.ts` (novo) |
| ROB3 | `apps/api/.../orchestrator.ts` (`onTaskDone` ~905-925, novo `promoteReadyDependents`), `apps/api/.../loop-helpers.ts` (reuso) | — (usa `TaskDependency`, `taskReady`, `pickNextTask`) | `AGENT_AUTOSTART_DEPENDENTS` | `orchestrator-guards.spec.ts` (novos casos) |
| ROB4 | `apps/api/prisma/schema.prisma` (colunas em `AgentRuntimeState`, +migration), `apps/api/.../orchestrator.ts` (`tickWatchdog` ~1502, `onStoryEnterInProgress` ~127), `config.ts` | métodos `claimStory`/`renewClaim`/`recoverStaleClaims` | `AGENT_CLAIM_TTL_MS`, `AGENT_CLAIM_ENABLED` | `claim-lease.spec.ts` (novo) |

---

## 4. Mapa de arquivos-chave (verificado)

| Símbolo | Arquivo | Linha (aprox.) | Papel |
|---------|---------|----------------|-------|
| `isVerifiableEvidence()` | `packages/shared/src/domain.ts` | 304-326 | Predicado: evidência é verificável só se `checks[]` tem ≥1 `passed===true`. **ROB1 estende.** |
| `StructuredEvidence` / `EvidenceCheck` | `packages/shared/src/domain.ts` | 285-303 | Contrato de evidência. |
| `AffectedFlow` | `packages/shared/src/domain.ts` | 47-52 | `{ id, name, files, note }`. |
| `ValidationRunner.validate()` | `apps/api/.../validators/validation.runner.ts` | 37-155 | Validação empírica (build/lint/test + flow-targeted). **ROB1 estende.** |
| `ValidationOutcome` | `apps/api/.../validators/validation.runner.ts` | 6-9 | `{ passed, problems[] }`. |
| Gate de `done` (evidence) | `apps/api/.../orchestrator.ts` | 574-620 | Consome `requireStructuredEvidence` + `isVerifiableEvidence`. **ROB1 estende.** |
| `claimsNewCodeWithoutDiff` | `apps/api/.../orchestrator.ts` | 758-770 | Já bloqueia affectedFlows sem diff (fase implementation). |
| `AgentSessionManager` | `apps/api/.../session-manager/agent-session-manager.ts` | classe inteira | Map in-process, sem DB. **ROB2 dá durabilidade.** |
| `AgentSessionManager.start()` | idem | 60-72 | Gera `sessionId = sess-${storyId}-${Date.now()}`. **ROB2 muda.** |
| `Orchestrator.onStoryEnterInProgress` | `apps/api/.../orchestrator.ts` | 111-208 | Cria sessão + watchdog + auto-play. **ROB4 injeta claim.** |
| `Orchestrator.reconcileOnBoot` | `apps/api/.../orchestrator.ts` | 92-107 | Re-escaneia stories In Progress no boot. **ROB2/ROB4 usam.** |
| `Orchestrator.onTaskDone` | `apps/api/.../orchestrator.ts` | 905-925 | Resolve arestas de dependência + re-valida origens `blocked-dep`. **ROB3 estende.** |
| `Orchestrator.tickWatchdog` | `apps/api/.../orchestrator.ts` | 1502-1520 | Só limpa sessão `dead`. **ROB4 estende (recupera lease).** |
| `Orchestrator.stepStory` / `stepStoryInner` | `apps/api/.../orchestrator.ts` | 1065-1112 | Escolhe próxima task (`pickNextTask`). |
| `pendingDeps` / `taskReady` / `pickNextTask` | `apps/api/.../loop-helpers.ts` | helpers puros | **ROB3 reusa (não reescreve).** |
| `toPrismaExecState` / `fromPrismaExecState` | `apps/api/.../loop-helpers.ts` | conversores | `blocked-dep` (domínio) ⇄ `blocked_dep` (Prisma). |
| `MemoryLockService.expireStale()` | `apps/api/src/modules/memory/memory-lock.service.ts` | 137-149 | **Padrão de referência de TTL** para ROB4. |
| `MemorySchedulerService.sweepLocks()` | `apps/api/src/modules/memory/memory-scheduler.service.ts` | classe inteira | **Padrão de tick `setInterval`** (sem `@nestjs/schedule`). |
| Migration `memory_lease` | `apps/api/prisma/migrations/20260812160159_memory_lease/migration.sql` | — | **Padrão de colunas `expiresAt`/`leaseId`** para ROB4. |
| Bloco `agent:` do config | `apps/api/src/shared/config/config.ts` | tipo 52-186; valores 241-274 | Onde entram os novos `AGENT_*`. |

> **Convenção de migration:** prefixo `YYYYMMDDHHMMSS_snake_case`
> (ex.: `20260812160159_memory_lease`). Gere com `npx prisma migrate dev --name <snake>`
> a partir de `apps/api`.

> **Convenção de config:** toda flag nova entra no **tipo** `agent: {...}`
> (config.ts ~52-186) **e** no **objeto de valores** (~241-274), lida por
> `num()` / `=== 'true'` / `!== 'false'`. Comportamento novo que muda o
> resultado do loop entra **off por default** (`=== 'true'`).

---

# US-ROB1 — Gate de completude anti-"falso sucesso"

> **Origem:** NanoClaw + Hermes. `done` não pode fechar só com log/flag. Exigir
> **artefato verificável mínimo POR CLASSE de resultado**.

## US-ROB1 · Estado atual (verificado)

1. **Predicado de evidência** — `isVerifiableEvidence(evidence)` em
   `packages/shared/src/domain.ts` (304-326) retorna `true` **só** se `evidence`
   é objeto, `checks` é array e **algum** check tem `passed === true`. String
   livre nunca passa. Contrato:

   ```ts
   // packages/shared/src/domain.ts (285-326) — JÁ EXISTE
   export interface EvidenceCheck { name: string; passed: boolean; output?: string; }
   export interface StructuredEvidence {
     checks: EvidenceCheck[];
     filesChanged?: string[];
     note?: string;
   }
   export function isVerifiableEvidence(
     evidence: string | StructuredEvidence | null | undefined,
   ): evidence is StructuredEvidence { /* ...checks.some(c => c.passed === true) */ }
   ```

2. **Validação empírica** — `ValidationRunner.validate()`
   (`validation.runner.ts` 37-155) já roda `STRATEGY_SCRIPTS` (build/lint/test),
   `runFlowTargetedTests()` e checagem de existência de arquivos de
   `affectedFlows`. Retorna `ValidationOutcome { passed, problems[] }`.

3. **Gate de `done`** — orquestrador (574-620): quando `outcome.passed &&
   config.agent.requireStructuredEvidence && !isVerifiableEvidence(runResult.evidence)`,
   força `effectivePassed = false` e empurra um `problem` "evidência de conclusão
   não verificável", tratado como falha normal (deriva/escala).

4. **Guarda anti-fantasma** — `claimsNewCodeWithoutDiff` (758-770): na fase
   `implementation`, se a AI lista `affectedFlows` mas o `git diff` está vazio, a
   reivindicação é **ignorada** (não persiste flows sem diff).

## US-ROB1 · Gap concreto

- O gate atual trata **todas as conclusões de forma uniforme**: exige "≥1 check
  `passed=true`" independentemente da **classe** do resultado. Uma story de
  refactor sem teste novo, uma story cujo entregável é um **arquivo de
  affectedFlows**, e uma story de código-novo têm evidências mínimas
  **diferentes** — hoje não há essa distinção.
- Falta uma noção formal de **artefato mínimo por classe**:
  - **`code-change`** → diff **não-vazio** nesta conclusão.
  - **`test-green`** → ≥1 `EvidenceCheck` do tipo teste com `passed=true`.
  - **`flow-artifact`** → os arquivos declarados em `affectedFlows` **existem** no `cwd` (já checado por `verifyFlowFiles`, mas não conectado ao gate por classe).
- O gate está atrás de `requireStructuredEvidence` (off por default) e não
  distingue classe — precisamos de um segundo predicado, **complementar** e
  também flag-gated, que exija o artefato mínimo da classe.

## US-ROB1 · Contrato proposto (código real)

**Adicionar em `packages/shared/src/domain.ts`** (logo após `isVerifiableEvidence`,
~linha 326 — **não** alterar a assinatura existente):

```ts
/**
 * Classe do resultado de uma conclusão de task. Determina QUAL artefato mínimo
 * verificável é exigido para fechar (US-ROB1). Deriva-se do desfecho da
 * iteração + do que a AI reivindicou.
 */
export type ResultClass = 'code-change' | 'test-green' | 'flow-artifact';

/** Sinais objetivos coletados pelo orquestrador para avaliar o artefato mínimo. */
export interface MinimumArtifactInput {
  /** Classe reivindicada/derivada desta conclusão. */
  resultClass: ResultClass;
  /** Evidência estruturada anexada pela AI (ou string livre legada). */
  evidence: string | StructuredEvidence | null | undefined;
  /** Diff do worktree NESTA iteração (já capturado pelo orquestrador). */
  diff: string;
  /** true quando TODOS os arquivos de affectedFlows existem no cwd (verifyFlowFiles). */
  flowFilesPresent: boolean;
}

/**
 * US-ROB1 — porta de completude por CLASSE de resultado. Complementa (NÃO
 * substitui) `isVerifiableEvidence`: uma conclusão só é aceita se o artefato
 * MÍNIMO da sua classe existir de fato.
 *
 *  - 'code-change'  → diff não-vazio nesta conclusão.
 *  - 'test-green'   → evidência verificável com ≥1 check de teste passed=true.
 *  - 'flow-artifact'→ arquivos de affectedFlows presentes no worktree.
 *
 * Determinística e pura (testável sem I/O). Retorna null quando o artefato
 * mínimo está presente, ou um problema acionável quando falta.
 */
export function minimumArtifactSatisfied(
  input: MinimumArtifactInput,
): { title: string; description: string } | null {
  switch (input.resultClass) {
    case 'code-change':
      return input.diff.trim().length > 0
        ? null
        : {
            title: 'conclusão sem diff verificável',
            description:
              'A conclusão foi classificada como mudança de código (code-change) ' +
              'mas o diff do worktree está VAZIO. Edite de fato os arquivos antes de fechar.',
          };
    case 'test-green': {
      const evidenceOk =
        isVerifiableEvidence(input.evidence) &&
        input.evidence.checks.some(
          (c) => /test|spec/i.test(c.name) && c.passed === true,
        );
      return evidenceOk
        ? null
        : {
            title: 'conclusão sem teste verde verificável',
            description:
              'A conclusão exige um teste verde (test-green) mas não há EvidenceCheck ' +
              'de teste com passed:true. Rode a suíte e reporte o resultado em `evidence`.',
          };
    }
    case 'flow-artifact':
      return input.flowFilesPresent
        ? null
        : {
            title: 'arquivos de fluxo declarados ausentes',
            description:
              'A conclusão referencia affectedFlows cujos arquivos não existem no ' +
              'worktree. Crie os arquivos declarados ou corrija a lista de fluxos.',
          };
  }
}
```

**Não há mudança de schema Prisma nesta US.** A evidência já é serializada em
`Iteration.evidence` via `evidenceToString` (loop-helpers).

## US-ROB1 · Plano de implementação PR-a-PR

1. **PR ROB1-a — contrato compartilhado.**
   - Adicionar `ResultClass`, `MinimumArtifactInput`, `minimumArtifactSatisfied`
     em `packages/shared/src/domain.ts`.
   - Exportar pelo barrel público do pacote (confirmar `packages/shared/src/index.ts`
     re-exporta `domain.ts` — se sim, nada a fazer; senão, adicionar o export).
   - Compilar shared: `npm run build -w @kanban-ai/shared`.

2. **PR ROB1-b — flag de config.**
   - Em `config.ts`: no tipo `agent` (~186) adicionar
     `requireMinArtifact: boolean;`; no objeto (~274) adicionar
     `requireMinArtifact: process.env.AGENT_REQUIRE_MIN_ARTIFACT === 'true',`.
   - Documentar no `.env.example` (`AGENT_REQUIRE_MIN_ARTIFACT=false`).

3. **PR ROB1-c — encaixe no gate.**
   - No orquestrador, **dentro do bloco de gate existente** (574-620), após o
     cheque de `isVerifiableEvidence`, adicionar o cheque por classe. Derivar
     `resultClass` a partir de sinais que o orquestrador **já tem**:
     - `code-change` quando `runResult.affectedFlows?.length` ou `iterationDiff`
       indicam código; `flow-artifact` quando a story declara flows sem código
       novo; `test-green` como fallback quando a estratégia é `regression-only`.
     - `flowFilesPresent` já é computável via `config.agent.verifyFlowFiles` +
       resultado de `ValidationRunner` (que já checa existência de arquivos de
       flow — reusar esse sinal, **não** re-implementar `fs.exists`).
   - Guardar tudo atrás de `config.agent.requireMinArtifact`. Quando o artefato
     mínimo falta, empurrar o `problem` no **mesmo** array `evidenceProblems` e
     setar `effectivePassed = false` — reusando o caminho de derivação/escala já
     existente (nenhum novo fluxo de erro).

## US-ROB1 · Pontos de integração

- **Único ponto de encaixe:** o bloco de gate de `done` no orquestrador
  (574-620), imediatamente após o cheque `requireStructuredEvidence`. O sinal
  `iterationDiff` e `runResult.evidence` já estão em escopo ali.
- **Reuso obrigatório:** a existência de arquivos de flow já é avaliada por
  `ValidationRunner` (`verifyFlowFiles` / `runFlowTargetedTests`). Passe esse
  resultado ao predicado; **não** duplique I/O de filesystem no orquestrador.

## US-ROB1 · DOD verificável

- [ ] `minimumArtifactSatisfied` coberto por casos unitários (uma classe por
      caso, com artefato presente e ausente) em `packages/shared` ou em
      `apps/api/.../loop-quality.spec.ts` (onde `isVerifiableEvidence` já é testado).
- [ ] Caso em `apps/api/src/modules/ai-engine/validators/validation-coverage.spec.ts`: com `requireMinArtifact` ligado e
      `resultClass='code-change'` sem diff, `validate`/gate resulta em
      `effectivePassed=false` e um `problem` acionável.
- [ ] Com `requireMinArtifact=false` (default), comportamento **idêntico** ao
      atual (nenhum caso existente muda).
- [ ] Comandos: `npm run build -w @kanban-ai/shared && npx nest build` (em
      `apps/api`) e `npm test -w @kanban-ai/api`.

## US-ROB1 · Riscos / invariantes / retrocompat

- **Estender, não reescrever:** `isVerifiableEvidence` e `ValidationRunner.validate`
  permanecem intactos; o novo predicado é **complementar**.
- **Off por default:** `AGENT_REQUIRE_MIN_ARTIFACT=false` → zero mudança de
  comportamento (retrocompat total; mock continua fechando tasks).
- **Não reintroduzir DOR/acceptance** (invariante 4): o gate opera sobre
  evidência/diff/flows, nunca sobre checklists proibidos.
- **Não confundir com `claimsNewCodeWithoutDiff`** (758-770), que atua na fase
  `implementation`; este gate atua na **conclusão** (fase `validation`).

---

# US-ROB2 — Estado de runtime persistido

> **Origem:** Paperclip. Novo model Prisma `AgentRuntimeState`, atualizado pelo
> session-manager, sobrevive a restart. Casa com ADR-0022 (HITL sobrevive a
> restart via CLI sessionId).

## US-ROB2 · Estado atual (verificado)

- `AgentSessionManager` (`session-manager/agent-session-manager.ts`) é **100%
  in-process**: um `Map<string, AgentSession>` (`private readonly sessions`).
  `AgentSession` (interface local, 18-26) tem
  `{ storyId, sessionId, state, abort: AbortController, createdAt, pending }`.
- `start(storyId)` (60-72) gera `sessionId = sess-${storyId}-${Date.now()}` e
  guarda só na memória. `setState`, `abort`, `remove` mexem só no Map.
- **Nenhuma tabela** de runtime existe. A única "recuperação" pós-restart é
  `Orchestrator.reconcileOnBoot` (92-107), que **re-escaneia** as colunas "In
  Progress" e re-acorda o motor — mas **perde**: `sessionId` estável, totais de
  tokens acumulados, último erro e o estado de liveness.
- ADR-0022 estabelece que o HITL sobrevive a restart porque o **CLI sessionId é
  estável = taskId**. Persistir o runtime dá base durável a essa promessa.

## US-ROB2 · Gap concreto

- Após restart, um `sessionId` novo é gerado (`Date.now()` muda) → quebra a
  correlação com o CLI e com o transcript persistido.
- Totais de tokens, `lastError` e `livenessState` só existem em memória → perdidos.
- Não há de onde o watchdog (US-ROB4) ler um lease durável — depende de US-ROB2.

## US-ROB2 · Contrato proposto (código real)

**Enum de liveness em `packages/shared/src/enums.ts`** (junto de `AgentSessionState`):

```ts
/**
 * US-ROB2 — estado de vivacidade PERSISTIDO de uma sessão de agent. Diferente de
 * AgentSessionState (efêmero, in-process), este sobrevive a restart e alimenta a
 * reconciliação durável + o recovery por lease (US-ROB4).
 */
export const LivenessState = {
  Starting: 'starting',
  Alive: 'alive',
  Stalled: 'stalled', // sem heartbeat há > TTL (candidato a recovery)
  Dead: 'dead',
} as const;
export type LivenessState = (typeof LivenessState)[keyof typeof LivenessState];
```

**Model Prisma em `apps/api/prisma/schema.prisma`** (após o model `Iteration`;
inclui já as colunas de lease usadas por US-ROB4 — ver justificativa de ordem):

```prisma
/// US-ROB2/US-ROB4 — estado de runtime PERSISTIDO da sessão de agent (por story).
/// Sobrevive a restart (ADR-0022): sessionId estável = taskId da story.
/// A orquestração continua in-process (SEM Redis); esta tabela é só durabilidade.
model AgentRuntimeState {
  /// sessionId estável (== storyId da execução). Chave natural.
  sessionId String @id

  /// Story cuja execução esta linha representa.
  storyId   String @unique

  /// Snapshot serializado do estado de runtime (JSON: fase, task corrente, etc.).
  stateJson String @default("{}")

  /// Totais de tokens acumulados na sessão (JSON: { input, output }).
  tokenTotals String @default("{\"input\":0,\"output\":0}")

  /// Última mensagem de erro observada (null quando saudável).
  lastError String?

  /// Estado de vivacidade persistido (ver LivenessState em @kanban-ai/shared).
  livenessState String @default("starting")

  // ── Lease/claim (US-ROB4) ───────────────────────────────────────────────
  /// Token do claim ativo (quem "segura" a execução). Null = livre.
  claimLock String?
  /// Instante de expiração do lease (TTL + heartbeat). Null = sem claim.
  claimExpiresAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([livenessState])
  @@index([claimExpiresAt])
}
```

> **Por que `sessionId == storyId`?** ADR-0022 fixa o CLI sessionId como estável
> por execução. Alinhamos o `sessionId` persistido ao `storyId` (a granularidade
> real de concorrência é por-story, invariante 7). Isso **muda** `start()` para
> **não** usar `Date.now()`. Ver retrocompat abaixo.

## US-ROB2 · Plano de implementação PR-a-PR

1. **PR ROB2-a — enum compartilhado.**
   - Adicionar `LivenessState` em `packages/shared/src/enums.ts`; exportar pelo
     barrel. `npm run build -w @kanban-ai/shared`.

2. **PR ROB2-b — model + migration.**
   - Adicionar `model AgentRuntimeState` em `schema.prisma`.
   - `cd apps/api && npx prisma migrate dev --name agent_runtime_state`
     (gera `YYYYMMDDHHMMSS_agent_runtime_state`).
   - `npx prisma generate`.

3. **PR ROB2-c — session-manager persiste.**
   - Injetar `PrismaService` no `AgentSessionManager` (hoje só recebe
     `APP_CONFIG`). **Manter o Map como cache quente**; a tabela é a fonte
     durável.
   - `start(storyId)`: `sessionId = storyId` (estável); `upsert` em
     `AgentRuntimeState` com `livenessState='starting'`.
   - `setState` / `abort` / `remove`: refletir na linha (`livenessState`,
     `lastError`). Acumular tokens quando o orquestrador reportar (novo método
     `addTokens(storyId, {input, output})`).
   - **Guardar toda escrita durável atrás de `config.agent.runtimePersistEnabled`**
     (default: ligado — persistir é seguro e idempotente; ver risco abaixo). Se
     desligado, comporta-se como hoje (só Map).

4. **PR ROB2-d — boot durável.**
   - Em `Orchestrator.reconcileOnBoot` (92-107): além de re-escanear colunas,
     **ler `AgentRuntimeState`** para restaurar `sessionId`/tokens/liveness das
     stories que continuam In Progress e marcar como `stalled` as que perderam o
     processo (base para US-ROB4).

## US-ROB2 · Pontos de integração

- **`AgentSessionManager`** (todos os métodos que mudam estado) — escreve na tabela.
- **`Orchestrator.reconcileOnBoot`** (92-107) — lê a tabela no boot.
- **`Orchestrator.onStoryEnterInProgress`** (127, `this.sessions.start(storyId)`)
  e **`finishAuto`/`stop`** (`this.sessions.remove(storyId)`) — já chamam o
  session-manager; a persistência acompanha sem novo ponto de chamada.
- **Config:** `config.ts` tipo/valores — `runtimePersistEnabled`.

## US-ROB2 · DOD verificável

- [ ] `agent-runtime-state.spec.ts` (novo, `apps/api/.../session-manager/`): com
      um Prisma fake in-memory, `start`→`setState`→`remove` produz a linha
      esperada; `sessionId === storyId`; tokens acumulam.
- [ ] Caso de boot: `reconcileOnBoot` restaura `sessionId` a partir da tabela
      (não regenera com `Date.now()`).
- [ ] Migration aplica limpo: `npx prisma migrate dev` + `npx prisma migrate reset`
      seguido de `npm run db:seed` continuam verdes.
- [ ] `npx nest build && npm test -w @kanban-ai/api` verdes.
- [ ] `GET /health` responde (fundação executável intacta).

## US-ROB2 · Riscos / invariantes / retrocompat

- **Mudança de `sessionId`:** passar de `sess-${storyId}-${Date.now()}` para
  `storyId` é **quebra de formato**. Auditar consumidores do `sessionId`
  (`grep -rn "sessionId" apps/api/src/modules/ai-engine`) antes do merge — em
  particular o WS `agent.session.state_changed` e o runner CLI. Se algum
  consumidor exige o formato antigo, adaptá-lo no mesmo PR.
- **SEM Redis** (invariante 7): a tabela é durabilidade, **não** um broker; a
  orquestração segue in-process.
- **Idempotência:** todo write é `upsert` por `sessionId`; rodar boot N vezes
  converge para o mesmo estado (espelha a salvaguarda #1).
- **Retrocompat:** com `runtimePersistEnabled=false`, comportamento idêntico ao
  atual. Tabela vazia no boot = sem restauração (fallback ao re-scan atual).

---

# US-ROB3 — Auto-start de dependentes

> **Origem:** Cline + Hermes. `TaskDependency` existe, mas filhos não são
> **promovidos** quando o pai fecha.

## US-ROB3 · Estado atual (verificado)

- **Model** `TaskDependency` (`schema.prisma` 175-190):
  `{ id, dependentId, dependsOnId }`, `@@unique([dependentId, dependsOnId])`.
  Relações `Card.dependsOn` (Dependent) e `Card.dependents` (Dependency).
- **Helpers puros** (`loop-helpers.ts`):
  - `pendingDeps(task, byId)` — dependências ainda não `done`.
  - `taskReady(task, byId)` — task pronta (sem deps pendentes).
  - `pickNextTask(tasks, byId)` — próxima task pronta na ordem canônica.
- **`Orchestrator.onTaskDone(taskId)`** (905-925): quando uma task fecha, para
  cada origem em `TaskDependency` com `dependsOnId == taskId`:
  1. `deleteMany` da aresta resolvida;
  2. **se** a origem não tem mais deps pendentes **e** está em `blocked-dep`,
     move-a para `validating` (re-valida).
- **`stepStoryInner`** (1078-1112): dentro do auto-play, prioriza uma origem em
  re-validação, senão `pickNextTask`.
- **`createDerivedTask`** (969-1035) cria a aresta **reversa** (origem passa a
  depender da derivada) e põe a origem em `blocked_dep`.

## US-ROB3 · Gap concreto

`onTaskDone` só **re-valida** origens que já estavam em `blocked-dep`. Ele **não
promove proativamente** dependentes que ficaram *ready* mas estão em `idle`
(nunca começaram) — esses só avançariam se o auto-play da story já estivesse
rodando e `pickNextTask` os pegasse no próximo tick. Se a story não tem auto-play
ativo (ex.: foi retomada, ou o dependente é de outra story do mesmo epic), o
dependente **não arranca sozinho**. Falta um passo explícito de
**recompute "ready" + promoção** ao fechar o pai.

## US-ROB3 · Contrato proposto (código real)

**Sem novo schema.** Reuso de `TaskDependency` + helpers. Novo método privado no
orquestrador:

```ts
// apps/api/src/modules/ai-engine/orchestrator.ts — NOVO método privado.
/**
 * US-ROB3 — ao fechar `taskId`, recomputa quais dependentes ficaram READY e os
 * promove: garante que o auto-play da story-dona esteja ativo para que
 * `pickNextTask` os execute. Reusa pendingDeps/taskReady (loop-helpers); NÃO
 * reimplementa a checagem de dependências. Idempotente e guardado por flag.
 */
private async promoteReadyDependents(taskId: string): Promise<void> {
  if (!this.config.agent.autostartDependents) return;

  const edges = await this.prisma.taskDependency.findMany({
    where: { dependsOnId: taskId },
    select: { dependentId: true },
  });
  const seenStories = new Set<string>();
  for (const { dependentId } of edges) {
    const dep = await this.loadTask(dependentId);
    if (!dep || dep.execState === 'done') continue;
    const byId = await this.loadSiblingsById(dependentId);
    // READY = sem deps pendentes e ainda não iniciada (idle) ou destravada.
    if (pendingDeps(dep, byId).length > 0) continue;

    const storyId = await this.resolveTaskStory(dependentId); // parentId da task
    if (!storyId || seenStories.has(storyId)) continue;
    seenStories.add(storyId);

    // Só promove se a story-dona está In Progress (invariante 6): nunca acorda
    // o motor de uma story que não está In Progress.
    if (!(await this.isStoryInProgress(storyId))) continue;

    await this.log(dependentId, `dependência ${taskId} resolvida → dependente pronto; garantindo auto-play`);
    if (!this.isAutoRunning(storyId)) {
      // Reusa o caminho canônico de acordar o motor (respeita serialização,
      // concorrência e watchdog).
      await this.onStoryEnterInProgress(storyId);
    }
  }
}
```

> `resolveTaskStory`/`isStoryInProgress` são helpers finos a extrair (ou reusar
> os já existentes de resolução de story/coluna, ex.: `resolveStoryEpic`,
> consultas a `boardColumnId` com `title === 'In Progress'` já usadas em
> `resumeDeferredForStory`). **Reusar** essas consultas, não duplicá-las.

## US-ROB3 · Plano de implementação PR-a-PR

1. **PR ROB3-a — flag de config.**
   - `config.ts`: `autostartDependents: boolean;` (tipo) +
     `autostartDependents: process.env.AGENT_AUTOSTART_DEPENDENTS === 'true',`
     (valores). `.env.example`. Off por default.

2. **PR ROB3-b — promoção.**
   - Adicionar `promoteReadyDependents` no orquestrador.
   - Chamá-lo **no fim de** `onTaskDone` (905-925), **após** o loop de re-validação
     existente (não substituir; o re-validate cobre origens em `blocked-dep`, a
     promoção cobre dependentes `idle`/de outra story do epic).
   - Reusar `pendingDeps`/`taskReady` de `loop-helpers.ts`.

3. **PR ROB3-c — testes.**
   - Casos novos em `orchestrator-guards.spec.ts` (usa fakes): task A→B (B
     depende de A); ao fechar A, B (idle, story In Progress) é promovida e o
     auto-play arranca; com flag off, nada acontece; dependente em story **não**
     In Progress **não** é acordado (invariante 6).

## US-ROB3 · Pontos de integração

- **`Orchestrator.onTaskDone`** (905-925) — chama `promoteReadyDependents` ao
  final (é o único gatilho de "pai fechou").
- **`Orchestrator.onStoryEnterInProgress`** (111-208) — caminho canônico de
  acordar o motor (respeita serialização por epic, concorrência e watchdog).
  **Não** inventar um caminho paralelo de start.
- **`stepStoryInner`/`pickNextTask`** — já executam a task pronta uma vez que o
  auto-play esteja ativo; a promoção só garante que ele esteja ativo.

## US-ROB3 · DOD verificável

- [ ] `orchestrator-guards.spec.ts`: (1) fechar pai promove dependente `idle`;
      (2) flag off → no-op; (3) dependente de story não-In-Progress não é
      acordado; (4) idempotência (chamar 2× não duplica sessão — coberto por
      `onStoryEnterInProgress` já ser idempotente).
- [ ] `npx nest build && npm test -w @kanban-ai/api` verdes.

## US-ROB3 · Riscos / invariantes / retrocompat

- **Invariante 6** (loop só dispara com story In Progress): a promoção **nunca**
  acorda story fora de In Progress — o guard `isStoryInProgress` é obrigatório.
- **Invariante 7** (serialização por epic): reusar `onStoryEnterInProgress`
  garante que a promoção respeite `findConflictingActiveStory` e
  `canStart()`; **não** bypassar.
- **Não** promover tasks derivadas de forma a burlar o cap de derivação — a
  promoção só olha dependências normais; `createDerivedTask` segue seu fluxo.
- **Retrocompat:** `AGENT_AUTOSTART_DEPENDENTS=false` → comportamento atual
  intacto (só o re-validate de `blocked-dep` roda).

---

# US-ROB4 — Stale-claim recovery por TTL

> **Origem:** Hermes + Paperclip. Lease/claim com TTL por execução, recuperado
> pelo **watchdog** (não só no boot). **Sem Redis.**

## US-ROB4 · Estado atual (verificado)

- **Não existe** claim/lease em nenhum model de execução: `schema.prisma` não tem
  `claimLock`/`claimExpiresAt` (confirmado em Card/Iteration/TaskDependency).
- **Watchdog** — `Orchestrator.startWatchdog(storyId)` (1494-1500) cria um
  `setInterval(watchdogIntervalMs)`; `tickWatchdog(storyId)` (1502-1520) **só**
  age quando `session.state === 'dead'` (salvaguarda #3, idempotente): remove a
  sessão, limpa o watchdog, faz cleanup do worktree.
- **Recuperação** de sessões órfãs só acontece no **boot** (`reconcileOnBoot`,
  92-107) — se o processo morre e reinicia, ok; mas uma sessão que "trava" em
  runtime (sem morrer explicitamente) não é recuperada até um restart.
- **Padrão de referência já no repo** (módulo `memory`, ADR-0027):
  - `MemoryLockService.expireStale(nowMs)` (`memory-lock.service.ts` 137-149):
    busca linhas com `expiresAt <= now` e as auto-libera.
  - `MemorySchedulerService` (`memory-scheduler.service.ts`): tick periódico com
    `setInterval`/`clearInterval` **puros** (sem `@nestjs/schedule`), ligado a
    `OnModuleInit`/`OnModuleDestroy`, cada job em `try/catch` (nunca derruba o
    processo), com `unref()` nos timers.
  - Migration `20260812160159_memory_lease` adicionou `expiresAt TIMESTAMP(3)` +
    `leaseId TEXT` ao `MemoryIndex`. **É o molde exato** das colunas de claim.

## US-ROB4 · Gap concreto

- Falta um **lease por execução** (`claimLock` + `claimExpiresAt`) que o
  watchdog **renove** enquanto a sessão está viva e **recupere** quando vence —
  em runtime, não só no boot. Sem isso, uma sessão travada segura o slot de
  concorrência/serialização indefinidamente até um restart manual.

## US-ROB4 · Contrato proposto (código real)

**Colunas** — já incluídas no model `AgentRuntimeState` da US-ROB2 (`claimLock
String?`, `claimExpiresAt DateTime?`, `@@index([claimExpiresAt])`). **Se US-ROB4
for feita antes de US-ROB2**, adicioná-las via migration própria
`agent_claim_lease` (mesmo padrão da `memory_lease`).

**Métodos no orquestrador** (ou num helper fino injetado; mantê-los testáveis):

```ts
// apps/api/src/modules/ai-engine/orchestrator.ts — claim/lease (US-ROB4).

/** Adquire/renova o claim da story por TTL. leaseId = sessionId estável. */
private async claimStory(storyId: string): Promise<void> {
  if (!this.config.agent.claimEnabled) return;
  const ttl = this.config.agent.claimTtlMs;
  await this.prisma.agentRuntimeState.update({
    where: { sessionId: storyId },
    data: { claimLock: storyId, claimExpiresAt: new Date(Date.now() + ttl) },
  });
}

/** Heartbeat: renova o lease enquanto a sessão itera (chamado por iteração). */
private async renewClaim(storyId: string): Promise<void> {
  if (!this.config.agent.claimEnabled) return;
  await this.claimStory(storyId);
}

/**
 * Recovery de claims vencidos — espelha MemoryLockService.expireStale. Busca
 * execuções com claimExpiresAt <= now cujo processo não as mantém vivas e as
 * libera: remove a sessão in-process (se houver), limpa o watchdog e marca a
 * linha como stalled/dead para a serialização liberar o slot. Idempotente.
 */
private async recoverStaleClaims(nowMs = Date.now()): Promise<number> {
  if (!this.config.agent.claimEnabled) return 0;
  const stale = await this.prisma.agentRuntimeState.findMany({
    where: { claimExpiresAt: { lte: new Date(nowMs) }, NOT: { claimLock: null } },
    select: { storyId: true },
  });
  for (const { storyId } of stale) {
    this.logger.warn(`Claim vencido para story=${storyId} — recuperando slot`);
    this.sessions.remove(storyId);
    this.clearWatchdog(storyId);
    void this.workspaces.cleanupWorktree(storyId).catch(() => undefined);
    await this.prisma.agentRuntimeState.update({
      where: { sessionId: storyId },
      data: { claimLock: null, claimExpiresAt: null, livenessState: 'stalled' },
    });
    // Libera a serialização (mesmo caminho de finishAuto).
    void this.resumeDeferredForStory(storyId).catch(() => undefined);
  }
  return stale.length;
}
```

## US-ROB4 · Plano de implementação PR-a-PR

1. **PR ROB4-a — config.**
   - `config.ts`: `claimEnabled: boolean;` + `claimTtlMs: number;` (tipo);
     `claimEnabled: process.env.AGENT_CLAIM_ENABLED === 'true',` e
     `claimTtlMs: num(process.env.AGENT_CLAIM_TTL_MS, 300_000),` (valores).
     `.env.example`. Off por default (`AGENT_CLAIM_ENABLED=false`).
   - **TTL vs watchdog:** `claimTtlMs` (default 5 min) deve ser **>
     `watchdogIntervalMs`** (default 120s) para o heartbeat renovar antes de
     vencer. Documentar no comentário do config.

2. **PR ROB4-b — colunas (só se US-ROB2 ainda não as criou).**
   - Migration `agent_claim_lease` adicionando `claimLock`/`claimExpiresAt` +
     índice. Se US-ROB2 já entregou, **pular** este PR.

3. **PR ROB4-c — claim/renew.**
   - `onStoryEnterInProgress` (após `this.sessions.start`, ~127): chamar
     `claimStory(storyId)`.
   - `runIteration` (início, ~294): chamar `renewClaim(storyId)` (heartbeat por
     iteração).
   - `finishAuto`/`stop`: zerar o claim (`claimLock=null`) junto do `remove`.

4. **PR ROB4-d — recovery no watchdog.**
   - Em `tickWatchdog` (1502-1520): **manter** o cheque de `dead` (salvaguarda #3
     intacta) e **adicionar** a recuperação por lease vencido. Como o watchdog é
     **por-story**, avaliar o claim daquela story; **ou** adicionar um tick
     global leve que chama `recoverStaleClaims()` na cadência do watchdog
     (espelhando `MemorySchedulerService.sweepLocks`). Preferir o tick global
     defensivo (`try/catch`, `unref()`), pois recupera stories cujo watchdog
     por-story já não existe.
   - `reconcileOnBoot` (92-107): chamar `recoverStaleClaims()` também no boot
     (unifica recovery boot + runtime).

## US-ROB4 · Pontos de integração

- **`onStoryEnterInProgress`** (127) — adquire o claim ao criar a sessão.
- **`runIteration`** (294) — heartbeat (`renewClaim`) por iteração.
- **`tickWatchdog`** (1502-1520) — recovery em runtime, **preservando** a
  idempotência (só age em claim vencido ou sessão `dead`).
- **`reconcileOnBoot`** (92-107) — recovery no boot.
- **`finishAuto`/`stop`** (1509-1526) — solta o claim ao encerrar.
- **Padrão a copiar:** `MemoryLockService.expireStale` + `MemorySchedulerService`
  (tick puro `setInterval`, `unref()`, `try/catch` por job).

## US-ROB4 · DOD verificável

- [ ] `claim-lease.spec.ts` (novo, `apps/api/.../ai-engine/`): com Prisma fake,
      `claimStory` grava `claimExpiresAt = now + ttl`; `recoverStaleClaims`
      libera só linhas vencidas; `renewClaim` estende o prazo; idempotência
      (recovery 2× não erra).
- [ ] Caso: sessão viva com heartbeat **não** é recuperada (claim renovado <
      TTL); sessão sem heartbeat > TTL **é** recuperada e o slot liberado.
- [ ] Watchdog continua idempotente (salvaguarda #3): sessão `dead` segue tratada
      como hoje; `orchestrator-guards.spec.ts` de watchdog continua verde.
- [ ] `npx nest build && npm test -w @kanban-ai/api` verdes; `GET /health` ok.

## US-ROB4 · Riscos / invariantes / retrocompat

- **SEM Redis** (invariante 7): o lease vive em Postgres + tick in-process. **Não**
  introduzir broker/lock distribuído.
- **Salvaguarda #3 preservada:** o watchdog **continua** só agindo em estados
  recuperáveis (sessão `dead` **ou** claim vencido). Nunca duplica uma iteração
  `running` viva — por isso o heartbeat (`renewClaim`) deve rodar **antes** do
  vencimento (TTL > intervalo do watchdog).
- **Ordenação de TTL:** `claimTtlMs > watchdogIntervalMs` é requisito — senão o
  watchdog recuperaria sessões vivas. Validar no arranque (log de aviso se
  violado).
- **Retrocompat:** `AGENT_CLAIM_ENABLED=false` → nenhum claim é escrito/lido;
  watchdog e boot comportam-se exatamente como hoje.
- **Dependência de dados:** as colunas vivem em `AgentRuntimeState` (US-ROB2). Se
  ROB4 preceder ROB2, criar as colunas numa migration própria e o `update`
  precisa de uma linha existente — garantir o `upsert` em `claimStory` nesse
  cenário (ou exigir ROB2 antes, conforme a ordem recomendada).

---

## 5. Checklist de validação global (todas as US)

Rodar a partir da raiz e de `apps/api`, garantindo verde antes de concluir cada PR:

```bash
# raiz
npm run build && npm run lint && npm test

# apps/api (targeted)
cd apps/api
npx nest build                 # build sem os *.spec.ts (tsconfig.build.json)
npm test -w @kanban-ai/api     # node:test + ts-node, src/**/*.spec.ts
npx prisma migrate dev         # ao tocar schema (ROB2/ROB4)
npm run db:seed                # após migration (ver CONTRIBUTING.md)
curl localhost:3333/health     # fundação executável intacta
```

> **Ambiente restrito ao Prisma Query Engine:** se o engine não abrir TCP de
> saída, rodar as operações de banco na rede do Docker (ver
> [CONTRIBUTING.md](../../CONTRIBUTING.md) → "Banco de dados em ambientes restritos").

## 6. Regras transversais (valem para as 4 US)

- **Type-safe cross-package:** todo contrato novo (`ResultClass`,
  `minimumArtifactSatisfied`, `LivenessState`) nasce em `packages/shared` e é
  consumido por api (e web, se aplicável) — **atualize os dois lados na mesma
  mudança**.
- **Boundaries:** não importar internals de outro módulo/feature; use o barrel
  público (`packages/shared/src/index.ts`) ou o provider exportado pelo módulo.
- **Flags off por default** para todo comportamento que muda o resultado do loop
  (ROB1/ROB3/ROB4). ROB2 (persistência) pode nascer ligada por ser idempotente e
  aditiva, mas mantenha o kill-switch.
- **Commits atômicos, mensagem semântica** (ver copilot-instructions):
  `feat(ai-engine): ...`, `fix(ai-engine): ...`, `feat(shared): ...`,
  `feat(prisma): ...`.
- **Atualizar `apps/api/src/modules/ai-engine/AGENTS.md`** quando um contrato do
  módulo mudar (novo model, nova flag, novo método público relevante).
- **Nunca** reintroduzir DOR/`acceptance` (invariante 4) e **nunca** mover um
  epic diretamente (invariante 2).
