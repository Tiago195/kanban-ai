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

- **Read/write** de conteúdo por path+commit.
- Branches `mem/ai/<sessao>/<path>`, **merge 3-way** branch→main, **diff**, **blame**
  (chegam em iterações/stories seguintes do épico da Camada 1).
- **Locks, WebSocket e índice** — são **Camada 2**, NÃO vivem neste módulo.

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

Camada 1 **provisionamento concluído**: init/open idempotente + branch `main`
garantida por commit de bootstrap vazio determinístico. Fonte:
[ADR-0027](../../../../../docs/adr/0027-memory-as-a-living-service.md),
seção "Camada 1 — git como fonte da verdade".
