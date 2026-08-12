# AGENTS.md — módulo `memory`

## Propósito

Armazenamento da **memória** (ADR-0027, **Camada 1 — git como fonte da verdade**).
Provisiona e mantém um **bare git repository** num **volume dedicado do serviço**
(`config.memory.gitDir`), FORA do repo-alvo, com **ciclo de vida independente** —
não é clone nem convive com a working tree do projeto. Usa **isomorphic-git** (git
em JS puro, sem binário nativo) rodando dentro da API Node.

## Estrutura

```
memory/
├── memory-git.service.ts        # Camada 1: init/open + read/write/merge/diff/history
├── memory-git.service.spec.ts   # Testes Camada 1 (node:test) em tmpdir isolado
├── memory-index.service.ts      # Camada 2: indice Postgres derivado (reindex/rebuild/query)
├── memory-index.service.spec.ts # Testes Camada 2 (git real em tmpdir + prisma fake)
├── memory-lock.service.ts       # EP-78: locks advisory + presenca (lease/TTL/heartbeat)
├── memory-lock.service.spec.ts  # Testes EP-78 (git real + prisma fake in-memory)
├── memory-write.service.ts      # EP-79: escrita otimista + compare-and-swap (CAS)
├── memory-write.service.spec.ts # Testes EP-79 (git real + prisma fake in-memory)
├── memory-review.service.ts     # EP-80: REVIEW + arbitragem (enterReview/resolve)
├── memory-review.service.spec.ts# Testes EP-80 (git real + prisma fake in-memory)
├── memory-events.service.ts     # EP-81: fachada de broadcast tipado dos eventos memory.*
├── memory-events.service.spec.ts# Testes EP-81 (spy sobre RealtimeService)
├── memory.controller.ts         # EP-82: control plane REST /memory/* (consumido pelo MCP)
├── memory.schema.ts             # EP-82: schemas zod da borda HTTP
└── memory.module.ts             # @Global (controller + seis servicos)
```

## Contrato (Camada 1)

- `MemoryGitService` é **@Injectable** e **@Global** (via `MemoryModule`): qualquer
  módulo injeta sem reimportar.
- Público:
  - `provision(): Promise<void>` — garante o bare repo provisionado de forma
    **idempotente** (init `--bare` se o volume estiver vazio; abre + valida `HEAD`
    se já houver repo). Chamado no boot via `onModuleInit()`.
  - `readNeuron(path, ref?)`, `writeNeuron({...})`, `mergeSessionBranch({...})`,
    `diffNeuron({...})`, `historyNeuron(path, ref?)` — read/write/merge/diff/
    history de neurônios (ver "Estado atual").
  - `resolveHead(ref?)`, `listNeurons(ref?)` — SHA do `main` e paths de todos os
    neurônios integrados (base do índice da Camada 2).
  - `get gitDir(): string` — caminho do bare repo (lido de `config.memory.gitDir`).
  - `MEMORY_DEFAULT_BRANCH` (`'main'`) — branch inicial garantida.

### Contrato (Camada 2 — índice Postgres derivado)

- `MemoryIndexService` é **@Injectable** e **@Global** (via `MemoryModule`).
- O índice (`model MemoryIndex`) é uma **PROJEÇÃO DERIVADA e DESCARTÁVEL** dos
  neurônios `.md` do git; o git é a **fonte da verdade** e o índice pode ser
  reconstruído do zero (`rebuildAll`) sem perda.
- **Ordem de escrita invariante:** **git commit → reindexa → (emite WS)**.
  `commitAndReindex` encapsula os dois primeiros passos: o índice **nunca**
  reflete um estado que ainda não existe no git.
- Público:
  - `commitAndReindex({path, content, sessionId, message})` (US-163) — escreve no
    git (branch da sessão + merge em `main`) e só então projeta no índice; em
    conflito de merge lança `MemoryWriteConflictError` sem tocar o índice.
  - `reindexOne(path)` (US-160) — reprojeta UM neurônio (idempotente); remove a
    projeção e retorna `null` se o neurônio não existir mais no git.
  - `rebuildAll()` (US-161) — reconstrói o índice inteiro a partir do git.
  - `query(term?, limit?)` (US-162) — retrieval case-insensitive por
    title/summary/searchText/path.

### Contrato (EP-78 — locks advisory + presença)

