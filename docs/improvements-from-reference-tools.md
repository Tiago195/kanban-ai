# Aglomerado de melhorias — análise de ferramentas de referência

> **Origem:** análise comparativa (2026-08-12) entre o `kanban-ai` e 4 fontes de
> referência: o design spec **Hermes Kanban** (PDF, Nous Research, Rev 01) e os
> repositórios **Cline Kanban**, **Paperclip** e **NanoClaw**
> (`/home/tmeireles/dev/tools/{kanban,paperclip,nanoclaw}`).
>
> Este documento é **conhecimento consolidado + roadmap de melhorias**. Ele NÃO
> altera nenhum invariante do domínio (ver [`AGENTS.md`](../AGENTS.md)). As
> tarefas derivadas daqui vivem no [`kanban.md`](../kanban.md) (backlog).
>
> **⚠️ Este documento é o mapa, não o território.** Ele lista *o quê* e *por quê*.
> O *como implementável* (estado atual do código verificado, contratos TS/Prisma
> exatos, plano PR-a-PR, DOD verificável) está nos **specs densos por épico** em
> [`docs/specs/`](specs/) — leia o spec do épico **antes** de implementar qualquer
> story, para não reinventar contratos que já existem:
>
> | Épico | Spec detalhado (estilo Hermes) | Stories |
> |---|---|---|
> | 🔴 EP-ROB | [`specs/ep-rob-robustez.md`](specs/ep-rob-robustez.md) | US-ROB1..4 |
> | 🟡 EP-COLAB | [`specs/ep-colab.md`](specs/ep-colab.md) | US-COLAB1..4 |
> | 🟡 EP-OBS | [`specs/ep-obs.md`](specs/ep-obs.md) | US-OBS1..4 |
>
> **Descobertas dos specs que corrigem premissas deste mapa** (ancoradas no código
> real, 2026-08-12):
> - **US-ROB1** NÃO cria validação do zero: `isVerifiableEvidence` já existe
>   (`packages/shared/src/domain.ts:304-326`) e o gate de `done` está em
>   `orchestrator.ts:574-620`. A melhoria **estende**, não reescreve.
> - **US-COLAB2** (perfil orquestrador): o toolset do agent é **100% dirigido por
>   prompt** (`buildPrompt`), não por flags — o "perfil restrito" é feito no prompt.
> - **US-OBS2** (worktree resiliente): existem **dois** `WorkspaceService`. O do
>   ai-engine (`apps/api/src/modules/ai-engine/workspaces/`) é o **real** e roda
>   **direto no repo-alvo, sem worktree isolado** (`resolveWorkdir`); o top-level
>   (`apps/api/src/workspaces/`) está **morto** no caminho do loop. Logo US-OBS2
>   tem um **PR-0 bloqueante**: implementar o worktree isolado real (ADR-0008).
> - **Ordem intra-épico otimizada pelos specs:** ROB1→ROB2→ROB4→ROB3 (ROB2 antes
>   de ROB4 evita 2 migrations na mesma tabela); COLAB3→COLAB1→COLAB2→COLAB4;
>   OBS1→OBS3→OBS2→OBS4.

---

## 1. Contexto: o que é o kanban-ai (baseline)

`kanban-ai` é a **fundação** de um Kanban Ágil onde os *assignees* são **agents
de AI autônomos** que trabalham em **loop**. Hierarquia **Epic → Story → Task**
num `Card` polimórfico. Quando uma **story entra em "In Progress"**, o **loop
engine** acorda um agent que itera, marca o **DOD** e valida os fluxos afetados.

Stack: NestJS + Fastify + Prisma + Postgres (api), React + Vite + TS (web),
`packages/shared` (contratos type-safe CommonJS), `apps/mcp` (MCP server como 2º
control plane). Monorepo npm workspaces.

### Invariantes do domínio (NUNCA violar — contexto para toda melhoria)

1. Hierarquia **Epic → Story → Task** num único `Card` polimórfico (`type`,
   `parentId`, `key` `EP-`/`US-`/`TK-`).
