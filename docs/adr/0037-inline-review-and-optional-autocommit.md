# ADR-0037 — Review inline + auto-commit/PR opcional gated (US-OBS3)

**Status:** Aceito

## Contexto

O EP-OBS deu ao operador visibilidade (dashboard US-OBS1) e resiliência de
worktree (US-OBS2/[ADR-0035](0035-worktree-isolated-resilient.md)). Faltava (1)
uma forma de anexar **feedback por linha** ao trabalho de uma story/task — como o
review de um PR — e (2) fechar o loop opcionalmente **materializando** o trabalho
verde num commit/PR, sem exigir intervenção manual.

Restrições que continuam valendo:

- **Sem DOR e sem `acceptance`** — o único checklist de conclusão continua sendo o
  **DOD** ([ADR-0007](0007-remove-dor-and-acceptance.md)). Os comentários de review
  são **observabilidade/evidência**, não um novo gate obrigatório.
- **O agent NÃO executa git** — todo git é do **engine** ([ADR-0008](0008-git-worktree-per-execution.md)).
- **A API roda no host** ([ADR-0019](0019-api-runs-on-host-not-docker.md)); o
  `cwd` do trabalho é um worktree dentro do FS do usuário.
- Sem Redis; contrato type-safe compartilhado entre web e api.

## Decisão

### 1. Comentários de review por linha (persistidos)

Novo modelo Prisma **`ReviewComment`** (`cardId` FK cascade, `iterationId?`,
`filePath`, `line`, `body`, `author`, `resolved` default `false`, timestamps;
índices `@@index([cardId])` e `@@index([cardId, filePath])`). Migração aditiva
`add_review_comment` (não reseta o banco compartilhado).

Novo módulo `apps/api/src/modules/review/` com CRUD aninhado no card:

- `POST   /cards/:id/review/comments`                     — cria comentário.
- `GET    /cards/:id/review/comments`                     — lista por card.
- `PATCH  /cards/:id/review/comments/:commentId/resolve`  — resolve.

Ao criar, o `ReviewService` emite o evento WS **`review.comment_added`**
(`ReviewCommentAddedEvent`) pelo mesmo hub dos demais eventos; a UI
(`apps/web/src/features/review/`) invalida `queryKeys.reviewComments(cardId)` para
refletir sem F5. Contratos (`ReviewComment`, `ReviewCommentInput`) vivem em
`packages/shared`.

### 2. Auto-commit / auto-PR OPCIONAL, gated (default OFF)

Duas flags novas em `config.agent`, ambas **default `false`**:

- `autoCommit` (`AGENT_AUTO_COMMIT`)
- `autoPr` (`AGENT_AUTO_PR`)

Após uma iteração com **validação verde**, o orchestrator chama o gate
`maybeAutoCommit(storyId, taskId, evidence)`, que decide (função testável) e
delega o git ao `WorkspaceService` (o **engine**, nunca o agent). O desfecho é o
`CommitOutcome` compartilhado:

| Situação | `committed` | `skippedReason` |
|---|---|---|
| `AGENT_AUTO_COMMIT` off (default) | `false` | `disabled` |
| evidência não verificável / algum check `passed=false` | `false` | `not-verified` |
| verde, mas **sem worktree isolado** ([ADR-0035](0035-worktree-isolated-resilient.md)) | `false` | `no-isolated-worktree` |
| verde + worktree isolado, sem mudanças | `false` | `nothing-to-commit` |
| git do engine falhou | `false` | `commit-failed` |
| verde + worktree isolado + mudanças | `true` | — (`commitSha`, `branch`) |

O commit **só** ocorre dentro do **worktree ISOLADO** (`git add -A` + `git commit`
via `WorkspaceService.commitIsolatedWorktree`); jamais contra o repo-alvo
diretamente. `AGENT_AUTO_PR` sinaliza a intenção de abrir PR (ponto de extensão;
v1 não abre PR sem `gh`/token). O gate é best-effort: qualquer falha é logada e
**nunca derruba o loop**.

## Consequências

- Feedback por linha persistido e reativo (WS), sem reintroduzir DOR/acceptance.
- Fechamento opcional do loop (commit/PR) **100% retrocompatível**: com as duas
  flags OFF (default) o comportamento é **idêntico ao de hoje** — zero commit.
- Auto-commit respeita as invariantes: engine faz o git (ADR-0008), só dentro de
  worktree isolado (ADR-0035), API no host (ADR-0019).
- Novas flags `AGENT_AUTO_COMMIT` / `AGENT_AUTO_PR` documentadas em `.env.example`.
- Novo contrato compartilhado `CommitOutcome` observável para futuras UIs.
