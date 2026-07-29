# ADR-0008 — Git worktree isolado por execução

**Status:** Aceito

## Contexto

Cada board/story aponta para um **repositório-alvo** onde a AI faz o trabalho.
Execuções concorrentes (ou sequenciais) não podem interferir umas nas outras nem
sujar a working tree do repo-alvo.

## Decisão

Cada execução de iteração usa um **git worktree isolado** do repo-alvo, gerenciado
pelo **`WorkspaceService`**. O `cwd` do worktree é passado ao `AgentRunner` via
`AgentRunInput.cwd`.

## Consequências

- Isolamento entre execuções; a working tree principal do repo-alvo fica intacta.
- **Em aberto (a resolver na implementação):** diretório base dos worktrees,
  política de cleanup e reaproveitamento entre iterações da mesma story. Esqueleto
  (stub) por ora.
