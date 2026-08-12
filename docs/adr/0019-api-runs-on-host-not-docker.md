# ADR-0019 — API roda no HOST (não no Docker); só o Postgres fica em container

**Status:** Aceito

## Contexto

O loop engine executa o agent (Copilot CLI) como subprocesso
([ADR-0016](0016-copilot-cli-subprocess-adapter.md)), fazendo `spawn` com
`cwd` = um **git worktree** criado DENTRO do repositório-alvo da story
(`aiProject`), para isolar o trabalho ([problema #8 do loop engine]). O
repositório-alvo é um caminho **arbitrário do filesystem do usuário** (ex.:
`/home/<user>/dev/<qualquer-repo>`).

Enquanto a API rodava **dentro de um container Docker**, ela só enxergava o que
estava montado (`.:/app`). Qualquer `aiProject` fora de `/app` falhava na
validação do `WorkspaceService`:

```
Projeto-alvo não encontrado no filesystem: /home/tmeireles/dev/demo/jogo-da-velha
```

Montar cada repositório-alvo como volume não escala: cada usuário aponta para
diretórios diferentes, e exigiria remontar o container a cada novo alvo. Além
disso, mesmo com o path montado, o **Copilot CLI ainda executaria dentro do
container**, sem acesso nativo ao ambiente/autenticação do usuário.

## Decisão

**A API (NestJS) passa a rodar no HOST**, via `npm run dev:api`
(`nest start --watch`) ou `node dist/main.js`. **Somente o Postgres** permanece
em container (`docker compose up -d` sobe apenas o `postgres`).

- Os serviços `api` e `web` do `docker-compose.yml` ficam atrás do profile
  opt-in `docker-app` — só sobem com `docker compose --profile docker-app up`.
  São mantidos apenas para dev do próprio Nest/Vite em container, onde o agent
  enxerga somente `/app`.
- O `main.ts` carrega o `.env` do host via `dotenv`, subindo a árvore de
  diretórios a partir do `cwd` (robusto em dev e em build). Variáveis já
  presentes no ambiente NÃO são sobrescritas (comportamento em container/CI
  preservado).
- O runner real usa o `copilot` do host (`COPILOT_BIN=copilot`, no PATH e
  autenticado via `~/.copilot`), sem depender de `GH_TOKEN` montado.

## Consequências

**Positivas**
- O agent enxerga o filesystem inteiro do host e trabalha em **qualquer**
  `aiProject` sem remontar volumes.
- Copilot CLI roda com o ambiente e a autenticação nativos do usuário.
- Postgres continua isolado/reprodutível em container (`network_mode: host`,
  acessível em `localhost:5432`).

**Negativas / cuidados**
- A máquina de dev precisa de Node 22 + `@github/copilot` instalados e
  autenticados no host.
- Artefatos antigos gerados pelo container Docker como `root` (ex.:
  `apps/*/dist`, `apps/web/node_modules/.vite`, `node_modules/.prisma`,
  `apps/api/.agent-workspaces`) podem precisar de `chown` para o usuário do
  host uma única vez após a migração.
- Há dois `.env` (raiz e `apps/api/.env`); as chaves do runner do loop
  (`AGENT_RUNNER_KIND`, `AGENT_CLI_*`, `COPILOT_BIN`, timeouts) devem viver no
  `apps/api/.env`, pois é o `cwd` da API — evitar drift entre os dois.
  > Existe **um único** template versionado: `.env.example` na **raiz** (todas as
  > chaves documentadas ali). **Não** há `apps/api/.env.example` — os dois `.env`
  > reais são cópias locais não versionadas feitas a partir do template da raiz.

## Como rodar (host)

```bash
docker compose up -d            # só o Postgres
npm run db:migrate && npm run db:seed
npm run dev                     # api + web no host
curl localhost:3333/health
```
