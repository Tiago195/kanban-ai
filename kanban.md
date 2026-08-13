# backlog

<!-- Stories de correção derivadas do QA rodada 2 (2026-08-06). Prioridade: 🔴 crítico > 🟠 alto > 🟡 médio > 🟢 baixo -->

<!-- Épicos de adoção da memória em colmeia (memory-as-a-living-service, ADR-0027). Criados 2026-08-12 a partir da análise: a colmeia (EP-76..85) está construída mas o kanban-ai NÃO a consome, não há scheduler dos jobs e o MCP só serve stdio local. Ordem recomendada: EP-A (maior ROI) → EP-B → EP-C. -->

<!-- Épicos de melhoria derivados da análise de ferramentas de referência (Hermes Kanban PDF + Cline Kanban + Paperclip + NanoClaw), 2026-08-12. Mapa/roadmap: docs/improvements-from-reference-tools.md (fontes, rastreabilidade, itens a NÃO adotar). SPEC IMPLEMENTÁVEL por épico (estado-atual do código verificado + contratos TS/Prisma exatos + plano PR-a-PR + DOD verificável) em docs/specs/{ep-rob-robustez,ep-colab,ep-obs}.md — LEIA o spec do épico ANTES de implementar qualquer story. Ordem entre épicos: EP-ROB (maior ROI) → EP-COLAB → EP-OBS. Estes 3 épicos (M1-M12) estão em `# done`. -->

<!-- RODADA 2 de melhorias (re-análise de gap, 2026-08-12): após shipar M1-M12, os 4 sub-agents de research releram as fontes a fundo e reportaram 27 findings net-new (16 low-effort, 11 medium). Consolidados em 6 novos épicos abaixo (EP-BLOCK, EP-CTX, EP-SCHED, EP-OBS2, EP-BUX, EP-HARD). Mapa/rastreabilidade: docs/improvements-from-reference-tools.md §7-8 (rodada 2). Cada finding validado contra os 8 invariantes + lista de veto. 2 itens DEFER (Routines cron/webhook = módulo grande; Egress lockdown = conflita ADR-0019). NENHUM implementado ainda — só planejado. Ordem recomendada: EP-BLOCK → EP-CTX (maior ROI no loop) → EP-BUX → EP-HARD → EP-OBS2 → EP-SCHED. -->

