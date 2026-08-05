# ADR-0021 — Roteamento client-side com react-router

**Status:** Aceito

## Contexto

Até aqui o `apps/web` era declaradamente **single-view**: um único board mais
três overlays (agentes, loops e o chat de criação de backlog) controlados por
`useState(boolean)` em `App.tsx`. Não havia URL para nada além de `/`.

Isso quebrava o **chat de criação de épicos/histórias** (ver
[ADR-0020](0020-mcp-server-second-control-plane.md) para o contexto de AIs
operando o board). O sintoma relatado: **dar F5 durante uma conversa com o
agent perdia tudo**. Havia duas causas:

1. **Overlay era estado local.** `backlogChatOpen` voltava a `false` no reload,
   fechando a tela.
2. **Sessão recriada do zero.** O `sessionId` vivia só em `useState` dentro do
   `BacklogChatView`; no reload ele sumia e o `useEffect` de bootstrap criava uma
   sessão nova, deixando a conversa anterior órfã no banco.

O backend já persistia tudo (mensagens + proposta) e o hook `useBacklogChat` já
reidratava a conversa a partir de um `sessionId` (GET `/messages` + `/proposal`).
Faltava apenas **um lugar durável para o `sessionId` sobreviver ao F5** — e a URL
é esse lugar.

## Decisão

Adotar **`react-router-dom` (BrowserRouter)** como roteador client-side do
`apps/web`, encerrando o padrão single-view informal.

- **`main.tsx`** envolve o `App` em `<BrowserRouter>`.
- **`App.tsx`** continua sendo o layout do board (header + métricas +
  `BoardView`), mas os três overlays passam a ser **rotas** renderizadas por um
  `<Routes>`:
  - `/` — só o board.
  - `/agents` — `AgentsModal`.
  - `/loops` — `LoopsModal`.
  - `/backlog-chat` — cria uma sessão nova e **redireciona** para
    `/backlog-chat/:sessionId` (`navigate(..., { replace: true })`).
  - `/backlog-chat/:sessionId` — reabre a conversa; o `sessionId` da URL alimenta
    o `useBacklogChat`, que reidrata do backend (**F5-safe**).
- Os botões do header disparam `navigate("/agents" | "/loops" | "/backlog-chat")`
  em vez de `setState(true)`; os overlays fecham com `navigate("/")`.
- **`BacklogChatView`** deixa de guardar o `sessionId` em `useState`. Recebe
  `routeSessionId` (da URL) e `onSessionCreated` (para o router refletir o id na
  URL). Só cria sessão quando a URL não traz id.

## Consequências

- **F5 preserva a conversa.** O `sessionId` vive na URL; o reload reabre a mesma
  sessão e reidrata o histórico. A conversa não é mais recriada do zero.
- **Deep-link.** É possível compartilhar/abrir direto `/backlog-chat/<id>`, e os
  botões de voltar/avançar do navegador funcionam entre board e overlays.
- **SPA fallback.** Deep-links dependem do servidor servir `index.html` para
  qualquer rota. O Vite dev server já faz isso por padrão; qualquer host de
  produção estático precisa do mesmo history-fallback.
- **Fundação executável intacta.** Mudança confinada ao `apps/web` (nenhum
  contrato de `packages/shared` ou endpoint de `apps/api` mudou). `build` e
  `lint` do web seguem verdes.
- **Migração incremental.** `AgentsModal`/`LoopsModal` continuam como componentes
  inline em `App.tsx`; apenas o **gatilho** virou rota. Extrair views maiores
  para rotas próprias fica para quando houver necessidade.