2. **Epic é derivado**: status vem das stories filhas. Ninguém move um epic direto.
3. **Task só se cria** em **Backlog** ou **To Do** (`TASK_CREATION_COLUMNS`).
4. **Sem DOR e sem `acceptance` no v1** — o único checklist é o **DOD**
   ([ADR-0007](adr/0007-remove-dor-and-acceptance.md)). Não reintroduzir.
5. **Story points** ∈ `{1,2,3,5,8,13}` (só story/epic; task não tem pontos).
6. O **loop engine** só dispara quando uma **story entra em In Progress**.
7. Concorrência é **por-story** (serializada por epic), não por-task.

---

## 2. O que o kanban-ai já faz MELHOR que as referências (não regredir)

Registro explícito para evitar que uma "melhoria" regrida uma força existente:

- **Hierarquia Epic→Story→Task polimórfica** — as referências são planas
  (tasks + links). O kanban-ai tem hierarquia derivada de 1ª classe.
- **DOD como gate único** — validação empírica por `affectedFlows` + task
  derivada (`derivedFrom`/`dependsOn` com `derivedDepth` cap). Hermes/Cline não
  têm gate de validação empírica.
- **Salvaguardas do loop** — cost-gate, anti-thrash, watchdog, abort limpo, dedup
  de derivação, cap agregado por problema.
- **Git worktree isolado por execução** — o agent NÃO faz git
  ([ADR-0008](adr/0008-git-worktree-per-execution.md)).
- **Memória viva / colmeia** ([ADR-0027](adr/0027-memory-as-a-living-service.md)) —
  neurônios `.md`, lock `FREE`/`EDITING`/`REVIEW`, leitura global / escrita por
  escopo. Já consumida pelo loop (EP-A concluído).
- **Streaming + HITL via WS** — estado `awaiting-input` que sobrevive a restart
  ([ADR-0022](adr/0022-hitl-survives-restart-via-cli-session-id.md)).
- **MCP como 2º control plane** ([ADR-0020](adr/0020-mcp-server-second-control-plane.md)).
- **Contratos type-safe** em `packages/shared`, consumidos por web e api.

---

## 3. Teses centrais de cada fonte

| Fonte | Tese / lacuna que expõe no kanban-ai |
|---|---|
| **Hermes (PDF)** | Padrões de colaboração de 1ª classe (P1–P8), multi-tenant por 1 coluna, stale-claim por TTL, perfil orquestrador |
| **Cline Kanban** | Board leve: **auto-start de dependentes**, worktree resiliente, review inline por linha, adapters multi-agent, auto-commit/PR |
| **Paperclip** | **Estado de runtime persistido**, wakeup queue idempotente, liveness/recovery, dashboard de frota |
| **NanoClaw** | Lição negativa (coordenação in-process é frágil — kanban-ai já acerta) + **gate de completude anti-"falso sucesso"** |

### Convergência (tema dominante)

As 4 fontes convergem num único tema-mãe: **robustez de execução e detecção de
falha real**. Vários itens aparecem em mais de uma fonte:

- **Persistir runtime state / stale-claim recovery** → Paperclip + Hermes
- **Gate de completude anti-falso-sucesso** → NanoClaw (+ reforça `affectedFlows`)
- **Auto-start de dependentes** → Cline + Hermes (P1/P2)
- **Perfil orquestrador / board-manager** → Hermes + Cline

> **Recomendação estratégica:** começar pelos itens de robustez (§4 ALTA) antes
> das features de colaboração/UI (§4 MÉDIA/BAIXA).

---

## 4. Melhorias priorizadas

### 🔴 ALTA prioridade — robustez de execução

#### M1 — Gate de completude anti-"falso sucesso" *(NanoClaw + Hermes)*
`done` não pode fechar só com log/flag. Exigir **artefato verificável mínimo por
tipo de worker**: diff não-vazio, teste passou, ou arquivo dos `affectedFlows`
existe. O kanban-ai já tem `StructuredEvidence` + `affectedFlows` — falta tornar
isso **obrigatório e por-classe** de resultado.
- **Tocar:** `apps/api/src/modules/ai-engine/validators/`, contrato de evidência
  em `packages/shared`.
