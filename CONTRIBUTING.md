# CONTRIBUTING.md — kanban-ai

Guia de contribuição e **guard-rails** para humanos e AIs. Leia também o
[AGENTS.md](AGENTS.md) da raiz e o do módulo que você for tocar.

## Pré-requisitos

- **Node 22** (ver `.nvmrc`), **npm 10** (o projeto usa **npm workspaces** — não
  pnpm/yarn).
- **Docker** (Postgres local via `docker-compose.yml`).

## Setup

```bash
nvm use                # Node 22
npm install            # resolve apps/web, apps/api, packages/shared
cp .env.example .env   # ajuste se necessário
docker compose up -d   # Postgres 16 em 127.0.0.1:5432
npm run db:setup       # migrate deploy + seed (fluxo determinístico p/ setup)
npm run dev            # sobe web + api
```

> `db:setup` usa `prisma migrate deploy` (aplica todas as migrations pendentes de
> forma idempotente, sem prompts) e depois roda o seed. Em **desenvolvimento**, ao
> criar novas migrations, use `npm run db:migrate` (`prisma migrate dev`). Se o
> banco ficar desatualizado (schema drift), a API loga um erro claro no boot e
> `GET /cards` responde **503 acionável** em vez de 500 opaco (ver bug-cards-500).

## Scripts (raiz)

| Script | Faz |
|---|---|
| `npm run dev` | sobe web + api em paralelo |
| `npm run build` | build de todos os workspaces |
| `npm run lint` | ESLint em todos os workspaces |
| `npm run db:migrate` | aplica migrations (dev — `prisma migrate dev`) |
| `npm run db:migrate:deploy` | aplica migrations pendentes (`prisma migrate deploy`) |
| `npm run db:setup` | `db:migrate:deploy` + `db:seed` (setup/CI) |
| `npm run db:seed` | roda `apps/api/prisma/seed.ts` |

## Convenções de código

- **TypeScript estrito**, sem `any` implícito. Tipos de domínio e contratos vivem
  em `packages/shared` — **importe de lá**, não duplique.
- **ESLint + Prettier** compartilhados na raiz. Rode `npm run lint` antes de
  commitar.
- **Naming**: arquivos em `kebab-case`; classes/tipos em `PascalCase`;
  variáveis/funções em `camelCase`; enums de status seguem os valores do domínio
  (ex.: `In Progress`, `blocked-dep`).
- **api (NestJS)**: um módulo por feature (`controller` + `service` + `module`);
  validação de entrada com **Zod** via `ZodValidationPipe`; acesso a dados só via
  `PrismaService`.
- **web (React)**: arquitetura **feature-based**. Cada feature em
  `src/features/<feature>/` expõe apenas o `index.ts` público; genéricos vão em
  `src/shared/`. Não importe internals de outra feature.
- **Comentários** só onde agregam (invariantes, TODOs de stub, decisões não
  óbvias). Não comente o óbvio.

## Estrutura de pastas

Ver [ARCHITECTURE.md](ARCHITECTURE.md). Regra de ouro: **respeite os boundaries**.
Contrato compartilhado → `packages/shared`. Lógica de backend → módulo Nest
correspondente. UI → feature web correspondente.

## Commits

- Mensagens no imperativo, curtas e descritivas (ex.: `feat(ai-engine): encadeia
  iterações`). Prefixos sugeridos: `feat`, `fix`, `docs`, `chore`, `refactor`,
  `test`.
- Não comite `.env`, `node_modules`, artefatos de build ou segredos.

## Guard-rails para AI (obrigatório)

1. **Não reintroduza DOR nem `acceptance`.** O único checklist é o **DOD**
   ([ADR-0007](docs/adr/0007-remove-dor-and-acceptance.md)).
2. **Respeite as invariantes do domínio** listadas no [AGENTS.md](AGENTS.md)
   (epic derivado, task só em Backlog/To Do, pontos Fibonacci, etc.).
3. **Não quebre a fundação executável**: `npm run build`, `npm run lint` e
   `GET /health` devem continuar passando.
