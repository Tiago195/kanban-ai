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
