# AGENTS.md — kanban-ai (raiz)

> Este arquivo orienta **você, agente de AI**, a trabalhar neste repositório com
> segurança e consistência. Leia-o inteiro antes de qualquer alteração. Cada
> módulo relevante tem seu próprio `AGENTS.md` com regras locais — leia também o
> do módulo que você for tocar.

## O que é este projeto

`kanban-ai` é a **fundação** de um **Kanban Agile controlado por AIs autônomas**.
Diferente de um board comum, os *assignees* NÃO são humanos: são **agents
autônomos** que executam trabalho de desenvolvimento de software em **loop**.

A especificação funcional de referência é o protótipo em
[`docs/reference/kanban.html`](docs/reference/kanban.html) — trate-o como a
**fonte da verdade do domínio**. Enums, colunas, seed e loop profiles do backend
foram portados dele.

> ⚠️ Esta é a **fundação**: docs + scaffolding executável (health-check, WS,
> migration+seed, interfaces stubadas). O **produto real ainda não existe** — será
> construído depois, em grande parte pelas próprias AIs, em cima desta base.

## Estrutura do monorepo (npm workspaces)

```
kanban-ai/
├── apps/
│   ├── web/        # Frontend: React + Vite + TS + Tailwind + shadcn (feature-based)
│   └── api/        # Backend: NestJS + Fastify + Prisma + Postgres
├── packages/
│   └── shared/     # Contratos compartilhados: enums, DTOs, eventos WS (CommonJS)
├── docs/
│   ├── reference/  # kanban.html (spec funcional) — NÃO editar como se fosse código
│   ├── adr/        # Architecture Decision Records
│   └── loop-engine.md
├── AGENTS.md, ARCHITECTURE.md, CONTRIBUTING.md, README.md
└── docker-compose.yml   # Postgres 16 local
```

## Invariantes do domínio (NUNCA violar)

1. **Hierarquia Epic → Story → Task** num único `Card` polimórfico (campo `type`,
   hierarquia via `parentId`, `key` `EP-`/`US-`/`TK-`).
2. **Epic é derivado**: seu status vem das stories filhas. **Ninguém move um epic
   diretamente**.
3. **Só se cria task** nas colunas **Backlog** ou **To Do**
   (`TASK_CREATION_COLUMNS`).
4. **Sem DOR e sem `acceptance` no v1** — o único checklist é o **DOD**. Ver
   [ADR-0007](docs/adr/0007-remove-dor-and-acceptance.md). **Não reintroduzir.**
5. **Story points** ∈ `{1,2,3,5,8,13}` (só story/epic; task não tem pontos).
6. O **loop engine** só dispara quando uma **story entra em In Progress**.

## Regras de trabalho para AIs

- **Type-safe sempre.** Contratos vivem em `packages/shared` e são consumidos por
  web e api. Ao mudar um contrato (enum, DTO, evento WS), atualize os **dois**
  lados.
- **Boundaries claros.** Não importe internals de outra feature/módulo; use o
  `index.ts` público (web) ou o provider exportado pelo módulo (api).
- **Não quebre a fundação executável.** `npm run build` e `npm run lint` devem
  continuar passando; `GET /health` deve continuar respondendo.
- **Prefira ferramentas de ecossistema** (nest, vite, prisma, shadcn) a boilerplate
  manual.
- **Stubs têm TODOs claros.** Ao implementar um stub, remova o TODO e atualize o
  `AGENTS.md` do módulo se o contrato mudar.
- **Nunca comite segredos.** Use `.env` (ignorado) a partir de `.env.example`.

## Como rodar / validar

```bash
npm install                 # resolve os 3 workspaces (usados via bind mount)
cp .env.example .env
docker compose up -d        # sobe postgres + api + web (migrations + seed no boot)
curl localhost:3333/health  # smoke do backend
# frontend em http://localhost:5173
npm run build && npm run lint
```

> **Modo PROJECT (default):** com a entidade `Project` (repo clonado no volume
> `kanban_projects`, path interno previsível) a API roda **em container** — um
> comando sobe tudo (ADR-0038). Fallback **host** (legado `aiProject`): `docker
> compose up -d postgres` + `npm run dev` (ver [ADR-0019](docs/adr/0019-api-runs-on-host-not-docker.md)).

> **Nota de sandbox:** em ambientes onde o Prisma Query Engine (Rust) não consegue
> abrir TCP de saída, rode as operações de banco dentro da rede do Docker. Ver
> [CONTRIBUTING.md](CONTRIBUTING.md#banco-de-dados-em-ambientes-restritos).

## Onde olhar primeiro

| Preciso entender... | Leia |
|---|---|
| Visão macro e fluxos | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Loop engine (núcleo) | [docs/loop-engine.md](docs/loop-engine.md) |
| Convenções e guard-rails | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Decisões e porquês | [docs/adr/](docs/adr/) |
| Contratos compartilhados | `packages/shared/src/{enums,domain,events}.ts` |
| Regras do loop engine (código) | `apps/api/src/modules/ai-engine/AGENTS.md` |
