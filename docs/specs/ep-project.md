# EP-PROJECT — Entidade `Project` (repo git clonado & gerenciado pelo kanban-ai)

> **Público-alvo:** agents de AI autônomos que vão implementar este épico **sem
> acesso ao autor**. Este documento é a fonte-da-verdade: todos os caminhos,
> símbolos e contratos aqui foram **verificados no código atual** (branch de
> trabalho). Não "descubra" contratos — eles estão descritos abaixo. Antes de
> tocar qualquer módulo, leia também o `AGENTS.md` da raiz e o do módulo.
>
> **Escopo desta rodada:** SPEC (design implementável). **Nenhum ADR novo** foi
> escrito ainda (será destacado onde um ADR deverá nascer). **Nada
> implementado.**

---

## 0. Sumário do épico — "uma tacada, vários coelhos"

Hoje o repo-alvo de uma story é o campo **`Card.aiProject`**: um **caminho
absoluto arbitrário do filesystem do host** (ex.: `/home/tmeireles/dev/foo`).
Esse acoplamento a um path arbitrário é a **causa-raiz** de vários problemas
estruturais do projeto. `EP-PROJECT` introduz uma **entidade `Project`** que, em
vez de um path, guarda a **URL do repositório git** (https ou ssh). O kanban-ai
**clona o repo para um diretório gerenciado** (volume dedicado), e todo o resto
do sistema passa a referenciar o Project por **id estável**, não por path.

### Coelhos mortos com esta tacada

| # | Problema atual | Como o `Project` resolve |
|---|----------------|--------------------------|
| 1 | **Docker travado (ADR-0019).** A API roda no HOST só porque `aiProject` é path arbitrário fora de `/app`. | O clone vive num **volume gerenciado com path previsível** (`<PROJECTS_DIR>/<projectId>`). O `cwd` do spawn passa a ser interno ao container → **API pode voltar ao Docker** (revisão do ADR-0019). |
| 2 | **Memória-em-colmeia solta.** `bootstrapFromRepo({ repoPath })` varre o `aiProject` local; o bare repo (`MEMORY_GIT_DIR`) é um volume sem dono lógico. | A memória fica **ancorada ao `Project`** (namespace = `projectId`), reproduzível e versionada junto do clone gerenciado. |
| 3 | **Onboarding não-portável.** O usuário precisa já ter o repo no FS local. | Basta colar a **URL git** — o kanban-ai clona. Funciona igual em qualquer máquina/CI. |
| 4 | **Serialização por path (`serializeByRepo`).** Chave = path físico, frágil. | Serialização passa a usar `projectId` (chave estável). |
| 5 | **Herança de repo-alvo (`resolveStoryProject`)** por string de path repetida em epic/story. | Herança passa a ser por `projectId` no Board (raiz) → Card. |

### Stories

| ID | Título | Esforço | Valor | Bloqueio |
|----|--------|---------|-------|----------|
| **US-PROJ1** | Model `Project` + migração de `aiProject` (backward-compatible) | Médio | Alto | Nenhum |
| **US-PROJ2** | Serviço de clone/sync gerenciado (`ProjectWorkspaceService`) | Alto | Alto | US-PROJ1 |
| **US-PROJ3** | Credenciais git (https token / ssh key) por Project | Médio | Alto | US-PROJ1 |
| **US-PROJ4** | Re-plugar loop engine + memória no `Project` (troca `aiProject`→`projectId`) | Alto | Alto | US-PROJ2 |
| **US-PROJ5** | Re-containerizar a API (revisão ADR-0019) + volume de projetos | Médio | Médio | US-PROJ2, US-PROJ4 |
| **US-PROJ6** | UI: criar Project por URL, status de clone, associar Board/Card | Médio | Alto | US-PROJ1..3 |
| **US-PROJ7** | Project Explorer: ver repo clonado + **memória (o que a AI sabe)** | Médio | Alto | US-PROJ1; filtro por Project depende de US-PROJ4 |

### Ordem recomendada de implementação

1. **US-PROJ1 — Model + migração.** Base de tudo. Adiciona a tabela `Project` e
   uma FK **nullable** `projectId` em `Board` (raiz da cascata) mantendo
   `aiProject` como **fallback legado**. Zero regressão.
2. **US-PROJ2 — Clone/sync.** Materializa o clone gerenciado. Sem isto, PROJ4/5
   não têm onde apontar.
3. **US-PROJ3 — Credenciais.** Necessário para repos privados (o caso real).
   Pode andar em paralelo com PROJ2.
