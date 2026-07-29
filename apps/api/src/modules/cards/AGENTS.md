# AGENTS.md — módulo `cards`

## Propósito

Gerir os **cards** — o agregado central do domínio. Um card é **polimórfico**:
`type` ∈ `epic | story | task`, com hierarquia via `parentId` e chave de negócio
`EP-`/`US-`/`TK-` + sequência.

## Estrutura

```
cards/
├── cards.schema.ts     # schemas Zod (validação de entrada) + tipos
├── cards.service.ts    # regras de negócio + acesso via PrismaService
├── cards.controller.ts # rotas REST
└── cards.module.ts
```

## Invariantes (NUNCA violar)

1. **Task só pode ser criada** em coluna **Backlog** ou **To Do**
   (`TASK_CREATION_COLUMNS` de `packages/shared`). O `create()` já **impõe** isso.
2. **Epic é derivado** das stories filhas — **não** exponha rota para mover epic
   diretamente. O status do epic deve ser recalculado a partir das stories.
3. **Story points** ∈ `{1,2,3,5,8,13}`, só para story/epic. Task não tem pontos.
4. **Sem DOR/`acceptance`** — o único checklist é o **DOD**
   ([ADR-0007](../../../../../docs/adr/0007-remove-dor-and-acceptance.md)).
5. Geração de `key` é **sequencial por tipo** dentro de uma `$transaction` (evita
   corrida de numeração).

## Contratos

- Entrada validada por **Zod** (`cards.schema.ts`) via `ZodValidationPipe`.
- Tipos de domínio compartilhados vêm de `@kanban-ai/shared` (`CardType`,
  `ExecState`, `StoryPoints`, etc.) — **não** duplicar.
- Mudanças de card que a UI observa devem emitir eventos WS (`card.created`,
  `card.moved`, `task.state.changed`, `dod.checked`) via `RealtimeService`.

## O que NÃO mexer

- Não afrouxe a regra de criação de task (Backlog/To Do).
- Não adicione campos de DOR/`acceptance`.
- Não gere `key` fora de transação.

## Como testar

- `npx nest build` deve passar.
- Testes recomendados: criação de task fora de Backlog/To Do deve falhar; geração
  de `key` sequencial; derivação de status do epic a partir das stories.
