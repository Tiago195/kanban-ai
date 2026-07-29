# ADR-0004 — Persistência com Prisma + Postgres

**Status:** Aceito

## Contexto

O domínio tem hierarquia (Epic → Story → Task), relações ricas (labels, assignees,
DOD, iterações, dependências entre tasks) e precisa de migrations versionadas e
tipagem forte compartilhada com o TypeScript.

## Decisão

Usar **Prisma** sobre **Postgres 16** (via `docker-compose.yml`).

Modelagem principal: um **`Card` polimórfico** com discriminador `type`
(`epic|story|task`) e hierarquia via `parentId`, em vez de uma tabela por tipo.
Isso espelha o artifact (chaves `EP-`/`US-`/`TK-`, campos comuns) e simplifica
queries de board.

- `Column.isTaskColumn` distingue coluna do board (stories) da coluna do
  mini-kanban (tasks); um card referencia `boardColumnId` **ou** `taskColumnId`.
- `TaskDependency` modela `derivedFrom`/`dependsOn`.
- Enums usam underscore onde o domínio usa hífen
  (`blocked_dep`, `flows_regression`, `bug_gone_regression`, `regression_only`).

## Consequências

- Tipos do Prisma Client integram com o TS; migrations versionadas em
  `prisma/migrations`.
- Card polimórfico exige cuidado com campos opcionais por tipo (story tem
  `affectedFlows`; task tem `iterations`, `execState`, etc.).
- **Limitação de ambiente conhecida:** o Query Engine (Rust) do Prisma pode não
  abrir TCP de saída em sandboxes restritos (`P1001`). Workaround documentado em
  [CONTRIBUTING.md](../../CONTRIBUTING.md#banco-de-dados-em-ambientes-restritos):
  aplicar migration via `psql` e rodar o seed dentro de um container com OpenSSL 3
  na rede do Docker. A migration SQL é gerada offline com
  `prisma migrate diff --from-empty --to-schema-datamodel ... --script`.
