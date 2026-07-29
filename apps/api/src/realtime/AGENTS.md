# AGENTS.md — módulo `realtime`

## Propósito

Refletir mudanças no cliente **sem F5** via **WebSocket**. Fornece um hub de
broadcast e registra a rota WS no Fastify.

## Estrutura

```
realtime/
├── realtime.service.ts  # RealtimeService: broadcast(event) para todos os clientes
├── realtime.gateway.ts  # registro da rota WS no Fastify + tratamento de conexão
└── realtime.module.ts   # @Global — RealtimeService disponível a todos os módulos
```

## Contrato de eventos (fonte única)

Todos os eventos são definidos em `packages/shared/src/events.ts` como uma **união
discriminada** por `type` (`ServerEvent`). **Não** crie eventos ad-hoc no backend:
adicione ao contrato compartilhado e o cliente reage com `isEvent(...)`.

Eventos atuais: `card.moved`, `card.created`, `task.state.changed`, `dod.checked`,
`iteration.appended`, `story.entered_in_progress`, `task.derived`,
`agent.session.state_changed`, `auto.started`, `auto.stopped`, `ping`.

## Invariantes

1. **Todo evento emitido deve existir em `ServerEvent`** (`packages/shared`). Ao
   adicionar um evento, atualize o contrato e os consumidores (web) na mesma mudança.
2. `RealtimeService` é **@Global** — injete-o onde precisar emitir, não recrie hubs.
3. `broadcast` deve ser tolerante a clientes desconectados (não derrubar o processo).

## O que NÃO mexer

- Não emita objetos fora do tipo `ServerEvent`.
- Não acople lógica de domínio ao gateway; o domínio chama `RealtimeService.broadcast`.

## Nuance técnica

Há um leve descompasso de tipos entre `@fastify/websocket` v11 e o `FastifyInstance`
do adapter Nest — resolvido com um cast pontual no registro do plugin (ver
`main.ts`/gateway). O objeto de conexão é normalizado como
`(connection as unknown as { socket?}).socket ?? connection`.

## Como testar

- Conectar um cliente WS e verificar recebimento de ao menos um evento real
  (ex.: `card.moved` ao mover) + `ping`.