4. **US-PROJ4 — Re-plug do loop/memória.** Troca a fonte do `cwd` e do
   `repoPath` da memória de `aiProject`→clone-do-Project. **O ponto mais
   sensível** (toca `resolveWorkdir`, `resolveStoryProject`, `serializeByRepo`,
   `bootstrapFromRepo`).
5. **US-PROJ5 — Docker.** Só faz sentido depois que o clone é gerenciado. **Aqui
   nasce a revisão do ADR-0019.**
6. **US-PROJ6 — UI.** Fecha o loop de onboarding (criar por URL, associar Board).
7. **US-PROJ7 — Project Explorer + Memory Viewer.** Torna o Project e a colmeia
   **visíveis** ao usuário (repo clonado + o que a AI sabe). Depende só de PROJ1
   para começar; o filtro de memória por Project fica correto após PROJ4.

### Tabela de rastreabilidade (US → artefatos afetados)

| US | Prisma | Contratos (`packages/shared`) | API (`apps/api`) | Web (`apps/web`) |
|----|--------|------------------------------|------------------|------------------|
| PROJ1 | novo `model Project`; `Board.projectId` FK nullable | `domain.ts`: `Project`, `ProjectStatus`, `CreateProjectInput` | `modules/projects/` (module+controller+service CRUD); migração | — |
| PROJ2 | `Project.localPath`, `Project.cloneState`, `Project.lastSyncedAt` | `events.ts`: `ProjectCloneStateEvent` | novo `ProjectWorkspaceService` (clone/fetch/reset via `isomorphic-git`) | — |
| PROJ3 | `Project.authKind`, `Project.credentialRef` | `domain.ts`: `ProjectAuthKind` | serviço de credenciais + injeção no clone/fetch | — |
| PROJ4 | — | — | `workspaces/workspace.service.ts` (`resolveWorkdir`), `orchestrator.ts` (`resolveStoryProject`), `memory-bootstrap.service.ts` (`repoPath`), guards `serializeByRepo` | — |
| PROJ5 | — | — | `docker-compose.yml` (volume `kanban_projects`, tira `api` do profile `docker-app`), `config.ts` (`PROJECTS_DIR`), **revisar ADR-0019** | — |
| PROJ6 | — | — | `projects.controller.ts` (endpoints) | `features/projects/` (criar por URL, badge de status, seletor no board) |
| PROJ7 | — | `domain.ts`: `MemoryNeuronSummary`, `MemoryNeuronDetail`, `ProjectRepoInfo`, `MemoryLockState` | `projects.controller.ts`: `GET /projects/:id/memory` (índice via `MemoryIndex`) + `/memory/read` proxy + repo-info (reusa `detectModules`) | `features/projects/` explorer: abas "Repositório" + "O que a AI sabe" |

---

## 1. Fundação já existente (contratos que você NÃO deve reinventar)

> Leia esta seção inteira antes de escrever qualquer linha. Tudo abaixo **já
> existe** e foi verificado no código atual.

### 1.1 O acoplamento a `aiProject` (o que vamos substituir)

- **Schema — `apps/api/prisma/schema.prisma`:**
  - `model Board` (linha ~67) tem `defaultModel String?` como raiz da cascata de
    herança de modelo. **É aqui que `projectId` deve entrar** (raiz da cascata de
    repo-alvo, análoga ao modelo).
  - `model Card` (linha ~106) tem `aiProject String? // aiContext.project
    (repo-alvo)` (linha ~152). É o campo a ser **migrado** (não removido no v1 —
    vira fallback).
- **Resolução do repo-alvo — `apps/api/src/modules/ai-engine/orchestrator.ts`
  (`resolveStoryProject`, linha ~421):** lê `story.aiProject`; se vazio, herda de
  `epic.aiProject`; passa o resultado a `workspaces.resolveTargetRepo(raw)`.
  **Este é o ponto exato onde a resolução passará a considerar o `Project`.**
- **Validação e workdir —
  `apps/api/src/modules/ai-engine/workspaces/workspace.service.ts`:**
  - `resolveWorkdir(key, targetRepoPath)` (linha ~121): recusa vazio, recusa
    dentro do próprio kanban-ai (`isInsideSelfRepo`), recusa inexistente
    (`pathExists`), recusa não-git (`isInsideGitRepo`), garante commit inicial
    (`ensureInitialCommit`), e — se `worktreeIsolated` — cria worktree
    (`createIsolatedWorktree`).
  - `resolveTargetRepo(targetRepoPath)` (linha ~400): normaliza o path.
  - **Com o `Project`, o `targetRepoPath` deixa de ser arbitrário: passa a ser o
    `localPath` do clone gerenciado.** As validações de "existe" e "é git"
    passam a ser garantidas pelo clone, não pelo usuário.