4. **Mudou um contrato compartilhado?** Atualize `packages/shared` **e** os dois
   consumidores (web + api) na mesma mudança.
5. **Implementou um stub?** Remova o TODO e atualize o `AGENTS.md` do módulo se o
   contrato mudou.
6. **Não comite segredos.** Sempre a partir de `.env.example`.
7. **Valide antes de concluir.** Rode build + lint e, quando tocar o banco, aplique
   migration + seed.

## Banco de dados em ambientes restritos

Em alguns sandboxes o **Prisma Query Engine (Rust)** não consegue abrir conexões
TCP de saída (erro `P1001`), mesmo com o Postgres saudável. Nesse caso, rode as
operações de banco **dentro da rede do Docker**:

```bash
# Aplicar migration via psql (sem engine Prisma):
docker run --rm --network kanban-ai_default \
  -v "$PWD/apps/api/prisma/migrations/000_init/migration.sql":/mig.sql:ro \
  -e PGPASSWORD=kanban postgres:16-alpine \
  psql -h postgres -U kanban -d kanban_ai -v ON_ERROR_STOP=1 -f /mig.sql

# Rodar o seed dentro de um container com OpenSSL 3 (compatível com o engine):
docker run --rm --network kanban-ai_default \
  -v "$PWD":/app -w /app/apps/api \
  -e DATABASE_URL='postgresql://kanban:kanban@postgres:5432/kanban_ai?schema=public' \
  node:22-bookworm sh -c \
  "../../node_modules/.bin/ts-node --compiler-options '{\"module\":\"CommonJS\"}' prisma/seed.ts"
```

Em ambientes normais, `npm run db:migrate` e `npm run db:seed` funcionam direto.

## Docker: modo HOST (legado) vs modo PROJECT (containerizado)

Há dois modos de rodar a API, ambos suportados (ver
[ADR-0019](docs/adr/0019-api-runs-on-host-not-docker.md) e
[ADR-0038](docs/adr/0038-project-clone-in-volume-enables-containerized-api.md)):

- **Modo HOST (legado / `aiProject`).** Necessário quando o repo-alvo é um path
  arbitrário do host (`Card.aiProject`). Suba só o Postgres e rode a API no host:
  ```bash
  docker compose up -d postgres   # só o banco
  npm run dev                     # api + web no host
  ```
  Para rodar só o Vite no host (dev do frontend), use `npm run dev:web` em vez
  do `web` containerizado.

- **Modo PROJECT (containerizado, default).** Quando o Board usa um `Project`
  (clone gerenciado no volume `kanban_projects`), o `cwd` do agent é interno ao
  container e a API pode rodar em container:
  ```bash
  docker compose up -d            # sobe postgres + api + web (um comando)
  curl localhost:3333/health
  # frontend em http://localhost:5173
  ```
  O volume nomeado `kanban_projects` é montado em `PROJECTS_DIR=/data/projects`; os
  clones ficam em `/data/projects/<projectId>`.

  **Autenticação do Copilot CLI no container** (obrigatória para o loop real —
  `AGENT_RUNNER_KIND=copilot-cli`). Escolha uma:
  - (A) monte a config do CLI do host — o compose já monta
    `${HOST_COPILOT_DIR:-~/.copilot}` em `/root/.copilot:ro`; ou
  - (B) defina `GH_TOKEN`/`GITHUB_TOKEN` no `.env` (repassados ao serviço `api`).

  Com `AGENT_RUNNER_KIND=mock` (default) o loop roda sem CLI/auth — útil para
  validar o clone no volume e o `cwd` interno.

  > **Proxy TLS corporativo:** o `apps/api/Dockerfile` faz
  > `npm install -g @github/copilot`, que pode falhar com
  > `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Injete a CA corporativa antes do build,
  > ou use o modo host.

## Onde pedir contexto

- Núcleo (loop engine): [docs/loop-engine.md](docs/loop-engine.md) e
  `apps/api/src/modules/ai-engine/AGENTS.md`.
- Decisões: [docs/adr/](docs/adr/).
- Spec funcional: [docs/reference/kanban.html](docs/reference/kanban.html).
