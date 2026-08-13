# ADR-0038 — Project clonado em volume permite API containerizada (supersede parcial de ADR-0019)

**Status:** Aceito (supersede **parcialmente** o [ADR-0019](0019-api-runs-on-host-not-docker.md))

## Contexto

O [ADR-0019](0019-api-runs-on-host-not-docker.md) moveu a **API para o host** por
uma única causa-raiz: o repo-alvo de uma story era o campo `Card.aiProject`, um
**caminho absoluto arbitrário do filesystem do usuário** (ex.:
`/home/<user>/dev/<qualquer-repo>`). Dentro de um container a API só enxergava o
que estava montado (`.:/app`), então qualquer `aiProject` fora de `/app` falhava
na validação do workspace, e o Copilot CLI ainda executaria dentro do container
sem o ambiente/autenticação nativos do usuário. Montar cada repo-alvo como volume
não escalava (um path diferente por usuário/story).

O **EP-PROJECT** remove essa causa-raiz. Com a entidade `Project` (US-PROJ1..4):

- o repo-alvo passa a ser uma **URL git** clonada pelo **ENGINE** (nunca pelo
  agent — invariante 8 / [ADR-0008](0008-git-worktree-per-execution.md)) para um
  **diretório gerenciado com path previsível**: `<PROJECTS_DIR>/<projectId>`
  (`ProjectWorkspaceService.ensureCloned`, US-PROJ2);
- o loop engine resolve o `cwd` do spawn a partir desse clone gerenciado
  (`resolveStoryTargetRepo` → `localPath`, US-PROJ4), e o worktree isolado
  ([ADR-0035](0035-worktree-isolated-resilient.md)) nasce a partir dele;
- a memória em colmeia fica namespaceada por `projectId`
  ([ADR-0027](0027-memory-as-a-living-service.md)).

Como `<PROJECTS_DIR>` pode ser um diretório **interno ao container** montado num
**volume nomeado**, o `cwd` do agent deixa de ser arbitrário: torna-se
**previsível e contido**. O motivo que justificava o ADR-0019 **deixa de valer no
modo Project**.

Restrições que continuam valendo:

- **O agent NÃO executa git** — todo git é do ENGINE ([ADR-0008](0008-git-worktree-per-execution.md)).
- **`aiProject` NÃO é removido** — permanece como fallback legado (retrocompat dura).
- Sem Redis; contrato type-safe compartilhado entre web e api.
- O **risco #1** do ADR-0019 permanece real: o Copilot CLI precisa **rodar e
  autenticar dentro do container**. Esta ADR o resolve explicitamente.

## Decisão

### 1. Volume gerenciado para os clones (`kanban_projects`)

O `docker-compose.yml` ganha um volume nomeado **`kanban_projects`** montado em
**`/data/projects`** no serviço `api`, com `PROJECTS_DIR=/data/projects`. Todo
clone gerenciado aterrissa em `<PROJECTS_DIR>/<projectId>` — um path **interno e
previsível** ao container (impossível com o `aiProject` arbitrário do host).

### 2. API containerizada por padrão em MODO PROJECT

O serviço `api` sai do profile opt-in `docker-app`: **`docker compose up -d`**
(sem `--profile docker-app`) sobe **api + postgres**. A imagem é construída por
`apps/api/Dockerfile` (instala o Copilot CLI e o `git` do sistema; o código e as
node_modules do host seguem via bind mount para evitar `npm ci` sob proxy TLS
corporativo — mesma limitação do `Dockerfile.dev`).

### 3. Autenticação do Copilot CLI dentro do container (risco #1 — resolvido)

O `CopilotCliRunner` faz `spawn` do CLI herdando `process.env`. A autenticação é
suportada por **dois** mecanismos, ambos configuráveis (nenhum segredo é commitado):

- **Opção A (recomendada):** montar a config/credenciais do CLI do host como
  **read-only**: `${HOST_COPILOT_DIR:-~/.copilot}:/root/.copilot:ro`. O CLI
  procura sua config no `HOME` (root do container → `/root/.copilot`).
- **Opção B (fallback/CI):** repassar `GH_TOKEN`/`GITHUB_TOKEN` por env para o
  serviço `api`.

Ambos estão documentados em `.env.example` e no `docker-compose.yml`.

### 4. Modo HOST legado preservado

O modo do ADR-0019 continua suportado **sem regressão** para `aiProject` legado
(repos fora do volume): não suba o serviço `api` e rode a API no host com
`npm run dev`. O profile `docker-app` permanece como opção documentada e
**acrescenta** o `web` em container (o `api` default já roda em container). Não há
choque de porta: o default é `postgres` + `api`; o profile adiciona `web`.

## Consequências

**Positivas**
- No **modo Project**, a API volta a rodar em container reprodutível
  (`docker compose up -d` → api + postgres), fechando o coelho #1 do EP-PROJECT.
- O `cwd` do agent é **interno e previsível** (`/data/projects/<projectId>` →
  worktree isolado dele), sem remontar volumes por repo-alvo.
- O Copilot CLI autentica no container de forma **reproduzível e documentada**
  (mount `~/.copilot` ou `GH_TOKEN`), resolvendo o risco #1 do ADR-0019.
- Onboarding portável: basta a **URL git**; funciona igual em qualquer máquina/CI.

**Negativas / cuidados**
- Em ambientes com **proxy TLS corporativo**, `npm install -g @github/copilot` na
  imagem pode falhar (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). Mitigação: injetar a CA
  corporativa antes do install, OU usar o modo host. Registrado no `Dockerfile`.
- O CLI escreve estado de sessão em `~/.copilot`; montado `:ro`, a persistência de
  sessão fica no filesystem do container (efêmera). Para sessões duráveis, use
  `GH_TOKEN` + um volume próprio de estado, ou o modo host.
- **Supersede PARCIAL:** o ADR-0019 continua válido para o **fallback legado
  `aiProject`** (paths arbitrários do host exigem a API no host). Esta ADR só o
  supera **no modo Project** (clone gerenciado em volume).

## Referências

- Supersede parcialmente: [ADR-0019](0019-api-runs-on-host-not-docker.md).
- Complementa: [ADR-0008](0008-git-worktree-per-execution.md) (worktree por
  execução), [ADR-0035](0035-worktree-isolated-resilient.md) (worktree isolado),
  [ADR-0027](0027-memory-as-a-living-service.md) (memória por `projectId`).
- Épico: `docs/specs/ep-project.md` (US-PROJ5).