- `MemoryLockService` é **@Injectable** e **@Global** (via `MemoryModule`).
- O lock é **advisory** (coordenação social — "estou editando isto agora"),
  **não** um portão de escrita: o que protege contra _lost-update_ é o
  compare-and-swap do write (EP-79). O lease é projetado nos campos de
  coordenação do `MemoryIndex` (`lockState`, `holder`, `leaseId`, `expiresAt`).
- Público:
  - `acquire(path, holder, ttlMs?)` (US-192) — `FREE → EDITING`; devolve
    `{ baseCommit, leaseId, expiresAt }`. Idempotente para o mesmo holder;
    lança `MemoryLockHeldError` se outro holder tem lease ativo; lease vencido é
    sobrescrito (auto-release lazy).
  - `heartbeat(path, holder, ttlMs?)` (US-193) — renova `expiresAt`; só o holder;
    lança `MemoryLeaseExpiredError` (e libera) se o lease já venceu.
  - `release(path, holder)` (US-194) — `EDITING → FREE` explícito (idempotente).
  - `expireStale(nowMs?)` (US-193) — auto-release em lote dos leases vencidos.
  - `acquireMany(paths, holder, ttlMs?)` (US-195) — ordena os paths (evita
    hold-and-wait circular) e faz rollback total se algum estiver preso
    (nunca deixa aquisição parcial → anti-deadlock).
- Config via `MEMORY_GIT_DIR` (default `./.kanban-ai-memory/git`, **gitignored** —
  é volume de runtime, nunca versionado no repo-alvo).

### Contrato (EP-79 — escrita otimista + compare-and-swap)

- `MemoryWriteService` é **@Injectable** e **@Global** (via `MemoryModule`).
- É a peça que impede _lost-update_ com N agents escrevendo em paralelo. O
  modelo é **otimista**: o holder leu um `baseCommit` no `acquire` (EP-78),
  materializa a proposta num ramo efêmero por agent e só integra no fechamento.
- **Ordem de escrita invariante preservada:** git commit/merge → reindexa (via
  `MemoryIndexService.reindexOne`) → (emitir WS é EP-81, fora daqui).
- Público:
  - `writeOptimistic({path, content, sessionId, message})` (US-196) — materializa
    a proposta APENAS no ramo `mem/ai/<sessao>/<path>`, **sem tocar `main`**.
  - `commit({path, content, sessionId, baseCommit, message, maxRetries?})`
    (US-197/198/199) — fecha a edição com **compare-and-swap** anti-stale:
    - se o HEAD efetivo do path (o `headCommit` projetado no índice, ou o HEAD de
      `main` quando o neurônio é novo) divergir do `baseCommit`, faz **rebase
      inline** (adota o novo base e reescreve) e integra na MESMA iteração;
    - integra o ramo efêmero em `main` via **merge 3-way** (`mergeSessionBranch`);
    - em stale persistente, o laço reread→rebase→write esgota em
      `MEMORY_WRITE_MAX_RETRIES` (default 3) e lança `MemoryStaleWriteError`
      (`reason: 'stale'`);
    - um **conflito de merge REAL** (não apenas stale) NÃO é resolvido aqui — é
      sinalizado como `MemoryStaleWriteError` (`reason: 'conflict'`) e delegado
      ao árbitro/REVIEW (EP-80).
  - `WriteResult` expõe `{ oid, branch, headCommit, projection, retries }`
    (`retries` = nº de iterações completas do laço; 0 quando o rebase é inline).

### Contrato (EP-80 — REVIEW + arbitragem de conflitos)

