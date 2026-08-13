# AGENTS.md — módulo `projects`

## Propósito

Gerir a entidade **`Project`** — o repositório git **clonado & gerenciado** em
que a frota de agents trabalha (EP-PROJECT / US-PROJ1). É uma entidade
**ortogonal** à hierarquia Epic→Story→Task: associa-se ao **Board** (raiz da
cascata de repo-alvo, análoga a `defaultModel`). Ver
[`docs/specs/ep-project.md`](../../../../../docs/specs/ep-project.md).

> A US-PROJ1 entregou o **CRUD** + o model + a migração aditiva. A **US-PROJ2**
> adicionou o **clone/sync gerenciado** (`ProjectWorkspaceService`): transições
> de `cloneState` (`pending → cloning → ready|failed`), `localPath` populado e o
> evento WS `project.clone_state`.

## Estrutura

```
projects/
├── projects.schema.ts             # schema Zod (validação de entrada) + tipos
├── projects.service.ts            # regras + acesso via PrismaService + toDto público
├── project-workspace.service.ts   # US-PROJ2: clone/sync/remove gerenciado (isomorphic-git) + wiring auth US-PROJ3
├── project-workspace.service.spec.ts
├── project-workspace-auth.service.spec.ts  # US-PROJ3: wiring onAuth/ssh no clone
├── project-credentials.service.ts # US-PROJ3: resolve credencial git (token de env var) + gate ssh
├── project-credentials.service.spec.ts
├── project-explorer.service.ts    # US-PROJ7: leitura read-only do repo clonado + memória (hive)
├── project-explorer.service.spec.ts
├── projects.controller.ts
└── projects.module.ts
```

## Rotas

- `GET /projects` — lista (DTO público).
- `GET /projects/:id` — um Project (DTO público).
- `POST /projects` — cria com `cloneState='pending'`. Valida `repoUrl` (https/ssh).
  Dispara `ProjectWorkspaceService.ensureCloned` de forma **assíncrona**
  (fire-and-forget) — a resposta HTTP NÃO bloqueia no clone; o estado é
  observável via o evento WS `project.clone_state` e por `GET /projects/:id`.
- `POST /projects/:id/sync` — US-PROJ2: `fetch` + checkout/fast-forward para a
  branch default; atualiza `lastSyncedAt`. Retorna o DTO atualizado.
- `DELETE /projects/:id` — remove a linha e o **diretório gerenciado** do clone
  (`ProjectWorkspaceService.remove`, best-effort).
- `GET /projects/:id/repo-info` — US-PROJ7: `ProjectRepoInfo` read-only
  (`cloneState`/`lastSyncedAt` da row + `defaultBranch`/`headCommit` via
  isomorphic-git no `localPath` + `modules` via `detectModules`). Trata
  "ainda não clonado" → nulls + `modules: []`.
- `GET /projects/:id/memory` — US-PROJ7: `MemoryNeuronSummary[]` do índice de
  memória (hive). **Global-first**: `MemoryIndex` ainda não tem `projectId`; o
  filtro por projeto aperta quando US-PROJ4 aterrissar. NUNCA projeta campos de
  coordenação interna (`leaseId`/`activeBranch`/`baseCommit`/`searchText`), só os
  campos do summary. `tags` é desserializado de JSON string → `string[]`.
- `GET /projects/:id/memory/read?path=` — US-PROJ7: `MemoryNeuronDetail` (summary
  + `content` + `headCommit`), proxy tipado sobre `MemoryGitService.readNeuron`.

## `ProjectWorkspaceService` (US-PROJ2)

- **@Injectable**, exportado pelo `ProjectsModule` (consumo futuro por PROJ4).
  Injeta `PrismaService`, `APP_CONFIG` e `RealtimeService`.
- `ensureCloned(projectId): Promise<string>` — resolve o Project, computa
  `localPath = <PROJECTS_DIR>/<projectId>`, transiciona `cloning` (emite evento),
  clona `repoUrl` via **isomorphic-git** (`git.clone` + `isomorphic-git/http/node`),
  e em sucesso grava `ready`/`localPath`/`lastSyncedAt` (emite `ready`); em falha
  grava `failed` + `lastError` **legível** (1 linha, sem stacktrace) e emite
  `failed`. Retorna `localPath`.
- `sync(projectId): Promise<void>` — `fetch` + `checkout` (force) na branch
  default; atualiza `lastSyncedAt`. Se ainda não houver clone, cai em `ensureCloned`.
- `remove(projectId): Promise<void>` — `fs.rm` recursivo do diretório gerenciado
  (idempotente). Nunca remove nada fora de `PROJECTS_DIR`.
