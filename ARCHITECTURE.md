# ARCHITECTURE.md — kanban-ai

Visão de arquitetura da **fundação**. Para o núcleo (loop engine) ver
[docs/loop-engine.md](docs/loop-engine.md); para decisões e porquês ver
[docs/adr/](docs/adr/).

## Visão macro

```
                          WebSocket (eventos, sem F5)
        ┌─────────────────────────────────────────────────────────┐
        │                                                           │
┌───────▼────────┐        HTTP (REST)          ┌───────────────────┴───────┐
│   apps/web     │ ──────────────────────────► │        apps/api           │
│ React+Vite+TS  │ ◄────────────────────────── │   NestJS + Fastify        │
│ Tailwind+shadcn│                             │                            │
└────────────────┘                             │  ┌──────────────────────┐  │
                                               │  │  ai-engine (núcleo)  │  │
   packages/shared  ──── tipos/contratos ────► │  │  Orchestrator        │  │
   (enums, DTOs, eventos WS)  ◄──── consumido ─┤  │  SessionManager      │  │
                                               │  │  AgentRunner (plug)  │──┼──► Copilot CLI
                                               │  │  Validators          │  │    (subprocess, v1)
                                               │  └──────────┬───────────┘  │
                                               │             │              │
                                               │   WorkspaceService         │
                                               │   (git worktree isolado)   │──► repo-alvo
                                               │             │              │      (git local/remoto)
                                               │  ┌──────────▼───────────┐  │
                                               │  │  Prisma → Postgres   │  │
                                               │  └──────────────────────┘  │
                                               └────────────────────────────┘
```

- **web** fala **apenas** com **api** (REST + WebSocket). Não acessa banco nem o
  loop engine diretamente.
- **api** é o orquestrador: expõe REST, mantém estado no Postgres, roda o loop
  engine in-process e emite eventos WS.
- **packages/shared** é a fonte única de tipos (enums de status, DTOs de card,
  contrato de eventos WS). Sem dependências de runtime; **CommonJS** (ver
  [ADR-0002](docs/adr/0002-npm-workspaces-monorepo.md)).
- **repo-alvo**: cada board/story aponta para um repositório onde a AI trabalha;
  cada execução usa um **git worktree isolado** (`WorkspaceService`).

## apps/api — módulos

```
apps/api/src/
├── modules/
│   ├── health/          # GET /health (não depende do banco para responder)
│   ├── boards/          # boards e colunas
│   ├── cards/           # Epic/Story/Task (polimórfico), pontos, DOD, invariantes
│   ├── labels/          # labels (com loopProfileId opcional)
│   ├── assignees/       # agents autônomos
│   └── ai-engine/       # ← NÚCLEO (ver AGENTS.md do módulo e loop-engine.md)
│       ├── orchestrator.ts       # acorda AI quando story→In Progress; watchdog
│       ├── session-manager/      # AgentSessionManager (in-process, plugável)
│       ├── runners/              # AgentRunner (interface) + CopilotCliRunner (v1)
│       ├── loop-profiles/        # feature | bug | refactor | __default
│       ├── iterations/           # diário de iterações
│       └── validators/           # iteração final de validação de fluxos
├── realtime/            # WebSocket gateway + serviço de broadcast (@Global)
├── workspaces/          # git worktree por execução (@Global, STUB)
├── shared/              # config, db (PrismaService), errors, logger, pipes
├── prisma/              # schema.prisma, migrations, seed.ts
└── main.ts              # bootstrap Fastify + registro do @fastify/websocket
```

### Boundaries

- Módulos de domínio dependem de `PrismaService` (em `shared/db`) e do
  `RealtimeService` (global) para emitir eventos.
- O **ai-engine** depende de `AgentRunner` (via token `AGENT_RUNNER`),
  `AgentSessionManager`, `WorkspaceService`, `ValidationRunner` e dos loop
  profiles — todos atrás de interfaces plugáveis para permitir troca (ex.: BullMQ)
  sem tocar no resto.
- `realtime` e `workspaces` são **@Global** (usados por vários módulos).

## Persistência (Prisma + Postgres)

Modelo central: um **`Card` polimórfico** com discriminador `type`
(`epic|story|task`) e hierarquia via `parentId`.

- `Column.isTaskColumn` distingue coluna do board principal (stories) da coluna do
  mini-kanban (tasks). Um card referencia `boardColumnId` **ou** `taskColumnId`.
- Tabelas de apoio: `DodItem`, `Comment`, `Activity`, `AffectedFlow`, `Iteration`
  (diário), `Label`, `Assignee`, `LoopProfile`, `TaskDependency`
  (`derivedFrom`/`dependsOn`) e as junções `CardLabel`/`CardAssignee`.
- Chaves de negócio: `EP-`/`US-`/`TK-` + sequência.

Ver detalhes e porquês em [ADR-0004](docs/adr/0004-prisma-postgres.md).

## Contrato WebSocket

Definido em `packages/shared/src/events.ts` como **união discriminada** por `type`.
A api emite; a web reage. Eventos atuais:

| Evento | Quando |
|---|---|
| `card.moved` | card muda de coluna (board ou mini-kanban) |
| `card.created` | card criado |
| `task.state.changed` | `execState` de uma task muda |
| `dod.checked` | item de DOD marcado/desmarcado |
| `iteration.appended` | nova iteração anexada ao diário |
| `story.entered_in_progress` | story entra em In Progress (dispara o loop) |
| `task.derived` | validação criou task derivada |
| `agent.session.state_changed` | sessão de agent muda de estado |
| `auto.started` / `auto.stopped` | loop iniciado/parado (com `mode`) |
| `ping` | keep-alive |

Consumidores usam o type-guard `isEvent(event, 'card.moved')`.

## Fluxo de uma mudança (exemplo)

1. web faz `PATCH` movendo uma story para **In Progress**.
2. api persiste, emite `card.moved` e `story.entered_in_progress` via WS.
3. `Orchestrator.onStoryEnterInProgress` acorda um agent (respeitando o limite de
   concorrência), inicia o **watchdog** e encadeia iterações.
4. Cada iteração grava um registro no **diário** (`Iteration`), emite
   `iteration.appended`, marca DOD e emite `dod.checked`.
5. Com todos os DOD marcados, roda a **iteração de validação**; se achar problema,
   cria **task derivada** e emite `task.derived`.

Detalhes completos do ciclo, estados e salvaguardas em
[docs/loop-engine.md](docs/loop-engine.md).