- `MemoryReviewService` é **@Injectable** e **@Global** (via `MemoryModule`).
- É o desfecho de uma proposta que NÃO pôde ser integrada sozinha: o write/lock
  sinaliza colisão e transiciona o neurônio para `REVIEW` (ADR-0027 §"Resolução
  de conflito semântico"). Dois gatilhos de EDITING→REVIEW:
  `'semantic-conflict'` (colisão de merge no mesmo trecho) e `'out-of-scope'`
  (proposta fora do escopo do autor).
- Público:
  - `enterReview({path, reason, sessionId, holder, baseCommit?})` (US-200/201/202)
    — transiciona `EDITING → REVIEW` (`lockState=REVIEW`, `reviewQueued=true`),
    **preserva o `headCommit` estável** e, quando `reason='semantic-conflict'`,
    monta o `MemoryConflict` (`base`/`ours`/`theirs`) lendo os dois lados: `ours`
    = HEAD estável do path; `theirs` = ponta do ramo efêmero
    `mem/ai/<sessao>/<path>`. Em `'out-of-scope'` o `conflict` fica ausente.
    Retorna `MemoryReviewItem`.
  - `buildConflict(...)` (US-202) — lê `ours`/`theirs` e devolve o `MemoryConflict`.
  - `resolve({path, baseCommit, content?, arbiter?})` (US-203) — fecha o `REVIEW`
    com **compare-and-swap anti-stale** (se `baseCommit` não casar nem com
    `row.baseCommit` nem com o HEAD estável → `MemoryReviewStaleError`) e dois
    desfechos, ambos `REVIEW → FREE` + **poda do ramo efêmero**:
    - **aceitar** (`content` presente): commita a mutação arbitrada em `main` via
      `MemoryIndexService.commitAndReindex` (segue a ordem canônica) → o HEAD
      avança; `ResolveResponse.headCommit` é o novo SHA;
    - **descartar** (sem `content`): mantém o HEAD estável; `headCommit`
      permanece inalterado.
  - Se o neurônio não estiver em `REVIEW` → `MemoryNotInReviewError`.
- **Fora de escopo aqui:** a **política** de quem PODE arbitrar
  (autoridade/escopo) vive fora deste serviço — aqui só o mecanismo.

### Contrato (EP-81 — broadcast dos eventos `memory.*` no WS)

- `MemoryEventsService` é **@Injectable** e **@Global** (via `MemoryModule`):
  uma **fachada tipada** sobre `RealtimeService.broadcast(...)`. Isola a emissão
  do gateway → os serviços de domínio dependem só desta fachada, e os specs
  injetam um `RealtimeService` no-op sem subir o gateway.
- Público (um método por evento da união `ServerEvent`, ver
  `packages/shared/src/events.ts`):
  - `locked(path, headCommit, owner)` → `memory.locked`;
  - `released(path, headCommit, owner)` → `memory.released`;
  - `updated(path, headCommit, agentId)` → `memory.updated`;
  - `conflict(conflict)` → `memory.conflict`;
  - `review(item)` → `memory.review`.
- **Pontos de emissão** (o emit é o **3º passo** da ordem canônica git → índice → WS):
  - `MemoryLockService.acquire` → `locked`; `toFree` (release/expire) → `released`;
  - `MemoryWriteService.commit` (sucesso) → `updated` (`agentId = ai:<sessionId>`);
  - `MemoryReviewService.enterReview` → `conflict` (só em `semantic-conflict`) + `review`;
    `resolve` aceitar → `updated` + `released`; descartar → `released`.
- **Lado cliente (US-206):** `useRealtime` reage aos `memory.*` invalidando a
  query key `queryKeys.memory(path?)`. Os handlers ficam **antes** do guard
  `if (!boardId) return;` porque a memória é **global** (não pertence a um board).

### Contrato (EP-82 — control plane REST `/memory/*` consumido pelo MCP)

- `MemoryController` (`@Controller('memory')`) expõe o **segundo plano de
  controle** (ADR-0020): o canal pelo qual os agents autônomos leem/escrevem a
  colmeia via MCP. É uma **ponte fina** — zero regra de negócio; só valida a
  borda (zod, `memory.schema.ts`) e delega aos serviços.
- Rotas:
  - `GET /memory/read?path=` (US-207) → `{path, content, headCommit}`. Leitura
    **global**; `headCommit` = projeção do índice se houver, senão `resolveHead()`
    — é o `baseCommit` a repassar num `write` (mesma âncora do CAS).
  - `POST /memory/write` (US-207) → delega a `MemoryWriteService.commit` (CAS
    EP-79). Exige `baseCommit`.
  - `POST /memory/acquire` (US-208) → `MemoryLockService.acquire`, retorna
    `{baseCommit, leaseId, expiresAt}`.
  - `POST /memory/heartbeat` (US-208) → renova TTL, retorna `{expiresAt}`.
  - `POST /memory/release` (US-208) → `MemoryLockService.release` (dispara merge).
  - `POST /memory/resolve` (US-209) → `MemoryReviewService.resolve` (arbitragem
    EP-80; sem `content` = descartar, com `content` = aceitar).
- **Lado MCP:** `apps/mcp/src/tools/memory.ts` expõe uma tool por rota
  (`memory_read/write/acquire/heartbeat/release/resolve`). Os erros 4xx/5xx viram
  texto acionável (`mapping.ts`). O MCP não fala com Postgres — só chama estas rotas.

1. **Idempotência total** — rodar `provision()` N vezes converge para o MESMO
   estado (bare repo com branch `main` materializada). O commit de bootstrap é
   **vazio e determinístico** (autoria/timestamp fixos → SHA reproduzível); nunca
   recommita numa reabertura.
2. **Volume dedicado, fora do repo-alvo** — o `gitDir` é armazenamento próprio do
   serviço; jamais criar/versionar esse diretório dentro do kanban-ai.
3. **HEAD válido / branch `main` garantida** — após `provision()`, `HEAD` **resolve**
   para `refs/heads/main` (nunca "unborn"): num volume vazio um **commit de bootstrap
   vazio e determinístico** materializa `main`, dando base para read/commit/merge.
   Se o repo existente apontar para uma branch diferente de `main`, `provision()`
   **falha cedo** com mensagem acionável citando `MEMORY_GIT_DIR`.

## Fora de escopo (NÃO implementar aqui ainda)

- **Resolução de conflito** de merge — o **mecanismo** (transição para `REVIEW`,
  montagem do `MemoryConflict`, arbitragem via `MemoryReviewService.resolve`) já
  vive aqui (EP-80) e sua **emissão** no WS já vive aqui (EP-81). O que segue
  fora: a **política** de quem PODE arbitrar.
- **Agendamento** do `expireStale` (tick periódico) — o método existe; quem o
  chama periodicamente vive fora (infra/EP-85).

## O que NÃO mexer

- Não misturar orquestração/loop engine aqui: este módulo só versiona conteúdo.
- Não usar o `gitDir` **default** em testes/smoke — sempre um `fs.mkdtempSync`
  isolado (usar o default cria o bare repo dentro do repo-alvo e polui o `git diff`).

## Como testar

- `npm run test -w @kanban-ai/api` roda `memory-git.service.spec.ts` (node:test +
  node:assert/strict). Cada caso instancia `MemoryGitService` com um config fake
  `{ memory: { gitDir } }` apontando para um **tmpdir isolado** e faz cleanup com
  `fs.rmSync(..., { recursive: true, force: true })` no final. Cobre: init em
  volume vazio (branch `main` + 1 commit de bootstrap), reabertura idempotente
  (mesmo HEAD/1 commit), validação de `HEAD`/branch `main`, **determinismo do
  commit de bootstrap** (SHA idêntico entre inits independentes) e o **caminho de
  erro** (HEAD divergente falha com mensagem citando `MEMORY_GIT_DIR`).

## Estado atual

Camada 1 **completa** (US-135..141):

- **US-135** provisionamento: init/open idempotente + branch `main` garantida por
  commit de bootstrap vazio determinístico (`provision()`, `onModuleInit()`).
- **US-136** `readNeuron(path, ref?)` — lê o blob por path em `main`/SHA (null se
  ausente).
- **US-137** `writeNeuron({ path, content, sessionId, message, author? })` —
  grava numa branch efêmera por sessão+path `mem/ai/<sessao>/<path>` (escrita
  otimista; repo bare: writeBlob→writeTree→commit→ref).
- **US-138** `mergeSessionBranch({ sessionId, path, author? })` — merge 3-way
  branch→`main`; em conflito NÃO escreve em `main` e retorna `conflict: true`.
- **US-139** `diffNeuron({ path, from, to? })` — status added/modified/deleted/
  unchanged + conteúdo before/after.
- **US-140** `historyNeuron(path, ref?)` — commits que tocaram o path (git log
  `-- <path>`), do mais recente ao mais antigo.
- **US-141** tudo exposto pelo `MemoryModule` (@Global); build/lint/test verdes.

Todos os métodos são cobertos por testes em tmpdir isolado. Fonte:
[ADR-0027](../../../../../docs/adr/0027-memory-as-a-living-service.md),
seção "Camada 1 — git como fonte da verdade".