- **Esforço:** baixo-médio. **ADR sugerido:** 0028.

#### M2 — Estado de runtime persistido por task/sessão *(Paperclip)*
Hoje o loop é in-process e o estado da sessão é efêmero (só reconciliado no boot).
Adicionar modelo `AgentRuntimeState` (`sessionId`, `stateJson`, `tokenTotals`,
`lastError`, `livenessState`). Robustece as salvaguardas e casa com ADR-0022
(HITL sobrevive a restart).
- **Tocar:** novo modelo Prisma + migration + `session-manager/`.
- **Esforço:** médio. **ADR sugerido:** 0029.

#### M3 — Auto-start de dependentes ao concluir parent *(Cline + Hermes P1/P2)*
O kanban-ai tem `TaskDependency` (`dependsOn`) mas **não promove filhos
automaticamente** quando o pai fecha. Implementar recompute "ready" + promoção,
habilitando fan-out/pipeline reais.
- **Tocar:** `orchestrator.ts`, mutations de card.
- **Esforço:** médio.

#### M4 — Stale-claim recovery por TTL *(Hermes + Paperclip)*
Formalizar `claim_lock` + `claim_expires` (lease com TTL) por execução, em vez de
só reconciliar no boot. Robustez contra crash de host, **sem Redis**.
- **Tocar:** `Card`/execução + watchdog.
- **Esforço:** médio.

### 🟡 MÉDIA prioridade — colaboração & observabilidade

#### M5 — Multi-tenant por 1 coluna nullable *(Hermes)*
Destrava multi-projeto/cliente; ecoa o `WRITE_SCOPE` da memória viva. Coluna
`tenantId` nullable nos cards + filtro no board.
- **Esforço:** baixo.

#### M6 — Perfil "orquestrador" / prompt de board-manager *(Hermes + Cline)*
Perfil roteador que só cria/atribui/linka e **nunca edita arquivos** (toolset
restrito). Cline já injeta esse prompt.
- **Esforço:** baixo.

#### M7 — Wakeup queue idempotente + coalescing *(Paperclip)*
Fila persistente que faz merge de wakeups por story/agent (idempotência).
- **Esforço:** médio.

#### M8 — Worktree resiliente *(Cline)*
Espelhar ignored paths (node_modules), init de submodules, preservar patch ao
trash/restart. Depende do worktree deixar de ser stub (ADR-0008/0019).
- **Esforço:** médio.

#### M9 — Review inline por linha + auto-commit/PR opcional *(Cline)*
UX de diff com comentários persistidos como evidência; "ship" opcional após
validação.
- **Esforço:** alto.

#### M10 — Dashboard de frota *(Paperclip)*
Endpoint `/dashboard`: counts por coluna, stale stories, burn/cost agregado.
- **Esforço:** baixo.

### 🟢 BAIXA / futura

#### M11 — Multi-agent adapters *(Cline)*
Abstrair a camada de adapter (Claude/Codex/Gemini) mantendo Copilot como padrão.
- **Esforço:** alto.

#### M12 — @mention delegation *(Hermes P6)*
`@agent` no backlog-chat cria + atribui task.
- **Esforço:** baixo.

---

## 5. ⛔ Explicitamente NÃO adotar no kernel

- **Paperclip enterprise overreach**: org chart de "employees", budgets por
  pessoa, approval gates por padrão, rotação de API keys, governança
  multi-company. → só como plugin / user-space, nunca no kernel.
- **Cline "board-only"**: não regredir para "board + git simples" — perderia
  loop / validação / derivação (as forças do §2).
- **NanoClaw coordenação in-process**: já evitado (cada worker é processo de SO +
  board Postgres). **Reforçar** guard-rails: nunca atrelar coordenação ao
  lifecycle de um SDK in-process; tool names ambíguos.

