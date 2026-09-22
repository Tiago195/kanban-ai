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
├── project-graph.service.ts       # US-F1.3: build do grafo de conhecimento (graphify) por Project
├── project-graph.service.spec.ts
├── project-graph-query.service.ts # US-F1.4: cliente MCP de LEITURA do grafo (tools tipadas, project_path por construção)
├── project-graph-query.service.spec.ts
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
- `DELETE /projects/:id` — remove a linha, o **diretório gerenciado** do clone
  (`ProjectWorkspaceService.remove`, best-effort) e o **diretório do grafo** no
  volume do sidecar (`ProjectGraphService.remove` → `POST /remove` do wrapper,
  best-effort — US-F1.3).
- `GET /projects/:id/repo-info` — US-PROJ7: `ProjectRepoInfo` read-only
  (`cloneState`/`lastSyncedAt` da row + `defaultBranch`/`headCommit` via
  isomorphic-git no `localPath` + `modules` via `detectModules`). Trata
  "ainda não clonado" → nulls + `modules: []`.
- `GET /projects/:id/memory` — US-PROJ7/F2.3: `MemoryNeuronSummary[]` lido da
  colmeia do clone (`<clone>/.hive/**.md`, via `ProjectHiveService`) —
  per-Project por construção. US-F5.1: o neurônio é o memory doc CANÔNICO do
  graphify — título = `question`, tag = `type`, `updatedAt` = `date` (markdown
  sem frontmatter cai na heurística de corpo/linha `tags:` inline); sem campos
  de coordenação (morreram na US-F2.3).
- `GET /projects/:id/memory/read?path=` — US-PROJ7/F2.3: `MemoryNeuronDetail`
  (summary + `content`) de `<clone>/.hive/<path>` (trust boundary no path);
  inexistente → 404.
- `GET /projects/:id/graph` — US-F4.1: `GraphProjectionResponse` — projeção do
  grafo de conhecimento com o **corte no servidor** (rota `POST /projection` do
  wrapper do sidecar, que lê o `graph.json` estruturado — sem regex sobre texto
  MCP). Params: `focus` (BFS por nó, `depth` 1..3), `community`, `search`
  (typeahead, sem arestas), `limit` (1..500, default 150; arestas ≤ 4×limit).
  Project inexistente → 404; grafo não-`ready`/sidecar fora →
  `{ok:false, graphState, error}` tipado (falha visível, nunca 500 opaco).

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

## `ProjectGraphService` (US-F1.3)

- Cliente do **wrapper HTTP de build** do sidecar graphify
  (`docker/graphify_build_server.py`, US-F1.6/ADR-0041). Quando o clone fica
  `ready`, o `ProjectWorkspaceService` dispara `build()` em background
  (fire-and-forget): `POST /build` síncrono → ciclo refletido em
  `Project.graphState` (`building → ready|failed`), com `graphBuiltAt` ou
  `graphLastError` e evento WS `project.graph_state`.
- **Defensivo**: `build()` NUNCA lança (falha de grafo jamais derruba o fluxo de
  Project); sem `GRAPHIFY_API_KEY` a integração fica desligada (skip,
  `graphState` permanece `pending`); Project deletado DURANTE o build (~18s) →
  nada é gravado/emitido e o grafo órfão recém-escrito é removido
  (`POST /remove`).
- **Config** (`config.graphify`, env): `GRAPHIFY_BUILD_PORT` (default 8130,
  bind fixo 127.0.0.1), `GRAPHIFY_API_KEY` (a MESMA do sidecar; vazia =
  desligado), `GRAPHIFY_BUILD_TIMEOUT_MS` (default 1830000 — MAIOR que o
  timeout do sidecar).
- **ARMADILHA de DI**: parâmetro opcional tipado `X | null` faz o TS emitir
  `Object` no `design:paramtypes` e o Nest injeta `undefined` em silêncio. Use
  `@Optional() param?: X` (sem união) — foi assim que o `graph` entrou no
  `ProjectWorkspaceService`.
- **US-F1.5 — rebuild incremental pós-iteração** (`rebuildFromIteration`):
  disparado pelo orchestrator (fire-and-forget) quando uma iteração do loop
  altera arquivos do repo-alvo. NUNCA entra no caminho crítico da iteração:
  coalescing por Project (rajada de N pedidos = 1 build, união dos arquivos,
  debounce de 500ms + acúmulo enquanto um build está em voo), contador por
  Project que a cada `GRAPHIFY_INCREMENTAL_FORCE_EVERY` (default 10) builds
  dispara um COMPLETO com `force: true` (o incremental é lossy), e skip quando
  `graphState != ready`. Lista de arquivos via
  `git diff --name-only -z --no-renames` (deletado = path na lista; rename =
  delete+add; espaço sai literal). Desligado por default
  (`GRAPHIFY_INCREMENTAL_REBUILD`). Specs: `project-graph-rebuild.spec.ts`.

## `ProjectGraphQueryService` (US-F1.4)

- Cliente **MCP Streamable HTTP** de LEITURA do grafo no sidecar
  (`http://127.0.0.1:<GRAPHIFY_MCP_PORT>/mcp`, ADR-0041). Expõe as tools de
  leitura como métodos tipados: `queryGraph`, `getNode`, `getNeighbors`,
  `getCommunity`, `godNodes`, `graphStats`, `shortestPath` — TODOS exigem
  `projectId`, do qual o `project_path`
  (`/home/graphify/.graphify/projects/<projectId>`) é derivado internamente:
  **isolamento entre Projects por construção**, nunca por disciplina do
  chamador.
- **Best-effort**: nenhum método lança — retorno `{ ok:true, text }` |
  `{ ok:false, error }`. Cobre sidecar fora do ar, grafo inexistente
  (`graphState != ready` — o serve responde erro como CONTEÚDO de tool) e
  integração desligada (sem `GRAPHIFY_API_KEY`). Sessão MCP expirada/sidecar
  reiniciado → re-handshake + UMA nova tentativa.
- `token_budget` exposto em todas as tools que o aceitam; default
  `DEFAULT_GRAPH_TOKEN_BUDGET = 2000` tokens (o default do próprio graphify;
  substitui o corte fixo de 4000 chars do recall antigo).
- **Config** (`config.graphify`): `mcpUrl` (de `GRAPHIFY_MCP_PORT`, default
  8129) e `queryTimeoutMs` (`GRAPHIFY_QUERY_TIMEOUT_MS`, default 15000).
- Exportado pelo módulo para os consumidores de contexto de grafo (EP-F2 —
  o `buildContext` do orchestrator segue no recall antigo até lá).

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
- `ProjectGraphStateEvent` (US-F1.3, mesmo padrão):
  `{ type: 'project.graph_state'; projectId; state; error? }` a cada transição
  de `graphState`.

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
