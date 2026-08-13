# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile da API containerizada em MODO PROJECT (ver ADR-0038, revisão parcial
# do ADR-0019).
#
# Diferente do `Dockerfile.dev` (que faz bind mount das node_modules do host e
# NÃO instala nada), esta imagem instala o **Copilot CLI** (`@github/copilot`)
# para que o loop engine possa dar `spawn` no agent DENTRO do container. Isso só
# passou a ser viável porque, com o EP-PROJECT, o repo-alvo da story é um **clone
# gerenciado** num volume nomeado (`kanban_projects` → `PROJECTS_DIR`), com `cwd`
# interno e previsível — o motivo original do ADR-0019 (path `aiProject`
# arbitrário fora de `/app`) deixa de valer no modo Project.
#
# Base Debian (`node:22`), não alpine: os engines nativos (Prisma
# debian-openssl-3.0.x) são glibc.
#
# ⚠️ AMBIENTES COM PROXY TLS CORPORATIVO: um `npm install` limpo aqui pode falhar
# com UNABLE_TO_GET_ISSUER_CERT_LOCALLY (mesma limitação descrita no
# `Dockerfile.dev`). Nesses ambientes, ou (a) injete a CA corporativa antes do
# `npm install`, ou (b) use o serviço `api` de dev (bind mount do host) e monte o
# `copilot` do host — ver docker-compose.yml e ADR-0038 §Consequências.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22

WORKDIR /app

# `git` do sistema é usado pelo ENGINE (worktrees, clone ssh delegado quando
# PROJECTS_ALLOW_SSH=true) — o agent continua proibido de rodar git (invariante 8).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copilot CLI disponível no PATH do container. O runner
# (apps/api/src/modules/ai-engine/runners/copilot-cli.runner.ts) faz `spawn`
# herdando `process.env`; a AUTENTICAÇÃO vem do diretório de config do CLI
# (`~/.copilot`, montado read-only pelo compose) e/ou de `GH_TOKEN`/`GITHUB_TOKEN`
# passados no ambiente. Ver docker-compose.yml e .env.example.
#
# ⚠️ Best-effort: sob proxy TLS corporativo este `npm install -g` pode falhar
# (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). Para NÃO travar o `docker compose up -d`
# nesses ambientes, a falha é tolerada aqui — nesse caso disponibilize o
# `copilot` por outra via (ex.: monte-o do host ou aponte COPILOT_BIN para um
# caminho montado) OU use o modo host. Com AGENT_RUNNER_KIND=mock (default) o
# loop nem invoca a CLI. Injete a CA corporativa antes deste passo para instalar
# a CLI de verdade na imagem.
RUN npm install -g @github/copilot \
  || echo '[api/Dockerfile] AVISO: falha ao instalar @github/copilot (provavel proxy TLS corporativo). Ver comentario acima / ADR-0038.'

# O código e (em dev) as node_modules do monorepo são montados pelo compose
# (bind mount). O entrypoint rebuilda o shared, gera o Prisma Client, aplica
# migrations e sobe o Nest. Ver docker/api-dev-entrypoint.sh.
