# ADR-0011 — Server-state com TanStack Query e UI-state com Zustand

**Status:** Aceito

## Contexto

O board precisa separar dois tipos de estado: **server-state** (cards, colunas,
labels — vindos da API, com cache, refetch e invalidação) e **UI-state** (cascata de
modais abertos, item sendo arrastado, aba ativa — puramente local). Misturar os dois
num único store gera complexidade e bugs de sincronização.

## Decisão

- **Server-state: TanStack Query (React Query)** — queries por recurso (`['board',id]`,
  `['cards',boardId]`, `['card',id]`), mutations com **updates otimistas + rollback**
  no drag-and-drop, e invalidação como fonte de reconciliação com o servidor.
- **UI-state: Zustand** — um store leve para a cascata de modais (stack Epic→Story→
  Task), item arrastado e aba ativa.

## Consequências

- Cache, dedupe e refetch saem de graça no server-state; menos boilerplate.
- O WebSocket apenas **invalida/atualiza** o cache do TanStack Query (ver ADR-0012),
  mantendo o servidor como verdade.
- Zustand mantém o UI-state trivial e desacoplado do server-state.
- Alternativas descartadas: Redux (verboso para este escopo) e um único store global
  (acoplaria server e UI state).