- **Serialização — `serializeByRepo` (config, ver §1.4) e guards em
  `orchestrator-guards.spec.ts`:** hoje a chave de serialização é o path
  (`aiProject`). Passará a ser `projectId`.
- **Runner — `apps/api/src/modules/ai-engine/runners/copilot-cli.runner.ts`
  (linha ~44):** faz `spawn` com `cwd: input.cwd`. **Não muda** — só muda a
  origem do `cwd` (agora um path interno gerenciado).

### 1.2 Memória-em-colmeia (o segundo coelho)

- **`apps/api/src/modules/memory/memory-bootstrap.service.ts`:**
  `bootstrapFromRepo({ repoPath })` (linha ~56) roda `detectModules(repoPath)` e
  cria neurônios. `repoPath` **é o `aiProject`** hoje (ver comentário na
  `memory.schema.ts` linha ~77-78). **Passará a ser o `localPath` do Project.**
- **`apps/api/src/modules/memory/memory-git.service.ts`:** o bare repo da memória
  vive em `config.memory.gitDir` (`MEMORY_GIT_DIR`, default
  `./.kanban-ai-memory/git`), **fora do repo-alvo**. **Decisão de design (ver
  §US-PROJ4):** namespacear a memória por `projectId` (ex.: um subdir/ref por
  Project dentro do bare repo) para que colmeias de projetos distintos não se
  misturem.
- **`memory-gc.service.ts` (`sweepStale({ repoPath })`, linha ~50):** idem —
  `repoPath` migra para `localPath`.

### 1.3 `isomorphic-git` já é dependência

- `apps/api/package.json` linha ~30: `"isomorphic-git": "^1.41.3"`. **Já é usada**
  por `memory-git.service.ts` (`import git from 'isomorphic-git'`). **Use a mesma
  lib** para `clone`/`fetch`/`checkout` — não adicione `simple-git`/`nodegit`.
  `isomorphic-git` suporta `http` (via `isomorphic-git/http/node`) e credenciais
  via `onAuth`. Para **ssh**, `isomorphic-git` **não** fala ssh nativo → ver
  §US-PROJ3 (fallback para `git` do sistema via `child_process` em cwd
  controlado, OU exigir https no v1).

### 1.4 Config — `apps/api/src/shared/config/config.ts`

- Estrutura `AppConfig.agent` já concentra flags do runner. `workspacesDir`
  (`AGENT_WORKSPACES_DIR`, default `./.agent-workspaces`) é o base dos worktrees.
- `serializeByRepo` (`AGENT_SERIALIZE_BY_REPO`, default `false`): guard-rail
  legado "uma story In Progress por repo-alvo físico".
- **Novo:** adicionar bloco `projects` (ver §US-PROJ2/config) com `PROJECTS_DIR`.

### 1.5 ADRs relevantes (leia antes de mexer)

- **ADR-0008** (worktree por execução): o worktree é criado *a partir do*
  repo-alvo. Com Project, o repo-alvo é o clone gerenciado → o worktree é criado
  a partir do clone. **Não reescreve ADR-0008; complementa.**
- **ADR-0019** (API no host): **este épico é o que finalmente permite revisá-lo**
  (US-PROJ5). Não altere o ADR-0019 nesta rodada de spec — a US-PROJ5 registra a
  necessidade de um ADR de superseção.
- **ADR-0027** (memória camada 1, git como fonte da verdade): a ancoragem por
  `projectId` deve respeitar este ADR.

---

## 2. Invariantes (NUNCA violar)

Todo o épico foi desenhado para **não tocar** os 8 invariantes do domínio:

1. Hierarquia **Epic → Story → Task** polimórfica: **inalterada**. `Project` é
   uma entidade **ortogonal** (associada ao `Board`, raiz da cascata), não entra
   na hierarquia de cards.
2. Epic derivado nunca movido direto: **inalterado**.
3. Task só se cria em Backlog/To Do: **inalterado**.
4. Sem DOR/`acceptance`, só DOD (ADR-0007): **inalterado** — não reintroduzir.
5. Story points ∈ {1,2,3,5,8,13}: **inalterado**.
6. Loop dispara story→In Progress: **inalterado** — só muda de ONDE vem o `cwd`.
7. Concorrência por-story serializada por epic sem Redis: **preservada** —
   `serializeByRepo` passa a chavear por `projectId` (ainda in-process, sem
   Redis).
