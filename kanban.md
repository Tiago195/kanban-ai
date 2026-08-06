
# backlog


# in progress


# done
<!-- apenas ultimas 2 tarefas, para n poluir o arquivo -->
- [x] 🔴 Falhas / riscos (as mais graves)

1. Cap de iterações por task: `AGENT_MAX_ITERATIONS_PER_TASK` (default 30, ON) somado em `enforceLoopGuards`; ao atingir, escala para humano via `escalateToHuman`. ✔
2. Limite de profundidade de derivação: coluna `derivedDepth` no Card (+ migration), incrementada em `createDerivedTask`; `AGENT_MAX_DERIVED_DEPTH` (default 3) escala em vez de derivar. ✔
3. Escalonamento a humano em falha repetida: agora coberto por TRÊS gatilhos → `AGENT_MAX_VALIDATION_FAILURES` + cap de iterações + profundidade de derivação, todos via `escalateToHuman` + `card.needs_human`. ✔
4. Testes do núcleo: `orchestrator-guards.spec.ts` (12) + `validation-coverage.spec.ts` (6) cobrindo caps, escalonamento, encadeamento, idempotência do watchdog, stop graceful/hard e reconcileOnBoot. Suite total 31/31. ✔
5. Validação empírica reforçada: `ValidationRunner` separa arquivos-fonte de specs por fluxo; fluxo sem cobertura verificável vira `problem` (sob `AGENT_REQUIRE_FLOW_COVERAGE`), fechando o falso "passed" de suite verde. ✔
6. ADR-0020 (MCP): NÃO havia divergência — `apps/mcp` (`@kanban-ai/mcp`) já está implementado. Corrigida a única lacuna real (README não listava `apps/mcp`). ✔

- [x] 🟡 Melhorias de qualidade de entrega

• Fechar o ciclo métrica→ação: cost gate (AGENT_MAX_TASK_DURATION_MS / AGENT_MAX_TASK_TOKENS) em enforceLoopGuards escala para humano quando a task estoura duração/tokens. ✔
• Contexto real no prompt: buildContext/buildPrompt injetam o diff acumulado do worktree (Iteration.diff da última iteração, ~20KB). ✔
• Anti-thrash: isThrashing (similaridade de Jaccard sobre summary/nextStep das últimas AGENT_THRASH_WINDOW iterações) escala para humano quando a AI trava. ✔
• Gate de done mais forte: evidence estruturada e verificável (StructuredEvidence + isVerifiableEvidence em @kanban-ai/shared, AGENT_REQUIRE_STRUCTURED_EVIDENCE). ✔

- [x] 🟢 Features alinhadas ao objetivo

• "Needs human" como badge/flag (needsHuman + needsHumanReason no Card) + gatilho de escape por falha repetida de validação (AGENT_MAX_VALIDATION_FAILURES, default 3); promoteStory agora vai para Review. ✔
• Validação empírica direcionada por affectedFlows (mapear files→testes co-located + flag de cobertura AGENT_REQUIRE_FLOW_COVERAGE). ✔
• Diff/replay viewer por iteração (captura git diff do worktree em Iteration.diff + viewer no modal da task). ✔
• Backlog Chat sugere DOD + affectedFlows na criação da story (materializados no /apply). ✔
• Painel de custo/qualidade por story usando as métricas (LoopMetrics compartilhado + LoopMetricsPanel no modal da story). ✔
