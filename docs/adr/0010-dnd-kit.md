# ADR-0010 — Drag-and-drop com @dnd-kit

**Status:** Aceito

## Contexto

A Fase 2 exige drag-and-drop no board principal (stories entre 5 colunas) e em
mini-kanbans aninhados dentro dos modais (tasks no modal da story; stories no modal
do epic). Precisamos de uma biblioteca acessível, sem HTML5 DnD nativo (limitado em
mobile/teclado), com suporte a listas ordenáveis e múltiplos contextos aninhados.

## Decisão

Adotar **@dnd-kit** (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`) para
todo drag-and-drop do web. Cada board (principal e cada mini-kanban) é um
`DndContext` próprio; colunas usam `SortableContext`; o `onDragEnd` dispara a mutation
`useMoveCard`.

## Consequências

- Acessível (teclado + ponteiro), leve e headless — combina com shadcn/ui.
- DnD aninhado exige `DndContext` isolado por board para evitar conflito de sensores.
- Alternativas descartadas: `react-beautiful-dnd` (deprecado/manutenção parada) e
  HTML5 DnD nativo (DX ruim, sem acessibilidade).
