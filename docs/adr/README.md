# Architecture Decision Records — kanban-ai

Registro das decisões de arquitetura da fundação. Formato leve
(contexto → decisão → consequências).

| ADR | Título | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Registrar decisões via ADR | Aceito |
| [0002](0002-npm-workspaces-monorepo.md) | Monorepo com npm workspaces | Aceito |
| [0003](0003-nestjs-fastify.md) | Backend com NestJS + Fastify | Aceito |
| [0004](0004-prisma-postgres.md) | Persistência com Prisma + Postgres | Aceito |
| [0005](0005-in-process-orchestration.md) | Orquestração in-process com watchdog e adapter plugável | Aceito |
| [0006](0006-agent-runner-pluggable.md) | AgentRunner plugável (Copilot CLI no v1) | Aceito |
| [0007](0007-remove-dor-and-acceptance.md) | Remover DOR e `acceptance` no v1 (só DOD) | Aceito |
| [0008](0008-git-worktree-per-execution.md) | Git worktree isolado por execução | Aceito |
| [0009](0009-no-auth-v1.md) | Sem autenticação no v1 | Aceito |
| [0010](0010-dnd-kit.md) | Drag-and-drop com @dnd-kit | Aceito |
| [0011](0011-tanstack-query-zustand.md) | Server-state TanStack Query + UI-state Zustand | Aceito |
| [0012](0012-realtime-ws-invalidates-cache.md) | Realtime: WebSocket invalida o cache do TanStack Query | Aceito |
| [0013](0013-epic-status-derived.md) | Status do epic derivado (computado), não persistido | Aceito |
| [0014](0014-mock-agent-runner-default.md) | Runner MOCK determinístico como default na fatia do loop. Emenda US-F3.1 (2026-08-29): env unificada em `AGENT_ADAPTER` (ADR-0036); default `mock` do processo preservado | Aceito |
| [0015](0015-auto-play-server-side.md) | Auto-play server-side com `setInterval` in-process | Aceito |
| [0016](0016-copilot-cli-subprocess-adapter.md) | Copilot CLI real via subprocesso + CliAdapter JSONL configurável | Aceito |
| [0017](0017-streaming-hitl-websocket.md) | Streaming + HITL via WebSocket (rejeição de TanStack AI/SSE) + buffer reativo | Aceito |
| [0018](0018-awaiting-input-in-process.md) | Estado `awaiting-input` mantido in-process (sem migration) | Aceito |
| [0019](0019-api-runs-on-host-not-docker.md) | API roda no HOST; só o Postgres fica em container (agent precisa ver o FS do host) | Aceito |
| [0020](0020-mcp-server-second-control-plane.md) | MCP Server como segundo plano de controle (agent externo opera o board via `apps/mcp`) | Aceito |
| [0021](0021-client-side-routing-with-react-router.md) | Roteamento client-side com react-router (URL própria p/ overlays; F5 preserva a conversa do backlog-chat) | Aceito |
| [0022](0022-hitl-survives-restart-via-cli-session-id.md) | HITL sobrevive a restart via `--session-id` da Copilot CLI (reusa o UUID da sessão; sem migration) | Aceito |
| [0023](0023-backlog-chat-story-threads.md) | Threads por story no chat de backlog (modelo Slack: uma sessão Copilot, transcripts por canal `main`/`story:<id>`) | Aceito |
| [0024](0024-backlog-chat-rich-stories-and-draft-tasks.md) | Stories ricas (`aiSummary`/`aiNotes`) + tasks rascunhadas no backlog-chat, reusando o modelo do `Card` (sem duplicar Epic/Story/Task/DoD) | Aceito |
| [0027](0027-memory-as-a-living-service.md) | Memória como serviço vivo (colmeia): git como fonte da verdade + índice Postgres/WS (fonte de design: board excalidraw `5WqltgG6Kq8`, seções 18–24). Emenda US-F2.10 (2026-08-30): cutover para o grafo (ADR-0041) — git/índice/locks/control-plane revogados; sobrevivem os neurônios `.md` (agora `.hive/` no clone); rollback por `GRAPHIFY_MEMORY_RECALL=false` até a F2.3 | Aceito |
| [0028](0028-completion-gate-minimum-artifact.md) | Gate de completude por artefato mínimo verificável (`done` não fecha por "falso sucesso"; estende `isVerifiableEvidence` por `ResultClass`) | Proposto |
| [0029](0029-agent-runtime-state-persisted.md) | Estado de runtime do agent persistido (`AgentRuntimeState` sobrevive a restart; colunas de lease p/ stale-claim) | Proposto |
| [0030](0030-multi-tenant-nullable-column.md) | Multi-tenant por coluna `tenantId` nullable (isolamento lógico retrocompatível; ecoa escopo da memória viva) | Aceito |
| [0031](0031-orchestrator-loop-profile.md) | Loop profile "orquestrador" (board-manager) com toolset `board-only` restrito por prompt (cria/atribui/linka cards, NUNCA edita arquivos; gate de `git diff` vazio neutralizado) | Aceito |
| [0032](0032-wakeup-queue-persistent-idempotent.md) | Wakeup queue persistente, idempotente e com coalescing (`WakeupQueue` no Postgres; índice único parcial; executor in-process, sem Redis) | Aceito |
| [0033](0033-mention-delegation-backlog-chat.md) | `@mention` delegation no backlog-chat (`parseMentions` + `MentionDirective`; menção cria e atribui task via `CardsService`, sem schema novo) | Aceito |
| [0034](0034-fleet-dashboard-readmodel.md) | Dashboard de frota como read-model agregado (`GET /dashboard`: counts por coluna + stories stale + burn/cost; reusa `computeStoryMetrics`; sanitizado sem `aiProject`) | Aceito |
| [0035](0035-worktree-isolated-resilient.md) | Worktree isolado resiliente por execução atrás de flag `AGENT_WORKTREE_ISOLATED` (cria/remove worktree real via `git worktree`; espelha ignorados por symlink; init submódulos; preserva patch no restart; refina ADR-0008, retrocompatível com default off) | Aceito |
| [0036](0036-multi-agent-adapters.md) | Registry de adapters multi-agente (`copilot-cli` default; env `AGENT_ADAPTER`; `GET /agents/adapters`; `available` booleano derivado de presença de env/CLI, sem vazar segredo; `AgentRunner` inalterado). Emenda US-F3.1 (2026-08-29): `AGENT_ADAPTER` é a única fonte de verdade; `AGENT_RUNNER_KIND` vira alias deprecado (honrado só na ausência, warning único no boot; remoção na próxima versão); sem envs, default do processo segue `mock` (ADR-0014) | Aceito |
| [0037](0037-inline-review-and-optional-autocommit.md) | Review inline + auto-commit/PR opcional gated (US-OBS3): modelo `ReviewComment` + CRUD `/cards/:id/review/comments` + evento WS `review.comment_added`; gate `maybeAutoCommit` (engine faz git, só em worktree isolado, ADR-0008/0035) com `CommitOutcome`; flags `AGENT_AUTO_COMMIT`/`AGENT_AUTO_PR` default off = no-op; não reintroduz DOR/acceptance (ADR-0007) | Aceito |
| [0038](0038-project-clone-in-volume-enables-containerized-api.md) | Project clonado em volume permite API containerizada (US-PROJ5): volume nomeado `kanban_projects` em `PROJECTS_DIR=/data/projects`, `api` sai do profile `docker-app` (`docker compose up -d` sobe api+postgres), auth do Copilot CLI no container via mount `~/.copilot` ro ou `GH_TOKEN`/`GITHUB_TOKEN`; supersede **parcial** do ADR-0019 (modo host preservado p/ `aiProject` legado) | Aceito |
| [0039](0039-typed-block-taxonomy-and-auto-unblock.md) | Taxonomia typed de bloqueio (US-BLOCK1): `BlockKind = dependency\|needs_input\|capability\|transient` + `Card.blockKind BlockKind?` (nullable, aditivo); `escalateToHuman(kind='capability')` grava blockKind+needsHuman; `setExecState('blocked-dep')` marca `dependency` e limpa ao sair; `WakeupReason` estendido com `blockers_resolved`/`issue_unblock`; campos legados `blocked`/`needsHuman` preservados; não reintroduz DOR/acceptance (ADR-0007) | Aceito |
| [0040](0040-context-enrichment-on-redispatch.md) | Enriquecimento de contexto no re-dispatch (EP-CTX): US-CTX1 `buildContext.priorAttempt` (lastError+outcome anteriores) evita re-dispatch amnésico; US-CTX2 `CompletionMetadata` + `Card.completionMetadata Json?` — handoff estruturado (changed_files/verification/residual_risk) herdado por tasks dependentes; US-CTX3 `classifyRunLiveness` + continuação bounded (`AgentRuntimeState.continuationAttempt`/`livenessReason`, `AGENT_CONTINUATION_CAP`) para runs plan_only/empty_response, cede ao anti-thrash no cap; `'continuation'` em `WakeupReason`; aditivo, best-effort, não reintroduz DOR/acceptance (ADR-0007) | Aceito |
| [0041](0041-graphify-mcp-sidecar.md) | Sidecar graphify (US-F1.1): 4º serviço no compose servindo o grafo de conhecimento por MCP/Streamable HTTP (`docker/graphify.Dockerfile`, PyPI `graphifyy[mcp]` pinado); bind 127.0.0.1 + `GRAPHIFY_API_KEY` obrigatória (fail-fast) + porta `GRAPHIFY_MCP_PORT` (8129); um grafo POR Project via `project_path` (grafo global rejeitado) em volume `kanban_graphify_home` FORA dos clones (`GRAPHIFY_OUT` relativo no serve, absoluto só no build), clones `kanban_projects` :ro; zero mudança de comportamento existente | Aceito |