- [ ] **🟡 EP-BUX — Board fields & UX de operador** *(Hermes N3/N5 + Cline #1/#2/#3/#4/#5/#6/#7)*
  - **Por quê:** conjunto de refinamentos de board e UX de review majoritariamente low-effort que fecham lacunas do dia-a-dia: sem `priority`, sem idempotency-key (automação duplica task), sem plan-mode, sem diff-por-iteração, sem recovery de estouro de contexto, sem slash-commands/atalhos/temas/notificações no review. 9 stories independentes — podem ir em ondas.
  - **DOD do épico:** priority + idempotency no `Card`; plan/act mode por card; checkpoint+rewind por turn; compaction de contexto; slash-commands, script shortcuts, multi-theme e browser-notifications no front. Build+lint+test verdes; contratos nos dois lados quando aplicável.
  - [ ] **US-BUX1 — Card priority field** *(Hermes N5)* — low
    - `priority Int?` em `Card` (badge/filtro/sort); tiebreak opcional no wakeup queue (M7). Hoje só há `position` (drag manual). Atualizar web (badge) + shared.
    - **DOD:** priority persiste, exibe badge e ordena; specs.
  - [ ] **US-BUX2 — Idempotency key na criação de task** *(Hermes N3)* — low
    - `idempotencyKey String?` em `Card` + unique parcial `(boardId, idempotencyKey) WHERE NOT NULL`; `CardsService.create` retorna o existente em colisão. Evita duplicata de cron/@mention/automação.
    - **DOD:** 2º create com mesma key é no-op retornando o existente; specs.
  - [ ] **US-BUX3 — Plan/Act mode por card (`startInPlanMode`)** *(Cline #2)* — low-med
    - `startInPlanMode Boolean` em `Card`; engine embrulha prompt em "só planeje, não modifique, peça aprovação" quando true; toggle live plan↔act no composer HITL via mutation + WS. Casa com HITL/DOD; plan-mode só vale quando story entra In Progress (invariante 6).
    - **DOD:** story com flag entra em plan-only sem mutar arquivos; toggle troca modo mid-session; specs.
  - [ ] **US-BUX4 — Per-turn git checkpoint + diff-since-last-turn + rewind** *(Cline #1)* — med
    - Engine commita worktree em ref oculto `refs/kanban/checkpoints/<taskId>/turn/<N>` a cada iteração DOD (GIT_INDEX_FILE temp, não polui HEAD); UI de review ganha modo "diff desde o último turn" + rewind. Engine faz git (ADR-0008 preservado).
    - **DOD:** checkpoint por iteração; diff incremental por turn; rewind funcional; specs do módulo git.
  - [ ] **US-BUX5 — Context-overflow compaction** *(Cline #3)* — low
    - Detectar erro de limite de contexto (mapa de regex), trim da metade recente + nota de compactação prependida, retry. Loop longo (muitas iterações DOD) fica resiliente; hoje falha no erro. No error-handler do runner.
    - **DOD:** sessão que estoura contexto se recupera automaticamente e prossegue; specs da função de compaction.
  - [ ] **US-BUX6 — Slash-commands/workflows no composer HITL** *(Cline #4)* — med
    - Autocomplete de `/command` no chat HITL; `/clear` reseta contexto; `/workflow <name>` expande de `.cline/workflows/`; `GET /cards/:id/slash-commands`. Acelera o operador durante HITL.
    - **DOD:** `/clear` e `/workflow` funcionam; endpoint lista comandos por workspace; specs.
  - [ ] **US-BUX7 — Script shortcut launcher (rodar npm test/dev do review)** *(Cline #5)* — low
    - `shortcuts: ProjectShortcut[]` em config; barra de atalhos no review UI dispara comando no terminal (Ctrl-C se ocupado). Reviewer re-roda validação sem sair do browser.
    - **DOD:** atalho definido roda no terminal; specs de config.
  - [ ] **US-BUX8 — Multi-theme UI (light/dark/high-contrast)** *(Cline #6)* — med
    - `data-theme` + override de tokens (Tailwind v4); ≥3 temas (light/dark/high-contrast); pref em localStorage + sync cross-tab. A11y + salas de review 24/7. Hoje só dark.
    - **DOD:** troca de tema aplica ao vivo e persiste; contraste AA; sem regressão visual.
  - [ ] **US-BUX9 — Browser notifications com dedup cross-tab** *(Cline #7)* — low
    - Web Notifications on `awaiting_review` (tag por-task), com presença de aba via localStorage heartbeat evitando disparo se outra aba já foca o board; badge `(N)` no título. Pref do usuário.
    - **DOD:** notificação dispara em aba não-focada, deduplicada cross-tab; badge conta pendências; specs de presença.

- [ ] **🟡 EP-HARD — Endurecimento de segurança & robustez do runner** *(NanoClaw #1/#2/#4/#5/#6)*
  - **Por quê:** o watchdog atual é timer fixo (não sabe a duração declarada da operação), não há freio para crash-loop no boot, nem validação de path antes de tool FS, nem catálogo de ações privilegiadas fail-closed. Endurecimento aditivo sem mudar o modelo de processo. Egress lockdown fica em DEFER (conflita ADR-0019 / depende Docker).
  - **DOD do épico:** watchdog adaptativo por heartbeat+timeout declarado; circuit-breaker de boot; mount allowlist no MCP; guarded action catalog (hold=HITL); tool disallow-list. Build+lint+test verdes.
  - [ ] **US-HARD1 — Adaptive stuck-container SLA** *(NanoClaw #1)* — med
    - Decisão pura combinando heartbeat mtime > teto (estendível por `tool_declared_timeout_ms`) + claim-stuck; janela alarga durante Bash longo declarado. Sem Redis (heartbeat = row/tmpfile por sessão). Refina o watchdog fixo atual.
    - **DOD:** operação longa declarada não é morta cedo; hang de fato é morto; specs da função de decisão.
  - [ ] **US-HARD2 — Startup crash circuit-breaker com backoff persistido** *(NanoClaw #2)* — low
    - `data/circuit-breaker.json` (`{attempt, timestamp}`) lido ANTES do bootstrap Nest; se run anterior não deu clean shutdown na janela, incrementa e dorme `[0,0,10,30,120,300,900]s`; `reset` no exit limpo. Evita martelar DB/LLM em crash-loop.
    - **DOD:** crash-loop no boot aplica backoff crescente; shutdown limpo reseta; specs da função.
  - [ ] **US-HARD3 — Mount allowlist validator no MCP** *(NanoClaw #4)* — med
    - MCP valida path (realpath, blocklist `.ssh/.aws/.kube/.env/...`, per-root RW, fail-closed) antes de honrar tool FS que aponte fora do worktree da story. Allowlist fora do repo-alvo (agent não edita a própria regra).
    - **DOD:** tool FS fora do allowlist é recusada; sem allowlist → tudo bloqueado; specs.
  - [ ] **US-HARD4 — Guarded action catalog (fail-closed allow|hold|deny)** *(NanoClaw #5)* — med
    - Ação privilegiada passa por `guard(action, input)` com branded type (`defineGuardedAction`); wiring faltante = erro de build; `hold` cria `pending_approvals` (= HITL formal antes de transição de story); throw → deny.
    - **DOD:** ação sem guard não compila; hold gera aprovação HITL; approve re-roda checks live; specs.
  - [ ] **US-HARD5 — Tool disallow-list + PreToolUse hooks** *(NanoClaw #6)* — low
    - Lista de tools bloqueadas com redirect (ex.: self-schedule que burlaria o WakeupQueue → bloqueado, reforça invariante 6); hook grava `tool_declared_timeout_ms` que alimenta US-HARD1.
    - **DOD:** tool proibida é bloqueada com mensagem de redirect; timeout declarado propaga ao watchdog; specs.

- [ ] **🟡 EP-OBS2 — Observabilidade rodada 2 (tracing, cost ledger, event log)** *(Paperclip #2/#7/#9/#10 + Hermes N9)*
  - **Por quê:** faltam distributed tracing (liga board→wake→spawn→DB→WS), event log típado para webhooks/tail (o `Activity` atual é texto humano), cost ledger com biller/billingType (o token-sum atual engana com providers mistos — crítico pós-M11), detecção de anomalia por tempo/streak e uma lane barata para wakes status-only.
  - **DOD do épico:** OTel opt-in; `CardEvent` append-only + tail; cost ledger dimensionado; productivity review; cheap recovery lane. Build+lint+test verdes.
  - [ ] **US-OBS2-1 — OTel tracing opt-in zero-overhead** *(Paperclip #9)* — low
    - Lazy-load `@opentelemetry/sdk-node` só quando `OTEL_EXPORTER_OTLP_ENDPOINT` setado; auto-instr HTTP/Fastify/PG; `fs/dns/net` off; ausência do pacote = 1 log e segue. Zero custo em dev.
    - **DOD:** trace completo em Jaeger/Tempo quando ligado; zero overhead quando off; specs de instrumentation.
  - [ ] **US-OBS2-2 — Typed append-only event log (`CardEvent`) + tail + MCP** *(Hermes N9)* — med
    - Modelo `CardEvent` (`kind`, `payload JSON`, `ts`, `@@index([cardId, ts])`); emitido em cada transição; WS tail com `?since=<id>`; tool MCP de query. Convive com `Activity`. ADR sugerido: 0040.
    - **DOD:** transições geram eventos típados; tail incremental por id; webhook externo pode consumir; specs.
  - [ ] **US-OBS2-3 — Cost ledger com biller/billingType/executionSegments** *(Paperclip #10)* — low-med
    - Modelo `CostEvent` (`provider`, `biller`, `billingType`, `cachedInputTokens`) + `executionSegments[]` por fase (cheap_preflight|primary). `subscription_included` não conta budget. Prepara contabilidade multi-adapter (M11).
    - **DOD:** 1 row por segmento; relatório por agent/story/epic correto com providers mistos; specs.
  - [ ] **US-OBS2-4 — Productivity review (anomaly detection)** *(Paperclip #7)* — med
    - Scan periódico sinaliza no-comment streak (≥10 runs), long-active (>6h In Progress), high-churn (>10 runs/h). Cria ação de review rate-limited/snooze-aware — não move nem cancela a story. Sinal além do anti-thrash.
    - **DOD:** anomalia gera ação visível não-intrusiva; rate-limit e snooze; specs dos gatilhos.
  - [ ] **US-OBS2-5 — Cheap recovery model-profile lane** *(Paperclip #2)* — low
    - Wake status-only (limpar status/lock, pedir intervenção) despacha com `modelProfile:"cheap"` + guard `{allowDeliverableWork:false}`; hint scrubbed dos continuations de trabalho real. Corta custo do recovery.
    - **DOD:** recovery status-only usa modelo barato; work real usa modelo normal; specs.

- [ ] **🟢 EP-SCHED — Agendamento & wakes diferidos** *(Paperclip #3/#4)*
  - **Por quê:** não há wake agendado além do watchdog (2 min). Um agent não consegue "voltar em 30 min checar o CI" nem reagir a evento externo (webhook CI/PR). US-SCHED1 (issue monitors) é o núcleo adotável; Routines cron/webhook é DEFER (módulo grande — reavaliar após SCHED1).
  - **DOD do épico:** issue monitors one-shot diferidos durable. Build+lint+test verdes.
  - [ ] **US-SCHED1 — Issue monitors: one-shot deferred wake** *(Paperclip #4)* — med
    - `executionPolicy.monitor = { nextCheckAt, notes, timeoutAt?, maxAttempts? }` (JSONB em `Card` ou `AgentRuntimeState`); scheduler tick dispara `monitor_due` no `nextCheckAt` e limpa; agent re-arma se ainda pendente; auto-clear em done/cancelled. Parkeia espera de serviço externo sem polling. Durable (sobrevive restart).
    - **DOD:** agent parkeia com nextCheckAt e é acordado na hora; re-arm funciona; auto-clear em terminal; specs com fake timer.
  - [ ] **US-SCHED2 — Routines: cron/webhook/API triggers** *(Paperclip #3)* — high — ⏸️ **DEFER**
    - ⏸️ **Adiado (módulo grande):** entidade `Routine` + `routine_triggers` (schedule cron / webhook HMAC / api) + `concurrencyPolicy`/`catchUpPolicy`. Push-driven poderoso (CI-triggered rework, stand-up diário) mas é um módulo novo inteiro. Reavaliar SÓ após US-SCHED1 provar o scheduler tick. Não implementar sem re-priorização explícita.

- [ ] Precisamos melhorar o chat de conversa do backlog-chat
  - ⚠️ **Bloqueado (aguarda clarificação):** item vago, sem sintoma nem critério de aceite. O que melhorar? (UX/layout, streaming de resposta, contexto injetado no prompt, persistência do histórico, latência?) Não é implementável "1 a 1" sem escopo definido pelo usuário.

- [ ] tentar disponibilizar tudo em docker
  - ⚠️ **Bloqueado (conflita com ADR-0019, aceito):** a API precisa rodar no **host** porque o loop engine dá `spawn` no Copilot CLI com `cwd` = git worktree dentro do repo-alvo (`aiProject`), que é um caminho arbitrário do FS do usuário; dentro do Docker a API só enxerga `/app`. O `docker-compose.yml` já expõe o profile opt-in `docker-app` para subir Nest+Vite em container (dev do próprio framework). Não há ação segura sem violar o ADR — reabrir só se o worktree isolado deixar de ser stub e o alvo for montável.


# in progress


# done
<!-- apenas ultimas 2 tarefas, para n poluir o arquivo -->

- [x] **🔴 EP-CTX — Enriquecimento de contexto no re-dispatch** *(Hermes N2/N7 + Paperclip #1)* — **CONCLUÍDO 2026-08-13 (build+lint+test verdes; 390/390 specs API — +18 net-new CTX em `ctx-enrichment.spec.ts`; 2 migrations aditivas `ctx_completion_metadata_and_continuation` + `ctx_wakeup_continuation_enum`, schema válido sem drift; `/health` → status:ok)**
  - 📄 **Spec implementável:** `docs/specs/ep-ctx.md`. **ADR:** `docs/adr/0040-context-enrichment-on-redispatch.md`. **Ordem executada (direto/sequencial — as 3 stories tocam `buildContext`/`buildPrompt`/`runIteration` no mesmo `orchestrator.ts` e correriam entre si).** Ainda **não commitado** (aguardando commits atômicos por story).
  - **DOD do épico:** ✅ re-dispatch injeta "tentativa anterior falhou em X" (`priorAttempt`: `lastError`+`outcome`); ✅ filho recebe `CompletionMetadata` estruturado do pai (herança de `changed_files`/`verification`/`dependencies`/`residual_risk`); ✅ runs classificados por liveness (`classifyRunLiveness`) com continuação bounded (`AGENT_CONTINUATION_CAP`, cede ao anti-thrash no cap). `build && lint && test` verdes; contratos type-safe nos dois lados; aditivo/best-effort; não reintroduz DOR/acceptance (ADR-0007).
  - [x] **US-CTX1 — Prior-attempts context no re-dispatch** *(Hermes N2)* — `buildContext.priorAttempt` lê `AgentRuntimeState.lastError`+`livenessReason` e `outcome` da última iteração; `buildPrompt` injeta bloco "⚠️ Tentativa anterior (re-dispatch)"; `null`/omitido na 1ª execução (sem schema novo). Coberto por `ctx-enrichment.spec.ts`.
  - [x] **US-CTX2 — Completion metadata estruturado + parent-handoff injection** *(Hermes N7)* — `CompletionMetadata` (shared) + `Card.completionMetadata Json?` (migration aditiva); `writeCompletionMetadata` grava snapshot no `done`; `buildContext.parentHandoffs` lê irmãs `done` e `buildPrompt` injeta "🔗 Handoff estruturado". Coberto por specs.
  - [x] **US-CTX3 — Run liveness classification + bounded continuations** *(Paperclip #1)* — `RunLivenessState`+`CONTINUABLE_LIVENESS` (shared); `classifyRunLiveness` (puro) mapeia cada run; `applyContinuationPolicy` incrementa `AgentRuntimeState.continuationAttempt`/`livenessReason`, re-enfileira `WakeupReason='continuation'` (bounded por cap; cede ao anti-thrash ao atingir); `resetContinuation` zera ao avançar. Coberto por specs por estado.


- [x] **🔴 EP-BLOCK — Inteligência de bloqueio & dependência** *(Hermes N1/N6 + Paperclip #5/#8)* — **CONCLUÍDO 2026-08-13 (build+lint+test verdes; 372/372 specs API — +27 net-new BLOCK; migration `add_runtime_block_recurrence` aditiva + schema válido sem drift; smoke empírico: API sobe com "Schema OK: todas as colunas esperadas", `/health` → status:ok)**
  - 📄 **Spec implementável:** `docs/specs/ep-block.md`. **ADR:** `docs/adr/0039-typed-block-taxonomy-and-auto-unblock.md`. **Ordem executada (fleet, waves):** US-BLOCK1 → (US-BLOCK2 ∥ US-BLOCK3 ∥ US-BLOCK4). Ainda **não commitado** (aguardando commits atômicos por story).
  - **DOD do épico:** ✅ bloqueio carrega tipo (`BlockKind` `dependency|needs_input|capability|transient`, coluna nullable retrocompatível); ✅ dependency-block re-enfileira sozinho quando a dependência fecha (`blockers_resolved`); ✅ needs_input/capability sobem a humano; ✅ recorrência da mesma causa N vezes (cross-run, `AgentRuntimeState`) escala em vez de ciclar. `build && lint && test` verdes; contratos type-safe nos dois lados; aditivo (`Card.blocked`/`needsHuman` intactos).
  - [x] **US-BLOCK1 — Typed block reasons (`BlockKind`) + unblock routing** *(Hermes N1)* — enum `BlockKind` em `packages/shared` + `Card.blockKind` nullable + migrations `add_card_block_kind`/`add_wakeup_reason_block_values`; `escalateToHuman(kind='capability')`; `setExecState('blocked-dep')` grava `dependency` e limpa ao sair. 5 specs (`block-taxonomy.spec.ts`).
  - [x] **US-BLOCK2 — Routable blocked: unblock descriptor + auto-notify owner** *(Paperclip #5)* — `BlockedOwner`/`BlockedDescriptor` (shared) + `Card.blockedDescriptor`/`blockedOwnerNotifiedAt`; `routeBlockedCard`: owner=agent → 1 wake `issue_unblock` idempotente (coalescing + anti re-fire `blockedOwnerNotifiedAt`); board/prose-only → `needsHuman`. 8 specs (`block-owner-notify.spec.ts`).
  - [x] **US-BLOCK3 — Blocker-dependency auto-wake (`blockers_resolved`)** *(Paperclip #8)* — `onTaskDone`/`onCardResolved` → `wakeBlockersResolvedDependents`: fecha o último blocker → 1 wake `blockers_resolved` (dedup por `blockerSetHash` no `stateJson`, sem migration); `cancelled` NUNCA satisfaz; respeita invariante 6 (só story In Progress). Hook em `cards.service.move()`. 8 specs (`blockers-resolved-wake.spec.ts`).
  - [x] **US-BLOCK4 — Block-recurrence loop-breaker (cross-run)** *(Hermes N6)* — `AgentRuntimeState.consecutiveBlockCount`+`lastBlockReason` (durável, migration `add_runtime_block_recurrence`); `recordBlockRecurrence` (mesma causa incrementa; diferente reseta p/ 1; N-ésima escala) + `resetBlockRecurrence` no `promoteStory`; config `maxConsecutiveBlocks` (env `AGENT_MAX_CONSECUTIVE_BLOCKS`, default 2, `0` desliga). 6 specs (`block-recurrence.spec.ts`).