8. **Agent não faz git (ADR-0008); API no host (ADR-0019):** o agent continua
   sem fazer git — **o clone/sync é feito pelo ENGINE**, não pelo agent. O ADR-
   0019 é **revisitado** de forma controlada em US-PROJ5 (com ADR de superseção).

**Retrocompat dura:** `aiProject` **permanece** como fallback. Um Board/Card sem
`projectId` continua resolvendo pelo path legado. Migração é **aditiva**.

---

## US-PROJ1 — Model `Project` + migração de `aiProject`

### Estado atual (verificado)
`Board` não tem noção de repositório; o repo-alvo mora em `Card.aiProject`
(path). Não existe entidade `Project`.

### Gap
Falta uma entidade de primeira classe que represente "o repositório em que a
frota trabalha", desacoplada de path físico.

### Contrato proposto

**(a) Prisma — `apps/api/prisma/schema.prisma`** (novo model + FK nullable):

```prisma
enum ProjectAuthKind {
  none   // repo público (https)
  https  // https + token (PAT)
  ssh    // ssh key
}

enum ProjectCloneState {
  pending  // criado, ainda não clonado
  cloning  // clone em andamento
  ready    // clone disponível em localPath
  failed   // clone/sync falhou (ver lastError)
}

model Project {
  id           String            @id @default(uuid())
  name         String
  repoUrl      String            // https://... ou git@...:...
  defaultBranch String?          // null = branch default do remoto (HEAD)
  authKind     ProjectAuthKind   @default(none)
  // Referência OPACA à credencial (nunca o segredo em si). Ver US-PROJ3.
  credentialRef String?
  // Path gerenciado do clone (PROJECTS_DIR/<id>). Preenchido pelo clone.
  localPath    String?
  cloneState   ProjectCloneState @default(pending)
  lastError    String?
  lastSyncedAt DateTime?
  // Multi-tenant cooperativo (mesmo rótulo opaco de Card.tenantId, ADR-0009).
  tenantId     String?
  createdAt    DateTime          @default(now())
  updatedAt    DateTime          @updatedAt

  boards Board[]
}
```

E em `model Board` (raiz da cascata, ao lado de `defaultModel`):

```prisma
  projectId String?
  project   Project? @relation(fields: [projectId], references: [id], onDelete: SetNull)
```

> **Decisão de design:** `projectId` na **Board** (não no Card). O repo-alvo é
> propriedade do quadro inteiro; a herança `task→story→epic→board` já existe para
> `model` e é o mesmo padrão. `Card.aiProject` **permanece** como override/legado.

**(b) TS — `packages/shared/src/domain.ts`** (+ `index.ts` re-export):

```ts
export type ProjectAuthKind = 'none' | 'https' | 'ssh';
export type ProjectCloneState = 'pending' | 'cloning' | 'ready' | 'failed';

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  authKind: ProjectAuthKind;
  cloneState: ProjectCloneState;
  lastError: string | null;
  lastSyncedAt: string | null; // ISO
  tenantId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  defaultBranch?: string | null;
  authKind?: ProjectAuthKind;
  credentialRef?: string | null; // ver US-PROJ3
  tenantId?: string | null;
}
```

> **Nunca** exponha `credentialRef` conteúdo nem `localPath` absoluto no DTO
> público de leitura (evita vazar layout do FS do servidor).

### Plano PR-a-PR
- **PR-1 (schema+migração):** adiciona `Project`, enums, `Board.projectId`.
  `npm run db:migrate` gera migração **aditiva** (todas colunas novas nullable).
- **PR-2 (contratos):** tipos em `domain.ts` + `index.ts`.
- **PR-3 (CRUD):** módulo `apps/api/src/modules/projects/` (module, controller,
  service) com `POST /projects`, `GET /projects`, `GET /projects/:id`,
  `DELETE /projects/:id`. Validação Zod de `repoUrl` (https/ssh syntax).

### DOD verificável
- [ ] `npm run db:migrate` aplica limpo; `npm run db:seed` continua verde.
- [ ] `POST /projects { name, repoUrl }` cria com `cloneState='pending'`.
- [ ] Board pré-existente **sem** `projectId` continua funcionando (fallback
      `aiProject`) — teste de não-regressão.
- [ ] `npm run build && npm run lint && npm test` verdes.

---

## US-PROJ2 — Serviço de clone/sync gerenciado (`ProjectWorkspaceService`)

### Estado atual (verificado)
Não há clone. `resolveWorkdir` assume que o path já existe e é git.

### Gap
Falta materializar o repo a partir da `repoUrl` num diretório gerenciado, com
estados observáveis (`pending→cloning→ready|failed`) e sync (fetch) sob demanda.

### Contrato proposto

