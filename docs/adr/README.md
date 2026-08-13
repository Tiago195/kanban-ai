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
| [0014](0014-mock-agent-runner-default.md) | Runner MOCK determinístico como default na fatia do loop | Aceito |
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
| [0027](0027-memory-as-a-living-service.md) | Memória como serviço vivo (colmeia): git como fonte da verdade + índice Postgres/WS (fonte de design: board excalidraw `5WqltgG6Kq8`, seções 18–24) | Aceito |
| [0028](0028-completion-gate-minimum-artifact.md) | Gate de completude por artefato mínimo verificável (`done` não fecha por "falso sucesso"; estende `isVerifiableEvidence` por `ResultClass`) | Proposto |
| [0029](0029-agent-runtime-state-persisted.md) | Estado de runtime do agent persistido (`AgentRuntimeState` sobrevive a restart; colunas de lease p/ stale-claim) | Proposto |
| [0030](0030-multi-tenant-nullable-column.md) | Multi-tenant por coluna `tenantId` nullable (isolamento lógico retrocompatível; ecoa escopo da memória viva) | Aceito |
| [0031](0031-orchestrator-loop-profile.md) | Loop profile "orquestrador" (board-manager) com toolset `board-only` restrito por prompt (cria/atribui/linka cards, NUNCA edita arquivos; gate de `git diff` vazio neutralizado) | Aceito |
| [0032](0032-wakeup-queue-persistent-idempotent.md) | Wakeup queue persistente, idempotente e com coalescing (`WakeupQueue` no Postgres; índice único parcial; executor in-process, sem Redis) | Aceito |
| [0033](0033-mention-delegation-backlog-chat.md) | `@mention` delegation no backlog-chat (`parseMentions` + `MentionDirective`; menção cria e atribui task via `CardsService`, sem schema novo) | Aceito |
| [0034](0034-fleet-dashboard-readmodel.md) | Dashboard de frota como read-model agregado (`GET /dashboard`: counts por coluna + stories stale + burn/cost; reusa `computeStoryMetrics`; sanitizado sem `aiProject`) | Aceito |
| [0035](0035-worktree-isolated-resilient.md) | Worktree isolado resiliente por execução atrás de flag `AGENT_WORKTREE_ISOLATED` (cria/remove worktree real via `git worktree`; espelha ignorados por symlink; init submódulos; preserva patch no restart; refina ADR-0008, retrocompatível com default off) | Aceito |
