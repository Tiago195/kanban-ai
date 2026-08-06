
# backlog

- [ ] 🔴 Falhas / riscos (as mais graves)

1. Sem cap de iterações por task. O  orchestrator  encadeia iterações sem  maxIterations  nem budget de tokens/tempo. Uma task que nunca fecha o DOD roda pra sempre — custo $ e loop infinito. O watchdog só garante idempotência, não conta tentativas.
2. Sem limite de profundidade na derivação. Se uma task derivada ( createDerivedTask ) também falha na validação, ela deriva outra, sem  derivedDepth  nem contador. O próprio  loop-engine.md  descreve esse exato cenário de "tasks de correção duplicadas em loop infinito" — mas o guard-rail não existe no código.
3. Não escala para humano em falha repetida. HITL só dispara se a própria AI perguntar. Se a validação falha N vezes, nada abre pergunta nem move a story para uma coluna de atenção. A AI pode queimar recursos sozinha.
4. Zero testes. 0 arquivos  *.spec.ts , apesar do  AGENTS.md  do ai-engine exigir testes de encadeamento, idempotência do watchdog, stop graceful/hard e reconciliação no boot. O núcleo não tem rede de segurança.
5. Validação é heurística, não empírica de verdade. O  ValidationRunner  roda  build/lint/test  e checa existência de arquivos, mas não faz o "teste de mesa" dos  affectedFlows  que a doc promete. Suite verde ≠ mudança coberta → falso "passed".
6. ADR-0020 (MCP server) sem implementação — divergência doc↔código.




# in progress

# done
<!-- apenas ultimas 2 tarefas, para n poluir o arquivo -->
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
