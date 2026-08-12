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
└── memory.module.ts             # @Global (exporta os quatro servicos)
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

## Invariantes

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

- **WebSocket** (EP-81) — o 3º passo da ordem de escrita (emitir evento) NÃO vive
  aqui; `commitAndReindex`/`commit` param na reindexação; nada emite `memory.*`.
- **Resolução de conflito** de merge (árbitro/REVIEW) — as Camadas 1/2 e o write
  apenas **sinalizam** (`mergeSessionBranch` → `conflict: true`;
  `MemoryWriteConflictError`; `MemoryStaleWriteError` com `reason: 'conflict'`);
  resolver é EP-80.
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
