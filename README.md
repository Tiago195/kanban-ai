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

Há dois modos de rodar o projeto. **Escolha um.**

### Modo A — tudo no Docker (recomendado, hot-reload incluso)

Sobe Postgres + API + Web em containers. API e Web têm **hot-reload** (edições no
host refletem no container). Migrations e seed rodam automaticamente no boot da API
(seed só é aplicado se o banco estiver vazio — nunca sobrescreve dados existentes).

```bash
cp .env.example .env
docker compose up --build      # postgres + api + web
curl localhost:3333/health     # API
# abra http://localhost:5173    # Web (Vite)
```

Para derrubar: `docker compose down` (adicione `-v` para apagar também o volume do banco).

> **Nota (ambiente com proxy TLS corporativo):** as imagens de dev **não** rodam
> `npm ci` — elas reutilizam as `node_modules` do host via bind mount (evita o erro
> `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` do proxy). Portanto, rode `npm install` no host
> **uma vez** antes do primeiro `docker compose up`. Detalhes em `Dockerfile.dev`.

### Modo B — só o banco no Docker, apps no host

```bash
nvm use && npm install
cp .env.example .env
docker compose up -d postgres

# aguarde o Postgres ficar "healthy" antes de migrar (senão dá P1001):
docker compose ps            # confira STATUS = healthy
# ou: until docker inspect --format '{{.State.Health.Status}}' kanban-ai-postgres | grep -q healthy; do sleep 1; done

npm run db:migrate && npm run db:seed
npm run dev
curl localhost:3333/health   # API_PORT padrão = 3333
```

> **Não misture os modos ao mesmo tempo:** ambos publicam nas portas 3333/5173/5432.
> Rodar `npm run dev` no host enquanto o `docker compose up` (Modo A) está de pé causa
> conflito de porta (`EADDRINUSE`). Derrube um antes de subir o outro.

> Se `npm run db:migrate` retornar `P1001: Can't reach database server`, o Postgres
> ainda não terminou de subir. Espere o `docker compose ps` mostrar `healthy` e
> rode de novo — o migrate é idempotente. Em ambientes com egress TCP restrito,
> veja o workaround em [CONTRIBUTING.md](CONTRIBUTING.md#banco-de-dados-em-ambientes-restritos).

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
├── apps/mcp/          # MCP Server (segundo plano de controle — ADR-0020)
├── packages/shared/   # contratos compartilhados
├── docs/              # reference/, adr/, loop-engine.md
├── Dockerfile.dev     # imagem de dev (hot-reload) para api + web
├── docker/            # entrypoints de dev dos containers api/web
└── docker-compose.yml # postgres + api + web (dev)
```
