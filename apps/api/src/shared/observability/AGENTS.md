# AGENTS.md — shared/observability

## O que vive aqui

`tracing.ts` — bootstrap de **OpenTelemetry tracing opt-in** para o processo da
API (US-OBS2-1).

## Invariantes

- **Opt-in por env**: liga SOMENTE quando `OTEL_EXPORTER_OTLP_ENDPOINT` está
  presente e não-vazio. Sem ele, `initTracing()` é **no-op com custo zero** — o
  `import()` dos pacotes OTel vive DENTRO do ramo habilitado, então nada é
  carregado quando desligado.
- **Escopo API-side apenas**: auto-instrumentação de HTTP + Fastify + PG.
  `fs`/`dns`/`net` ficam DESLIGADAS. **NÃO** há trace fim-a-fim para o trabalho
  do loop, que roda em subprocessos `copilot` spawnados (fora do SDK deste
  processo).
- **Degradação graciosa**: pacotes ausentes ou init com falha → loga UMA vez
  (`warn`) e segue o boot. Tracing nunca derruba a API.
- **Ordem de import**: `initTracing()` é chamado no TOPO de `bootstrap()` em
  `main.ts`, antes de `NestFactory.create` e de qualquer módulo instrumentado.

## Testes

Rodar SERIAL (specs de API):

```bash
cd apps/api && node --require ts-node/register --test --test-concurrency=1 \
  --test-reporter spec "src/shared/observability/**/*.spec.ts"
```