---

## 6. Rastreabilidade

| Melhoria | Fonte(s) | Prio | ADR sugerido | Épico no kanban.md |
|---|---|---|---|---|
| M1 Gate de completude | NanoClaw, Hermes | 🔴 | 0028 | EP — Robustez de execução |
| M2 Runtime state persistido | Paperclip | 🔴 | 0029 | EP — Robustez de execução |
| M3 Auto-start dependentes | Cline, Hermes | 🔴 | — | EP — Robustez de execução |
| M4 Stale-claim TTL | Hermes, Paperclip | 🔴 | — | EP — Robustez de execução |
| M5 Multi-tenant | Hermes | 🟡 | 0030 | EP — Colaboração & multi-tenant |
| M6 Perfil orquestrador | Hermes, Cline | 🟡 | — | EP — Colaboração & multi-tenant |
| M7 Wakeup queue | Paperclip | 🟡 | — | EP — Colaboração & multi-tenant |
| M8 Worktree resiliente | Cline | 🟡 | — | EP — Observabilidade & UX |
| M9 Review inline / PR | Cline | 🟡 | — | EP — Observabilidade & UX |
| M10 Dashboard de frota | Paperclip | 🟡 | — | EP — Observabilidade & UX |
| M11 Multi-agent adapters | Cline | 🟢 | — | EP — Observabilidade & UX |
| M12 @mention delegation | Hermes | 🟢 | — | EP — Colaboração & multi-tenant |

> **Status M1-M12:** ✅ TODOS shipped (EP-ROB=M1-M4, EP-COLAB=M5-M7+M12,
> EP-OBS=M8-M11), em `# done` no kanban.md, ADRs 0028-0037.

---

## 7. Rodada 2 — re-análise de gap (2026-08-12, pós-M1-M12)

Após shipar M1-M12, 4 sub-agents de research releram as fontes a fundo (Hermes
PDF inteiro + Cline + Paperclip + NanoClaw; excalidraw excluído a pedido) para
achar SÓ o que é **genuinamente net-new**. Resultado: **27 findings ADOTAR**
(16 low-effort, 11 medium) + **2 DEFER**, consolidados em **6 épicos** no backlog.
Cada finding foi validado contra os 8 invariantes (§1) e a lista de veto (§5/§8).

Confirmação importante: **N8 (per-task model override) foi descartado** — o campo
`Card.model` com cascata (task→story→epic→`board.defaultModel`) **já existe**.

### 🔴 EP-BLOCK — Inteligência de bloqueio & dependência *(maior ROI)*

| # | Melhoria | Fonte(s) | Esforço | Invariante |
|---|---|---|---|---|
| M13 | Typed block reasons (`BlockKind`) + unblock routing | Hermes N1 | low | ✅ (0038) |
| M14 | Routable blocked: unblock descriptor + auto-notify | Paperclip #5 | low-med | ✅ |
| M15 | Blocker-dependency auto-wake (reverso do M3) | Paperclip #8 | low | ✅ |
| M16 | Block-recurrence loop-breaker (cross-run) | Hermes N6 | low-med | ✅ |

### 🔴 EP-CTX — Enriquecimento de contexto no re-dispatch *(alto ROI no loop)*

| # | Melhoria | Fonte(s) | Esforço | Invariante |
|---|---|---|---|---|
| M17 | Prior-attempts context no re-dispatch | Hermes N2 | low | ✅ |
| M18 | Completion metadata estruturado + parent-handoff | Hermes N7 | med | ✅ (0039) |
| M19 | Run liveness classification + bounded continuations | Paperclip #1 | med | ✅ |

### 🟡 EP-BUX — Board fields & UX de operador