**(a) Config — `config.ts`** (novo bloco `projects`):

```ts
projects: {
  /** Base gerenciada dos clones. PROJECTS_DIR. Default './.kanban-ai-projects'. */
  dir: string;
  /** Timeout (ms) de clone/fetch. PROJECTS_GIT_TIMEOUT_MS. Default 300000. */
  gitTimeoutMs: number;
}
```

**(b) Serviço — `apps/api/src/modules/projects/project-workspace.service.ts`:**

```ts
class ProjectWorkspaceService {
  // Clona repoUrl para <PROJECTS_DIR>/<projectId>; atualiza cloneState/localPath.
  ensureCloned(projectId: string): Promise<string>; // retorna localPath
  // git fetch + reset --hard origin/<branch>; atualiza lastSyncedAt.
  sync(projectId: string): Promise<void>;
  // Remove o diretório gerenciado (ao deletar Project).
  remove(projectId: string): Promise<void>;
}
```

- Usa **`isomorphic-git`** (`clone`, `fetch`, `checkout`) para **https**; usa
  `isomorphic-git/http/node` como transport. Emite `ProjectCloneStateEvent` a
  cada transição.
- **Guard-rails (reusa o espírito de `resolveWorkdir`):** `localPath` NUNCA pode
  cair dentro do próprio kanban-ai (reusar/portar `isInsideSelfRepo`);
  `PROJECTS_DIR` é sempre resolvido para absoluto e criado se ausente.

**(c) Evento — `packages/shared/src/events.ts`** (+ union):

```ts
export interface ProjectCloneStateEvent {
  type: 'project.clone_state';
  projectId: string;
  state: ProjectCloneState;
  error?: string;
}
```

### Plano PR-a-PR
- **PR-1:** config `projects` + env docs no `.env.example` (raiz).
- **PR-2:** `ProjectWorkspaceService.ensureCloned` (https público) + evento WS +
  transições de estado persistidas.
- **PR-3:** `sync` (fetch + fast-forward) e `remove`.
- **PR-4:** hook no CRUD: `POST /projects` dispara `ensureCloned` assíncrono
  (não bloqueia a resposta; estado observável via evento/`GET`).

### DOD verificável
- [ ] `POST /projects` com URL pública clona e chega a `cloneState='ready'` com
      `localPath` populado; `git log` do clone existe.
- [ ] Falha de URL inválida → `cloneState='failed'` + `lastError` legível (sem
      stacktrace cru).
- [ ] `POST /projects/:id/sync` faz fetch e atualiza `lastSyncedAt`.
- [ ] Clone **nunca** aterrissa dentro do kanban-ai (teste de guard-rail).
- [ ] `npm run build && npm run lint && npm test` verdes.

### Riscos
- **Repos gigantes:** clone raso (`--depth`) é uma otimização — deixar
  configurável mas **default full** (o loop pode precisar de histórico para diff).
- **Concorrência:** dois `ensureCloned` simultâneos do mesmo Project → serializar
  por `projectId` (lock in-process, sem Redis — invariante 7).

---

## US-PROJ3 — Credenciais git por Project (https token / ssh)

### Estado atual (verificado)
Sem auth (ADR-0009). `isomorphic-git` na memória usa repo local (sem rede).

### Gap
Repos privados (o caso real) exigem credencial. Segredos **não** podem ir para o
banco em claro nem para DTO/log.

### Contrato proposto
- `Project.authKind` ∈ `{none, https, ssh}` e `Project.credentialRef` (**ref
  opaca**, não o segredo).
- **v1 pragmático (recomendado):** `credentialRef` aponta para uma **env var**
  do servidor (ex.: `credentialRef='GH_TOKEN_ACME'` → o serviço lê
  `process.env.GH_TOKEN_ACME`). Zero segredo no banco. Documentar no
  `.env.example`.
- **https:** `isomorphic-git` `onAuth: () => ({ username, password: token })`.
- **ssh:** `isomorphic-git` **não fala ssh**. Duas saídas:
  - **(a)** v1 **só https** (mais simples; `authKind='ssh'` aceito no schema mas
    o clone via ssh delega ao `git` do sistema por `child_process` num cwd
    controlado — atrás de flag), OU
  - **(b)** exigir https no v1 e registrar ssh como follow-up.
  **Recomendação:** implementar https completo; ssh via `git` do sistema atrás de
  flag `PROJECTS_ALLOW_SSH` (default false).

### DOD verificável
- [ ] Clonar repo privado por https+token (via `credentialRef`→env) chega a
      `ready`.
