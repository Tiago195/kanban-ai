# ADR-0017 — Streaming + HITL via WebSocket (rejeição de TanStack AI/SSE) + buffer reativo

**Status:** Aceito

## Contexto

A Fatia 4 adiciona duas capacidades que **não existem no artifact**: (1)
**streaming ao vivo** do "pensamento" da AI enquanto a iteração roda; e (2)
**HITL** (human-in-the-loop) — a AI pode **pausar e perguntar** antes de seguir.

Já temos um **WebSocket gateway** tipado ([ADR-0012](0012-realtime-ws-invalidates-cache.md))
usado nas Fatias 2/3, e o front usa **shadcn** + TanStack Query + Zustand
([ADR-0011](0011-tanstack-query-zustand.md)). Avaliamos adotar **TanStack AI** e/ou
criar um endpoint **SSE** dedicado para o streaming.

## Decisão

**Reusar o WebSocket existente** para streaming e HITL; **não** adotar TanStack AI
nem criar SSE novo. O chat é construído com **shadcn puro**.

Novos eventos WS tipados (em `packages/shared`):
- `agent.chunk` (taskId, storyId, kind: thought|output, delta) — fragmento de
  stream.
- `agent.question` (taskId, storyId, questionId, prompt, options?) — a AI pausou.
- `agent.answered` (taskId, questionId) — a pergunta foi respondida.

**Decisão crítica de cache:** o padrão de realtime da [ADR-0012](0012-realtime-ws-invalidates-cache.md)
**invalida queries** por evento. Isso **não serve** para `agent.chunk` — invalidar
por token causaria refetch a cada fragmento. Portanto os chunks e o transcript
vão para um **buffer reativo em memória** — um store Zustand dedicado
(`agentChatStore`, keyed por taskId). `agent.chunk`/`agent.question`/`agent.answered`
**não invalidam** cache; apenas `iteration.appended` (persistência real) segue
pelo caminho normal de invalidação.

A resposta HITL volta por um endpoint dedicado
`POST /cards/:id/loop/answer` (id = story) → `resolveQuestion` no
`AgentSessionManager` → a resposta é escrita no **stdin** do subprocesso, retomando
a iteração.

## Rationale (por que não TanStack AI / SSE)

- Nosso "provider" é um **subprocesso** sem adapter oficial para TanStack AI —
  adotá-lo adicionaria acoplamento sem cobrir o caso.
- SSE seria um **segundo canal** de transporte a manter, autenticar e reconectar,
  duplicando o que o WS já faz (bidirecional, tipado, com reconexão).
- WS + shadcn cobrem streaming, HITL e o resto do realtime com **menos peças**.

## Consequências

- Um único canal de transporte (WS) para todo o realtime.
- Chunks de alta frequência não pressionam o servidor com refetches.
- O chat é 100% shadcn/CSS do app — consistente com o design.
- Reconexão de aba: o transcript vive em memória do cliente; uma aba nova começa
  o buffer vazio e passa a acumular a partir da reconexão (o estado persistido de
  iterações vem por `GET /cards/:id`).
