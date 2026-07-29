# kanban-ai

**Kanban Agile controlado por AIs autônomas.** Diferente de um board comum, os
*assignees* não são humanos: são **agents de AI** que executam trabalho de
desenvolvimento de software em **loop**.

> Este repositório contém a **fundação**: documentação de arquitetura, guias para
> desenvolvimento com AI, convenções e **scaffolding executável** (estrutura de
> pastas, configs, schema Prisma, interfaces stubadas, health-check, WebSocket,
> migration + seed). O **produto real** será construído depois — em grande parte
> pelas próprias AIs — em cima desta base.

A especificação funcional de referência é o protótipo em
[`docs/reference/kanban.html`](docs/reference/kanban.html).

## Domínio em uma frase

Hierarquia **Epic → Story → Task**. O board mostra **stories**; **epics** são
derivados das stories filhas; **tasks** vivem num mini-kanban dentro da story.
Quando uma **story entra em "In Progress"**, o **loop engine** acorda um agent que
trabalha em **iterações encadeadas**, marca o **DOD**, e ao final **valida** os
fluxos afetados — criando **tasks derivadas** quando encontra problemas.

## Stack

- **Monorepo**: npm workspaces
- **Frontend** (`apps/web`): React + Vite + TypeScript + Tailwind + shadcn/ui
  (feature-based)
- **Backend** (`apps/api`): NestJS + Fastify + Prisma + Postgres
- **Contratos** (`packages/shared`): enums, DTOs e eventos WebSocket tipados
- **Realtime**: WebSocket (sem F5)
- **Loop engine**: orquestração in-process com watchdog e adapter plugável

## Começando

```bash
nvm use && npm install
cp .env.example .env
docker compose up -d
npm run db:migrate && npm run db:seed
npm run dev
curl localhost:3000/health
```

Detalhes em [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentação

| Doc | Conteúdo |
|---|---|
| [AGENTS.md](AGENTS.md) | Como AIs devem trabalhar no repo (guard-rails, invariantes) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Visão macro, módulos, boundaries, contrato WS |
| [docs/loop-engine.md](docs/loop-engine.md) | O núcleo: ciclo de iteração, DOD, validação, watchdog |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, convenções, scripts |
| [docs/adr/](docs/adr/) | Decisões de arquitetura e porquês |

## Estrutura

```
kanban-ai/
├── apps/web/          # frontend
├── apps/api/          # backend + loop engine + Prisma
├── packages/shared/   # contratos compartilhados
├── docs/              # reference/, adr/, loop-engine.md
└── docker-compose.yml # Postgres 16
```