- [ ] `GET /projects/:id` **não** retorna token nem `localPath`.
- [ ] Nenhum segredo aparece em logs (teste que asserta redaction).
- [ ] `npm run build && npm run lint && npm test` verdes.

---

## US-PROJ4 — Re-plugar loop engine + memória no `Project`

> **A story mais sensível.** Aqui a fonte do `cwd` e do `repoPath` da memória
> muda de `aiProject`→clone-do-Project, **sem quebrar o fallback legado**.

### Estado atual (verificado)
- `orchestrator.ts::resolveStoryProject` (linha ~421) resolve `aiProject`
  (story→epic) e chama `workspaces.resolveTargetRepo`.
- `workspace.service.ts::resolveWorkdir` valida/materializa o path.
- `memory-bootstrap.service.ts::bootstrapFromRepo({ repoPath })` usa o path.
- `serializeByRepo` chaveia por path.

### Gap
Nada consulta o `Project`. A resolução precisa: **se o Board tem `projectId`,
usar `Project.localPath` (garantindo `ensureCloned` primeiro); senão, cair no
`aiProject` legado.**

### Contrato proposto (mudanças cirúrgicas)
1. **`resolveStoryProject`**: novo caminho — dado o `boardId` da story, se o
   Board tem `projectId`, chamar `ProjectWorkspaceService.ensureCloned(projectId)`
   e retornar o `localPath`. Fallback: lógica atual de `aiProject`.
2. **Serialização (`serializeByRepo`)**: quando houver `projectId`, chavear por
   `projectId` (estável) em vez do path. Sem `projectId`, manter path (legado).
3. **Memória**: `bootstrapFromRepo`/`sweepStale` recebem o `localPath` do
   Project; namespacear a colmeia por `projectId` (ver §1.2) para não misturar
   projetos.
4. **`resolveWorkdir`**: **não muda a assinatura** — continua recebendo um path.
   Só passa a receber o `localPath` gerenciado. As validações de "existe/é git"
   viram invariantes garantidos pelo clone (mas mantê-las é defesa em
   profundidade).

### Plano PR-a-PR
- **PR-1:** `resolveStoryProject` consulta Board.projectId → ensureCloned →
  localPath, com fallback aiProject. Testes cobrindo os dois caminhos.
- **PR-2:** serialização por `projectId`.
- **PR-3:** memória ancorada por `projectId` (namespace) + `repoPath`=localPath.

### DOD verificável
- [ ] Board **com** `projectId`: story→In Progress clona (se preciso) e o agent
      roda com `cwd` = clone gerenciado.
- [ ] Board **sem** `projectId`: comportamento idêntico ao de hoje (aiProject).
- [ ] Duas stories de épicos diferentes no MESMO Project serializam por
      `projectId`.
- [ ] `memory/bootstrap` cria neurônios a partir do clone; colmeias de projetos
      diferentes não colidem.
- [ ] `npm run build && npm run lint && npm test` verdes + **smoke empírico**:
      criar Project com URL pública real, mover uma story para In Progress
      (runner mock) e confirmar o `cwd` resolvido.

### Riscos / retrocompat
- **Não remover `aiProject`** nesta rodada — é o fallback e a rede de segurança.
- Ordenar: `ensureCloned` **antes** de `resolveWorkdir` (senão o worktree falha
  por path inexistente).

---

## US-PROJ5 — Re-containerizar a API (revisão do ADR-0019)

### Estado atual (verificado)
`docker-compose.yml`: `api`/`web` atrás do profile `docker-app`; comentário e
ADR-0019 explicam que a API roda no host porque `aiProject` é path arbitrário.

### Gap
Com o clone **gerenciado num volume**, o `cwd` do spawn é **interno e
previsível** → o motivo do ADR-0019 deixa de valer para o caso Project.

### Contrato proposto
- **Volume gerenciado:** `docker-compose.yml` ganha um volume nomeado
  `kanban_projects` montado em `PROJECTS_DIR` (ex.: `/data/projects`) no serviço
  `api`.
- **API containerizada:** tirar `api` do profile `docker-app` **quando** o modo
  Project estiver ativo. **Cuidado:** o Copilot CLI ainda precisa rodar e
  autenticar **dentro** do container (montar `~/.copilot` como volume, ou usar
  `GH_TOKEN`). Isto é o ponto delicado que o ADR-0019 levantou — **resolver
  explicitamente** (montar credencial do CLI OU documentar requisito).
- **ADR de superseção:** escrever **ADR-0038 — Project clonado em volume permite
  API containerizada (supersede parcial de ADR-0019)** — *(a ser escrito quando
  esta US for implementada; nesta rodada de spec, apenas registrado).*

