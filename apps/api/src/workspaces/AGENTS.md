# AGENTS.md — módulo `workspaces`

## Propósito

Gerir o **repositório-alvo** onde a AI trabalha. Cada execução de iteração roda num
**git worktree isolado**, para não interferir na working tree principal nem entre
execuções.

## Estrutura

```
workspaces/
├── workspace.service.ts  # WorkspaceService: cria/limpa git worktree (STUB)
└── workspaces.module.ts  # @Global
```

## Contrato

- `WorkspaceService` provê o **`cwd`** isolado consumido pelo `AgentRunner` via
  `AgentRunInput.cwd`.
- É **@Global**: o `ai-engine` injeta o serviço sem reimportar o módulo.

## Invariantes

1. **Isolamento por execução** — nunca deixe uma iteração operar na working tree
   principal do repo-alvo.
2. Cada worktree deve ser rastreável para **cleanup** determinístico.

## O que NÃO mexer

- Não faça o loop engine manipular git diretamente; passe sempre pelo
  `WorkspaceService`.

## Estado atual

**Stub.** Decisões em aberto ([ADR-0008](../../../../docs/adr/0008-git-worktree-per-execution.md)):
diretório base dos worktrees, política de cleanup e reaproveitamento entre
iterações da mesma story.

## Como testar

- Ao implementar: criar worktree a partir de um repo local de teste, executar um
  comando no `cwd` isolado e remover o worktree ao final (sem afetar o repo base).
