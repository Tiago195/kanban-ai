# ADR-0039 — Taxonomia typed de bloqueio & auto-unblock por dependência

**Status:** Aceito

## Contexto

Até aqui o loop engine só tinha **um balde** para "está bloqueado":

- `Card.blocked: Boolean` — flag genérica exibida na UI; e
- `Card.needsHuman: Boolean` (+ `needsHumanReason`) — a task esgotou tentativas
  (validação, caps de custo/tempo/token, anti-thrash, profundidade de derivação)
  e o auto-play parou até um humano intervir.

Além disso, o `execState = blocked-dep` (Prisma `blocked_dep`) sinaliza que a task
está **esperando uma dependência** (`TaskDependency`) fechar — e esse é o **único**
bloqueio que o engine já sabe **retomar sozinho** (via `resolveDependents`, que
re-valida dependentes quando uma dependência vira `done`).

O problema: do ponto de vista do engine, **todos os bloqueios pareciam iguais**.
Não dava para distinguir programaticamente:

1. **dependency** — espera outra task; auto-resumível, NÃO precisa de humano;
2. **needs_input** — falta uma decisão/resposta humana (HITL);
3. **capability** — o agent esgotou o que sabe fazer (caps de guard-rail); precisa
   de humano;
4. **transient** — falha passageira (rede, spawn, timeout) potencialmente
   retentável sem humano.

Sem essa distinção, a EP-BLOCK (auto-notificar owner, auto-acordar ao resolver
dependência, escalar por reincidência) não teria como rotear.

## Decisão

Introduzir uma **taxonomia typed de bloqueio** — aditiva e retrocompatível — como
fundação da EP-BLOCK. Esta ADR cobre a **US-BLOCK1** (a taxonomia e o roteamento
base); US-BLOCK2/3/4 constroem em cima dela.

### Contrato (`packages/shared`)

```ts
export const BLOCK_KIND = ['dependency', 'needs_input', 'capability', 'transient'] as const;
export type BlockKind = (typeof BLOCK_KIND)[number];
```

`CardBase` ganha `blockKind?: BlockKind | null` (nullable — `null` = comportamento
pré-BLOCK). Os campos legados **permanecem**: `blocked` e `needsHuman`/`needsHumanReason`
não são removidos nem re-significados.

`WAKEUP_REASON` é estendido (aditivo) com `'blockers_resolved'` (US-BLOCK3) e
`'issue_unblock'` (US-BLOCK2), já reservados aqui para não fragmentar migrations.

### Persistência (Prisma / Postgres)

- `enum BlockKind { dependency needs_input capability transient }`;
- `model Card { blockKind BlockKind? }` — **coluna nullable**, sem default,
  sem backfill → migration puramente aditiva;
- `enum WakeupReason` recebe os dois valores novos (aditivo).

### Roteamento no orchestrator (US-BLOCK1)

- **`escalateToHuman(...)`** — chamado por TODOS os caminhos de esgotamento
  (erro fatal, cap de validação, profundidade de derivação, gates de
  custo/tempo/token, iterações improdutivas, anti-thrash). Ganha um parâmetro
  `kind: BlockKind = 'capability'` e passa a gravar `Card.blockKind = kind`
  junto de `needsHuman = true`. Default `capability` porque todos os caminhos
  atuais são esgotamento de capacidade; chamadas HITL futuras podem passar
  `needs_input`.
- **`setExecState(taskId, 'blocked-dep')`** — centraliza a marcação de dependência:
  ao **entrar** em `blocked-dep`, grava `blockKind = 'dependency'`; ao **sair** de
  `blocked-dep` para qualquer outro estado, **limpa** (`blockKind = null`). Assim os
  três sites que bloqueiam por dependência (deps pendentes, falha ao resolver
  workdir e ao resolver o repo-alvo) ficam rotulados sem duplicação, e o
  auto-resume existente (`resolveDependents`) reaproveita o mesmo caminho.

Efeito no comportamento: **dependency** → segue To Do / auto-resume, **sem**
`needsHuman`; **needs_input/capability** → `needsHuman = true` (para o auto-play);
**transient** → reservado para US-BLOCK4 (retentável sem humano).

## Consequências

- ✅ O engine passa a **saber por que** uma task está parada — base para
  auto-notificação (US-BLOCK2), auto-wake ao fechar dependência (US-BLOCK3) e
  escalonamento por reincidência (US-BLOCK4).
- ✅ **Zero quebra**: coluna nullable, enums estendidos, campos legados intactos;
  cards antigos ficam com `blockKind = null` e seguem o comportamento anterior.
- ✅ Invariante 4 preservada — **não** reintroduz DOR nem `acceptance`
  ([ADR-0007](0007-remove-dor-and-acceptance.md)).
- ⚠️ `blocked-dep` do domínio ↔ `blocked_dep` do Prisma continuam convertidos por
  `toPrismaExecState`/`fromPrismaExecState` (loop-helpers) — a marcação de
  `blockKind` mora no `setExecState` (orchestrator), onde já há acesso ao DB.
- ⚠️ `blockKind` reflete o **bloqueio corrente**; ao destravar, é limpo. Não é um
  histórico (isso é responsabilidade da US-BLOCK4 via `AgentRuntimeState`).
