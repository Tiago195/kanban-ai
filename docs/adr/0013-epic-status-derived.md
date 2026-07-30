# ADR-0013 — Status do epic é derivado (computado), não persistido

**Status:** Aceito

## Contexto

Um epic não é movido diretamente no board — seu status (To Do / In Progress / Done)
é uma função das stories filhas (regra `deriveEpicStatus` do artifact de referência).
Persistir um campo de status no epic criaria uma fonte de verdade duplicada, sujeita a
ficar dessincronizada das stories.

## Decisão

O status do epic é **sempre computado** a partir das stories filhas, nunca persistido:

- Regra (idêntica ao artifact): sem stories → `todo`; todas as stories em coluna Done →
  `done`; alguma story `everInProgress` ou já em In Progress/Review/Done → `inprogress`;
  caso contrário → `todo`. `everInProgress` é **pegajoso** (permanece true após entrar
  em In Progress).
- **Leitura:** `GET /cards` anexa `epicStatus: { status, done, total }` a cada card do
  tipo epic (computado no servidor via `deriveEpicStatus`).
- **Realtime:** ao mover uma story, o backend recomputa o status do epic pai e emite
  `epic.status.derived` para o front atualizar a sidebar sem F5.

Ou seja: computado no GET **e** empurrado por evento no move — ambos usam o mesmo
helper puro `deriveEpicStatus` (`apps/api/src/modules/cards/cards.epic-status.ts`).

## Consequências

- Uma única fonte de verdade (as stories); impossível dessincronizar.
- O helper é puro e testável isoladamente (cobre os 4 ramos + comportamento pegajoso).
- Custo: recomputar na leitura e no move. Trivial no v1 (board pequeno).
