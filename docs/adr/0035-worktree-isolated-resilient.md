# ADR-0035 — Worktree isolado resiliente por execução (atrás de flag)

**Status:** Aceito

## Contexto

O [ADR-0008](0008-git-worktree-per-execution.md) decidiu que cada execução usa um
**git worktree isolado** do repo-alvo, mas deixou **em aberto** três pontos que a
implementação precisava resolver: (1) o diretório base dos worktrees, (2) a
política de cleanup e (3) o reaproveitamento entre iterações da mesma story.

Na prática, o `WorkspaceService` do loop
(`apps/api/src/modules/ai-engine/workspaces/workspace.service.ts`) **ainda não
criava worktree algum**: `resolveWorkdir` retornava o **próprio caminho do
repo-alvo**, e `cleanupWorktree` apenas descartava o tracking em memória. Ou seja,
o agent trabalhava diretamente na working tree do repo-alvo — exatamente o que o
ADR-0008 queria evitar — sujando o repositório e impedindo concorrência segura.

Restrições que continuam valendo:

- **O agent NÃO executa git** — todo git é do engine (ADR-0008).
- **A API roda no host** e o `cwd` do spawn é um caminho arbitrário do FS do
  usuário; caminhos precisam ser **absolutos** e validados por `isInsideSelfRepo`
  ([ADR-0019](0019-api-runs-on-host-not-docker.md)).
- `AGENT_SERIALIZE_BY_REPO` continua sendo a rede de segurança contra concorrência
  no mesmo repo-alvo.
- Sem Redis; sem DOR/acceptance.

## Decisão

Resolver os pontos em aberto do ADR-0008 implementando o worktree isolado real no
`WorkspaceService`, **atrás de uma flag** `worktreeIsolated`
(`AGENT_WORKTREE_ISOLATED`, **default `false`**). Com a flag desligada o
comportamento é **idêntico ao de hoje** (retorna o caminho do repo-alvo), o que
mantém a mudança 100% retrocompatível.

Com `worktreeIsolated=true`:

1. **Criação** — `resolveWorkdir(key, targetRepoPath?)` cria uma branch de
   execução `kanban-ai/<safeKey>` e um worktree isolado em
   `<workspacesDir>/<safeKey>` via `git worktree add -B <branch> <path> HEAD`, e
   retorna o **caminho do worktree**. Reaproveita o worktree existente para a mesma
   `key` entre iterações. As guard-rails do ADR-0008/0019 são preservadas:
   `isInsideSelfRepo`, validação de repo git e `ensureInitialCommit` (repo com HEAD
   não-nascido recebe commit inicial). Diretório base = `config.agent.workspacesDir`.
2. **Cleanup** — `cleanupWorktree(key)` roda `git worktree remove --force`
   **apenas** para worktrees isolados que ele criou, seguido de `git worktree
   prune`. **Nunca** age contra o repo-alvo diretamente. Com a flag desligada,
   mantém o comportamento atual (só descarta tracking em memória).
3. **Espelhamento de ignorados** (`worktreeMirrorIgnored`, default `true`) —
   materializa caminhos ignorados pesados de topo (ex.: `node_modules`) por
   **symlink** (barato) lendo `.gitignore`/`git check-ignore`, para o worktree ter
   dependências sem cópia.
4. **Submódulos** (`worktreeInitSubmodules`, default `true`) — roda `git submodule
   update --init --recursive` no worktree (best-effort; no-op seguro sem
   submódulos).
5. **Preservação de patch** (`worktreePreservePatch`, default `true`) — no
   trash/restart captura o patch não-commitado (`git add -A -N` + `git diff HEAD`)
   e o reaplica (`git apply`) ao recriar o worktree, para que trabalho em progresso
   sobreviva a reinícios.

As **assinaturas públicas** `resolveWorkdir(key, targetRepoPath?)` e
`cleanupWorktree(key)` **não mudam** — só o comportamento interno atrás da flag. As
decisões de mirror/submódulo/patch são expostas também como **funções puras**
(`resolveWorktreePolicy`, `shouldMirrorIgnoredPath`, `executionBranchName`)
testáveis isoladamente.

## Consequências

- Isolamento real entre execuções concorrentes/sequenciais; a working tree do
  repo-alvo fica intacta.
- Rollout seguro e reversível: a flag default `false` mantém produção no
  comportamento atual até habilitação explícita.
- Custo de disco reduzido pelo symlink de `node_modules` em vez de cópia.
- Resiliência: patch em progresso sobrevive a restart do worktree.
- Novas flags de configuração (`AGENT_WORKTREE_*`) documentadas em `.env.example`.
- **Refina o ADR-0008**, fechando os três pontos que ele deixou em aberto
  (base dir = `workspacesDir`, cleanup via `worktree remove --force` só do isolado,
  reaproveitamento por `key`).
