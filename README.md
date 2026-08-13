# kanban-ai

**Kanban Agile controlado por AIs autônomas.** Diferente de um board comum, os
*assignees* não são humanos: são **agents de AI** que executam trabalho de
desenvolvimento de software em **loop**.

> **Fundação:** este repo traz arquitetura, guard-rails para AIs e **scaffolding
> executável** (schema Prisma, health-check, WebSocket, migration + seed, loop
> engine com adapter plugável). O **produto** será construído em cima desta base —
> em grande parte pelas próprias AIs.

## Como funciona

Hierarquia **Epic → Story → Task**. O board mostra **stories**; **epics** são
derivados das stories filhas; **tasks** vivem num mini-kanban dentro da story.
Quando uma **story entra em "In Progress"**, o **loop engine** acorda um agent que
trabalha em **iterações encadeadas**, marca o **DOD** e ao final **valida** os
fluxos afetados — criando **tasks derivadas** quando encontra problemas.

Um agent trabalha sobre um **Project**: um repositório git que o engine **clona e
gerencia** num diretório previsível (o agent nunca roda git — [ADR-0008](docs/adr/0008-git-worktree-per-execution.md)).
Você cadastra o Project pela **URL git** (não por um path do host), o que deixa a
API rodar **inteira no Docker** ([ADR-0038](docs/adr/0038-project-clone-in-volume-enables-containerized-api.md)).

## Começando

Pré-requisitos: **Docker** e **Node** (para o frontend e o `npm install`).

```bash
cp .env.example .env
npm install                    # instala os 3 workspaces (usado via bind mount pelo container)

docker compose up -d           # sobe postgres + api (migrations + seed rodam no boot)
curl localhost:3333/health     # smoke da API

npm run dev:web                # frontend no host → http://localhost:5173
```

A API roda containerizada por padrão; o **frontend fica no host** (`npm run dev:web`)
para um dev loop rápido. Para subir o web também em container:
`docker compose --profile docker-app up -d`.

Para derrubar: `docker compose down` (use `-v` para apagar o volume do banco).

> **Copilot CLI no container:** o modo real (`AGENT_RUNNER_KIND=copilot`) precisa do
> CLI autenticado dentro do container. O compose monta `~/.copilot` como read-only
> por padrão (ou passe `GH_TOKEN`). O default `mock` funciona sem isso.

Validação e ambientes restritos (proxy TLS, egress bloqueado) em
[CONTRIBUTING.md](CONTRIBUTING.md).

## Stack

- **Monorepo** npm workspaces
- **Frontend** (`apps/web`): React + Vite + TypeScript + Tailwind + shadcn/ui
- **Backend** (`apps/api`): NestJS + Fastify + Prisma + Postgres
- **MCP** (`apps/mcp`): segundo plano de controle ([ADR-0020](docs/adr/0020-mcp-server-second-control-plane.md))
- **Contratos** (`packages/shared`): enums, DTOs e eventos WebSocket tipados
- **Realtime**: WebSocket (sem F5)
- **Loop engine**: orquestração in-process com watchdog e adapter plugável

## Documentação

| Doc | Conteúdo |
|---|---|
| [AGENTS.md](AGENTS.md) | Como AIs devem trabalhar no repo (guard-rails, invariantes) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Visão macro, módulos, boundaries, contrato WS |
| [docs/loop-engine.md](docs/loop-engine.md) | O núcleo: iteração, DOD, validação, watchdog |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, convenções, scripts, ambientes restritos |
| [docs/adr/](docs/adr/) | Decisões de arquitetura e porquês |
| [docs/reference/kanban.html](docs/reference/kanban.html) | Spec funcional de referência |

## Estrutura

```
kanban-ai/
├── apps/web/          # frontend
├── apps/api/          # backend + loop engine + Prisma
├── apps/mcp/          # MCP Server (ADR-0020)
├── packages/shared/   # contratos compartilhados
├── docs/              # reference/, adr/, loop-engine.md
└── docker-compose.yml # postgres + api (web via profile docker-app)
```