| # | Melhoria | Fonte(s) | Esforço | Invariante |
|---|---|---|---|---|
| M20 | Card priority field | Hermes N5 | low | ✅ |
| M21 | Idempotency key na criação de task | Hermes N3 | low | ✅ |
| M22 | Plan/Act mode por card | Cline #2 | low-med | ✅ |
| M23 | Per-turn git checkpoint + diff-since-last + rewind | Cline #1 | med | ✅ |
| M24 | Context-overflow compaction | Cline #3 | low | ✅ |
| M25 | Slash-commands/workflows no composer HITL | Cline #4 | med | ✅ |
| M26 | Script shortcut launcher no review | Cline #5 | low | ✅ |
| M27 | Multi-theme UI (light/dark/high-contrast) | Cline #6 | med | ✅ |
| M28 | Browser notifications com dedup cross-tab | Cline #7 | low | ✅ |

### 🟡 EP-HARD — Endurecimento de segurança & robustez do runner

| # | Melhoria | Fonte(s) | Esforço | Invariante |
|---|---|---|---|---|
| M29 | Adaptive stuck-container SLA | NanoClaw #1 | med | ✅ |
| M30 | Startup crash circuit-breaker + backoff persistido | NanoClaw #2 | low | ✅ |
| M31 | Mount allowlist validator no MCP | NanoClaw #4 | med | ✅ |
| M32 | Guarded action catalog (fail-closed allow\|hold\|deny) | NanoClaw #5 | med | ✅ (hold=HITL) |
| M33 | Tool disallow-list + PreToolUse hooks | NanoClaw #6 | low | ✅ (reforça inv.6) |

### 🟡 EP-OBS2 — Observabilidade rodada 2

| # | Melhoria | Fonte(s) | Esforço | Invariante |
|---|---|---|---|---|
| M34 | OTel tracing opt-in zero-overhead | Paperclip #9 | low | ✅ |
| M35 | Typed append-only event log (`CardEvent`) + tail + MCP | Hermes N9 | med | ✅ (0040) |
| M36 | Cost ledger biller/billingType/executionSegments | Paperclip #10 | low-med | ✅ |
| M37 | Productivity review (anomaly detection) | Paperclip #7 | med | ✅ |
| M38 | Cheap recovery model-profile lane | Paperclip #2 | low | ✅ |

### 🟢 EP-SCHED — Agendamento & wakes diferidos

| # | Melhoria | Fonte(s) | Esforço | Invariante |
|---|---|---|---|---|
| M39 | Issue monitors: one-shot deferred wake | Paperclip #4 | med | ✅ |
| — | Routines: cron/webhook/API triggers | Paperclip #3 | high | ⏸️ **DEFER** (módulo grande; reavaliar após M39) |

---

## 8. ⛔ NÃO adotar — rodada 2 (adições)

Além do §5, os agents da rodada 2 confirmaram/expandiram a lista de veto:

- **Paperclip — budget approval-gates / agent device-login + JWT rotation /
  company-portability multi-company / low-trust runtime containment tiers**:
  governança/org-chart enterprise. Enforcement soft/hard de custo já existe
  (cost-gate); a MÁQUINA de aprovação de override e transferência multi-company
  → só plugin / user-space.
- **Egress lockdown (docker `--internal` network)** *(NanoClaw #3)*: ⏸️ DEFER —
  hardening de rede válido, mas depende de Docker e a API roda no host
  (ADR-0019). Só faz sentido como plugin quando/se o worktree for containerizado.
- **NanoClaw — PreCompact hook injetando XML de roteamento / arquivo markdown de
  transcrição como store autoritativo**: acoplaria a correção do kanban-ai à
  compactação interna do SDK; o `Iteration` em Postgres já é o histórico durável
  e consultável. Não regredir para markdown flat.
- **Hermes — goal-mode "judge" por-turn / `delegate_task` RPC in-session / skills
  per-task**: DOD + `affectedFlows` JÁ é o judge; `delegate_task` regrediria a
  hierarquia durável+auditável para RPC efêmero; `skills[]` duplicaria `loopType`.
  Auto-decompose de triage a cada tick do dispatcher também vetado (custo/latência)
  — adotar só a variante "specify" on-demand (parte futura do EP-BUX se priorizada).