### DOD verificável
- [ ] `docker compose up -d` (sem `--profile docker-app`) sobe API + Postgres.
- [ ] Criar Project por URL dentro do container clona no volume `kanban_projects`.
- [ ] Um loop (mock runner) roda com `cwd` interno ao container.
- [ ] O modo host (ADR-0019) **continua funcionando** para `aiProject` legado
      (compat: manter o profile como opção).
- [ ] Copilot CLI autentica no container (documentado/testado).

### Riscos
- **Autenticação do Copilot CLI no container** é o risco #1 (foi o que motivou o
  ADR-0019). Não fechar a US sem resolver isto de forma reproduzível.
- Manter o caminho host como fallback evita regressão para quem usa `aiProject`.

---

## US-PROJ6 — UI: criar Project por URL & status de clone

### Estado atual (verificado)
O board web não conhece Project. O repo-alvo é editado como texto (`aiProject`).

### Gap
Onboarding por URL, feedback de estado do clone, associação Board↔Project.

### Contrato proposto (web — `apps/web/src/features/projects/`)
- Form "Novo Project": `name` + `repoUrl` (+ auth opcional). `POST /projects`.
- Badge de `cloneState` (`pending/cloning/ready/failed`) atualizado por
  `ProjectCloneStateEvent` via `useRealtime`.
- Seletor de Project no board (associa `Board.projectId`); mantém campo
  `aiProject` como "avançado/legado".
- Segue boundaries: consome o `index.ts` público da feature; nada de importar
  internals.

### DOD verificável
- [ ] Criar Project por URL mostra progresso até `ready`.
- [ ] Erro de clone mostra `lastError` amigável.
- [ ] Associar Project ao Board persiste `projectId`.
- [ ] `npm run build && npm run lint && npm test` verdes.

---

## US-PROJ7 — Project Explorer: ver o repo clonado & **o que a AI sabe** (memória)

> **A tela de valor do épico.** Um Project não pode ser uma caixa-preta: o
> usuário precisa **ver** o repositório que foi clonado, seu estado, e —
> principalmente — **navegar pela memória-em-colmeia daquele projeto** (o que a
> AI já aprendeu). Hoje a colmeia é 100% invisível na UI (só existe via API/MCP).

### Estado atual (verificado)
- **NÃO existe UI de memória** — `apps/web/src/features/` tem board, dashboard,
  review etc., mas **nada** de memória/neurônios.
- API expõe `GET /memory/read?path=<neuronPath>` (um neurônio por vez,
  `memory.controller.ts` linha ~62) → `{ path, content, headCommit }`.
- **NÃO existe endpoint de LISTAGEM/ÍNDICE de neurônios.** A projeção
  pesquisável já está persistida em `model MemoryIndex`
  (`schema.prisma` linha ~557): `path`, `title`, `tags` (JSON), `summary`,
  `searchText`, `lockState`, `holder`, `stale`, `archivedAt`, `updatedAt`.
  Falta **expor** isso.

### Gap
1. Sem endpoint para **listar** os neurônios (o "mapa do que a AI sabe").
2. Sem tela para **explorar o clone** (metadados do repo: branch, HEAD, último
   sync, módulos detectados).
3. Sem tela para **ler um neurônio** (o markdown que a AI escreveu sobre um
   módulo) com seu estado de lock/staleness.

### Contrato proposto

**(a) API — novo endpoint de índice de memória (SÓ leitura), escopado por
Project:**

```
GET /projects/:id/memory            → lista neurônios (índice) do Project
GET /projects/:id/memory/read?path= → proxy tipado de GET /memory/read
```

Handler de listagem: `prisma.memoryIndex.findMany(...)` filtrando pelo namespace
do Project (ver §1.2 — a colmeia é namespaceada por `projectId` a partir da
US-PROJ4). Response = `MemoryNeuronSummary[]`.

> **Dependência:** o namespacing da memória por `projectId` (US-PROJ4/§1.2) é
> pré-requisito para o filtro escopado. Enquanto não existir, o endpoint pode
> listar o índice global — mas o **filtro por Project** só fica correto após
> PROJ4. Registrar isso no PR.

**(b) TS — `packages/shared/src/domain.ts`** (+ `index.ts`):

