# Copilot instructions — kanban-ai

> Estas instruções são carregadas automaticamente por superfícies do Copilot
> (CLI, VS Code, coding agent). Elas **não substituem** os `AGENTS.md`: são um
> ponto de entrada que aponta para eles e repete só o essencial. **Sempre leia o
> [`AGENTS.md`](../AGENTS.md) da raiz e o `AGENTS.md` do módulo que você for
> tocar antes de qualquer alteração.**

## O que é este projeto (em uma frase)

`kanban-ai` é a **fundação** de um Kanban Agile onde os *assignees* são **agents
de AI autônomos** que trabalham em **loop**. Hierarquia **Epic → Story → Task**.
Quando uma **story entra em "In Progress"**, o **loop engine** acorda um agent que
itera, marca o **DOD** e valida os fluxos afetados. Ver [`README.md`](../README.md).

## Antes de começar qualquer tarefa — leia o contexto certo

| Vou mexer em… | Leia primeiro |
|---|---|
| Qualquer coisa | [`AGENTS.md`](../AGENTS.md) (raiz) + este arquivo |
| Loop engine / orquestração | [`docs/loop-engine.md`](../docs/loop-engine.md) + `apps/api/src/modules/ai-engine/AGENTS.md` |
| Contratos (enum/DTO/evento WS) | `packages/shared/src/{enums,dtos,domain,events}.ts` |
| Cards (Epic/Story/Task) | `apps/api/src/modules/cards/AGENTS.md` |
| Eventos realtime / WS | `packages/shared/src/events.ts` + `apps/web/src/features/realtime/hooks/useRealtime.ts` + `apps/api/src/realtime/AGENTS.md` |
| Workspaces / git worktree | `apps/api/src/workspaces/AGENTS.md` + [ADR-0008](../docs/adr/0008-git-worktree-per-execution.md) |
| MCP server | `apps/mcp/AGENTS.md` + [ADR-0020](../docs/adr/0020-mcp-server-second-control-plane.md) |
| Decisões / porquês | [`docs/adr/`](../docs/adr/) |

## Invariantes do domínio (NUNCA violar)

1. Hierarquia **Epic → Story → Task** num único `Card` polimórfico (`type`,
   `parentId`, `key` `EP-`/`US-`/`TK-`).
2. **Epic é derivado**: status vem das stories filhas. Ninguém move um epic direto.
3. **Task só se cria** em **Backlog** ou **To Do** (`TASK_CREATION_COLUMNS`).
4. **Sem DOR e sem `acceptance` no v1** — o único checklist é o **DOD**
   ([ADR-0007](../docs/adr/0007-remove-dor-and-acceptance.md)). **Não reintroduzir.**
5. **Story points** ∈ `{1,2,3,5,8,13}` (só story/epic; task não tem pontos).
6. O **loop engine** só dispara quando uma **story entra em In Progress**.

## Regras de trabalho

- **Type-safe sempre.** Contratos vivem em `packages/shared` e são consumidos por
  web **e** api. Mudou um contrato? Atualize os **dois** lados na mesma mudança.
- **Boundaries claros.** Não importe internals de outra feature/módulo; use o
  `index.ts` público (web) ou o provider exportado (api).
- **Não quebre a fundação executável.** `npm run build`, `npm run lint` e
  `npm test` devem continuar passando; `GET /health` deve continuar respondendo.
- **Prefira ferramentas de ecossistema** (nest, vite, prisma, shadcn) a
  boilerplate manual.
- **Implementou um stub?** Remova o TODO e atualize o `AGENTS.md` do módulo se o
  contrato mudou.
- **Nunca comite segredos.** Use `.env` (ignorado) a partir de `.env.example`.

## Validação obrigatória antes de concluir

Rode e garanta verde antes de dar a tarefa por concluída:

```bash
npm run build && npm run lint && npm test
```

Ao tocar o banco, aplique migration + seed (ver [`CONTRIBUTING.md`](../CONTRIBUTING.md)).

## Higiene de commits (importante para a próxima sessão de AI)

O `git log` é a **memória de curto prazo** do projeto. Faça commits **atômicos**
com mensagem semântica no imperativo — **evite `wip`**:

```
feat(ai-engine): encadeia iterações do loop
fix(backlog-chat): Sheet reflete tasks em tempo real
docs(adr): registra decisão de streaming via WS
```

Prefixos: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