- **Guard-rails:** `isInsideSelfRepo` recusa qualquer `localPath` DENTRO do repo
  do kanban-ai; `PROJECTS_DIR` (config `projects.dir`, env `PROJECTS_DIR`,
  resolvido absoluto) é criado se ausente (`fs.mkdir recursive`).
- **Concorrência:** um lock in-process (`Map<projectId, Promise>`) faz
  **coalescing** de `ensureCloned` concorrentes do MESMO projectId (SEM Redis —
  invariante 7).
- **onAuth (US-PROJ3):** ponto de extensão `setAuthHook(hook)` repassado ao
  `onAuth` do isomorphic-git. **Implementado** via `ProjectCredentialsService`
  (injetado, `@Optional`): para `authKind='https'` o token vem de uma **env var**
  referenciada por `credentialRef` (ver `ProjectCredentialsService`). `setAuthHook`
  ainda existe e tem **precedência** (override manual/testes). `authKind='ssh'` é
  delegado ao `git` do sistema (`systemGitClone`/`systemGitFetch`) e **gated** por
  `PROJECTS_ALLOW_SSH`.
- **Config** (`config.projects`, env): `PROJECTS_DIR` (default
  `./.kanban-ai-projects`, resolvido absoluto), `PROJECTS_GIT_TIMEOUT_MS`
  (default `300000`), `PROJECTS_ALLOW_SSH` (default `false`, US-PROJ3).

## `ProjectCredentialsService` (US-PROJ3)

- **@Injectable**, exportado pelo `ProjectsModule`. Injeta `APP_CONFIG`.
- `credentialRef` é uma **referência OPACA ao NOME de uma env var do servidor**
  (ex.: `credentialRef='GH_TOKEN_ACME'` → segredo = `process.env.GH_TOKEN_ACME`).
  **ZERO segredo no banco/DTO/log.** Aceita o prefixo opcional `env:`.
- `resolveHttpAuth(project)` — `authKind='none'` → `null`; `authKind='https'` →
  `{ username: 'x-access-token', password: <token da env> }`. Env var ausente →
  erro **legível** citando só o NOME da env var (nunca o valor; não revela outras).
- `buildHttpAuthHook(project)` — devolve o callback `onAuth` (ou `null`).
- `assertSshAllowed(project)` — lança erro claro se `authKind='ssh'` e
  `PROJECTS_ALLOW_SSH` estiver off. **O serviço NUNCA loga o token.**

## Evento WS (US-PROJ2)

- `ProjectCloneStateEvent` (`packages/shared/src/events.ts`, membro da união
  `ServerEvent`): `{ type: 'project.clone_state'; projectId; state; error? }`.
  Emitido via `RealtimeService.broadcast` a cada transição de `cloneState`;
  `error` só presente em `failed` (mensagem legível).

## Invariantes (NUNCA violar)

1. **DTO público** (`toDto`) NUNCA expõe `credentialRef` (segredo, US-PROJ3) nem
   `localPath` (layout do FS do servidor). Segredos ficam como referência opaca.
2. **`Card.aiProject` permanece** como fallback legado — não removido no v1.
   `Board.projectId` é a nova raiz da cascata; Board sem `projectId` cai no path.
3. Migração é **aditiva** (colunas novas nullable / com default) — zero regressão.
4. `Project` é ortogonal à hierarquia Epic→Story→Task — não entra nos cards.
5. O clone gerenciado **NUNCA** aterrissa dentro do repo do kanban-ai
   (`isInsideSelfRepo`), e o `PROJECTS_DIR` é sempre absoluto.

## Contratos

- Entrada validada por **Zod** (`projects.schema.ts`) via `ZodValidationPipe`.
- DTO de leitura vem de `@kanban-ai/shared` (`Project`, `ProjectAuthKind`,
  `ProjectCloneState`, `CreateProjectInput`) — **não** duplicar.
- **Git = isomorphic-git** (a MESMA lib da memória). NÃO adicionar
  simple-git/nodegit.

## Como testar

- `npm test` (node:test) — `projects.service.spec.ts` cobre: POST cria `pending`;
  DTO não vaza `credentialRef`/`localPath`; validação de `repoUrl`.
  `project-workspace.service.spec.ts` cobre US-PROJ2: `ensureCloned` de um repo
  servido via HTTP local (`git-http-backend`) → `ready` + `localPath` + git log;
  URL inválida → `failed` + `lastError` legível; guard-rail recusa path dentro do
  kanban-ai; coalescing de `ensureCloned` concorrentes. NOTA: isomorphic-git só
  suporta transporte http/https (não `file://`); por isso o teste de clone real
  sobe um servidor smart-HTTP local (determinístico, offline) — um smoke manual
  contra um repo público https real (octocat/Hello-World) foi feito à parte.