```ts
export type MemoryLockState = 'FREE' | 'EDITING' | 'REVIEW';

/** Projeção de leitura de um neurônio (espelha MemoryIndex, SEM campos internos). */
export interface MemoryNeuronSummary {
  path: string;        // ex.: 'api/cards.md'
  title: string;
  tags: string[];      // já desserializado do JSON
  summary: string;
  lockState: MemoryLockState;
  holder: string | null;
  stale: boolean;
  archivedAt: string | null;
  updatedAt: string;
}

export interface MemoryNeuronDetail extends MemoryNeuronSummary {
  content: string | null; // markdown completo (de GET /memory/read)
  headCommit: string;
}

/** Visão do repositório clonado exibida no explorer. */
export interface ProjectRepoInfo {
  defaultBranch: string | null;
  headCommit: string | null;
  lastSyncedAt: string | null;
  cloneState: ProjectCloneState;
  modules: string[]; // de detectModules(localPath) — os módulos que a AI mapeou
}
```

**(c) Web — `apps/web/src/features/projects/`** (Project Explorer):
- **Aba "Repositório":** metadados do clone (`ProjectRepoInfo`) — branch, HEAD,
  último sync, badge de `cloneState`, botão **Sync agora** (`POST /projects/:id/sync`).
- **Aba "O que a AI sabe" (Memória):** lista de `MemoryNeuronSummary` (título,
  tags, summary, badge de `lockState`, marca `stale`/arquivado). Busca client-side
  por título/tags. Clicar num neurônio abre o **markdown completo**
  (`MemoryNeuronDetail`) num painel/drawer, com o `headCommit` de origem.
- **Realtime:** reflete `ProjectCloneStateEvent` (e, se existirem, eventos de
  memória) via `useRealtime`.
- Boundaries: consome o `index.ts` público da feature; sem importar internals de
  `memory`/`board`.

### Plano PR-a-PR
- **PR-1 (API índice):** `GET /projects/:id/memory` (listagem via `MemoryIndex`,
  desserializando `tags`) + `MemoryNeuronSummary` em `shared`. `GET
  /projects/:id/memory/read` como proxy tipado.
- **PR-2 (API repo-info):** `ProjectRepoInfo` (branch/HEAD via `isomorphic-git`;
  `modules` via `detectModules(localPath)` reusando
  `memory-bootstrap.service.ts`).
- **PR-3 (Web explorer):** feature `projects/` com as duas abas + drawer de
  leitura de neurônio.

### DOD verificável
- [ ] `GET /projects/:id/memory` lista os neurônios do Project (título/tags/
      summary/lockState); `tags` chega como array (não string JSON crua).
- [ ] Abrir um neurônio mostra o markdown completo que a AI escreveu + o commit
      de origem.
- [ ] A aba "Repositório" mostra branch/HEAD/último sync e o botão Sync funciona.
- [ ] Nenhum campo interno de coordenação sensível (leaseId/activeBranch/
      baseCommit) vaza no DTO público.
- [ ] Projeto **sem** memória ainda (colmeia vazia) mostra estado vazio amigável,
      não erro.
- [ ] `npm run build && npm run lint && npm test` verdes.

### Riscos / retrocompat
- **Só-leitura no v1:** o explorer **não** edita neurônios (escrita é do domínio
  do agent/loop, EP-79/80). Evita reintroduzir coordenação de lock na UI.
- **Namespacing:** o filtro por Project depende de PROJ4; sem ele, a listagem é
  global (documentar). Não bloquear PROJ7 por isso — entregar global e apertar o
  filtro quando PROJ4 aterrissar.

---

## 3. Resumo de decisões de design (para o implementador não hesitar)

1. **`projectId` na `Board`** (raiz da cascata), não no Card. `Card.aiProject`
   permanece como override/legado.
2. **`aiProject` NÃO é removido** no v1 — é o fallback e a não-regressão.
3. **Clone feito pelo ENGINE**, nunca pelo agent (respeita invariante 8/ADR-0008).
4. **`isomorphic-git`** para https (já é dep). **ssh** atrás de flag via `git`
   do sistema, OU adiado — não bloquear o v1 por ssh.
5. **Segredos**: `credentialRef` opaca → env var do servidor; nada em claro no
   banco/DTO/log.
6. **Memória** ancorada por `projectId` (namespace) usando `localPath` como
   `repoPath`.
7. **Docker** (US-PROJ5) só depois do clone gerenciado; nasce **ADR-0038**
   (superseção parcial do 0019) na implementação — **não** nesta rodada de spec.
8. **Serialização** por `projectId` quando houver Project; por path no legado.

## 4. Ordem de merge sugerida (uma frase)

`PROJ1 (schema) → PROJ2 (clone) → PROJ3 (auth) → PROJ4 (re-plug loop/memória) →
PROJ5 (Docker + ADR-0038) → PROJ6 (UI onboarding) → PROJ7 (explorer + memory viewer)`.
