# ADR-0012 — Realtime: WebSocket invalida o cache do TanStack Query

**Status:** Aceito

## Contexto

Mutações no board (mover card, editar, marcar DOD, anexar label/assignee, mudar flows)
devem refletir em tempo real em todos os clientes sem F5. Já existe um gateway
WebSocket que emite `ServerEvent` tipados (`packages/shared`). Precisamos definir como
o front reage a esses eventos e como conciliar com os **updates otimistas** do
drag-and-drop.

## Decisão

O WebSocket **não** carrega o novo estado para dentro dos componentes diretamente.
Em vez disso, cada `ServerEvent` recebido **invalida** (ou atualiza pontualmente) as
queries relevantes do TanStack Query, que então refazem o fetch do servidor:

- `card.moved` → invalida `['cards',boardId]` + `['board',boardId]`.
- `card.updated` / `dod.checked` / `label.*` / `assignee.*` / `flow.changed` →
  invalida `['card',cardId]` (e os cards do board quando afeta posição/coluna).
- `epic.status.derived` → atualiza a sidebar de epics (cards do board).

**Reconciliação otimista × eco WS:** o update otimista do drag-and-drop pinta a UI na
hora; quando o eco do próprio move chega via WS, a invalidação refaz o fetch e o
**servidor é a verdade** — convergindo o estado sem piscar (o dado otimista já batia
com o servidor no caminho feliz; em erro, o `onError` do TanStack faz rollback).

## Consequências

- Um único caminho de verdade (o servidor); a UI nunca diverge por muito tempo.
- Eventos são "dicas de invalidação", não payloads de estado — simples e robusto.
- Custo: um refetch por evento. Aceitável no v1 (board único, pequeno). Se crescer,
  dá para trocar invalidação por `setQueryData` cirúrgico usando o payload do evento.
