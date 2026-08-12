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
├── memory-git.service.ts       # MemoryGitService: init/open idempotente do bare repo
├── memory-git.service.spec.ts  # Testes (node:test + node:assert) em tmpdir isolado
└── memory.module.ts            # @Global
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
  - `get gitDir(): string` — caminho do bare repo (lido de `config.memory.gitDir`).
  - `MEMORY_DEFAULT_BRANCH` (`'main'`) — branch inicial garantida.
- Config via `MEMORY_GIT_DIR` (default `./.kanban-ai-memory/git`, **gitignored** —
  é volume de runtime, nunca versionado no repo-alvo).

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

## Fora de escopo (Camada 1 — NÃO implementar aqui)

- **Locks, WebSocket e índice** — são **Camada 2**, NÃO vivem neste módulo.
- **Resolução de conflito** de merge (árbitro/REVIEW) — o serviço apenas
  **sinaliza** o conflito (`mergeSessionBranch` → `conflict: true`); resolver é
  Camada 2 (EP-80).

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
