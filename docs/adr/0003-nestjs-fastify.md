# ADR-0003 — Backend com NestJS + Fastify

**Status:** Aceito

## Contexto

O backend orquestra domínio, filas de trabalho de AI (loop engine), WebSocket e
persistência. Precisamos de uma estrutura **opinativa e modular** (boa para AIs
seguirem convenções) com **boa performance**.

## Decisão

Usar **NestJS** com o **adapter Fastify** (`NestFastifyApplication`). Cada feature
é um módulo (`controller` + `service` + `module`). O WebSocket é registrado via
`@fastify/websocket` no bootstrap.

## Consequências

- Estrutura previsível por módulo → guard-rail natural para desenvolvimento com AI.
- Fastify traz melhor throughput que Express e integra o gateway WS.
- Nuance técnica: há um leve descompasso de tipos entre `@fastify/websocket` v11 e
  o `FastifyInstance` do adapter — resolvido com um cast pontual no registro do
  plugin (documentado no código).
- DI do Nest permite tokens plugáveis (ex.: `AGENT_RUNNER`) para o loop engine.
