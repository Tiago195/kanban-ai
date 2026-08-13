import 'reflect-metadata';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

// Rodando no host (fora do Docker), as variáveis de ambiente vêm do .env na
// raiz do monorepo. Procuramos o .env subindo a árvore de diretórios a partir
// do cwd (robusto tanto em dev `nest start` quanto em `node dist/main.js`).
// Quando uma env já existe no ambiente (ex.: CI/Docker), o dotenv NÃO a
// sobrescreve, então o comportamento em container fica preservado.
(function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyWebsocket from '@fastify/websocket';
import { AppModule } from './app.module';
import { loadConfig } from './shared/config/config';
import { applyBootBackoff, reset as resetCircuitBreaker } from './shared/boot/circuit-breaker';
import { initTracing } from './shared/observability/tracing';

async function bootstrap(): Promise<void> {
  // US-OBS2-1 — tracing OTel opt-in. DEVE rodar ANTES de `NestFactory.create` e
  // de qualquer módulo instrumentado (HTTP/Fastify/pg) para o auto-instrument
  // conseguir aplicar os patches. No-op com custo zero quando
  // `OTEL_EXPORTER_OTLP_ENDPOINT` não está setado; degradação graciosa se os
  // pacotes OTel estiverem ausentes (loga uma vez e segue). Ver tracing.ts.
  await initTracing();

  const config = loadConfig();

  // US-HARD2 — circuit-breaker de crash-loop. ANTES de qualquer conexão a
  // Postgres/LLM (i.e. antes de `NestFactory.create`), aplicamos backoff
  // persistido: se o boot anterior não registrou shutdown limpo, esperamos um
  // intervalo crescente para não martelar dependências num crash-loop. Boots
  // saudáveis (attempt 0/1) NÃO são atrasados. Ver circuit-breaker.ts.
  await applyBootBackoff({
    dataDir: config.boot.dataDir,
    windowMs: config.boot.recoveryWindowMs,
    enabled: config.boot.circuitBreakerEnabled,
    log: (m) => Logger.warn(m, 'Bootstrap'),
  });

  const adapter = new FastifyAdapter();

  // Registra o plugin de WebSocket ANTES do listen; a rota é declarada no RealtimeGateway.
  // Cast por divergência de tipos entre @fastify/websocket e a instância do adapter.
  await adapter
    .getInstance()
    .register(fastifyWebsocket as never);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  app.enableCors({ origin: true });
  app.enableShutdownHooks();

  await app.listen(config.apiPort, '0.0.0.0');

  // `app.listen` OK significa que passamos da zona de perigo do crash-loop
  // (Nest inicializou todos os providers, DB conectou, porta está ouvindo).
  // Marcamos o boot como bem-sucedido zerando o contador. O mesmo `reset` é
  // chamado no shutdown gracioso via handlers de sinal abaixo.
  if (config.boot.circuitBreakerEnabled) {
    resetCircuitBreaker(config.boot.dataDir);
  }

  // Shutdown gracioso: em SIGTERM/SIGINT registramos um shutdown LIMPO (reset)
  // e deixamos o Nest fechar os recursos via enableShutdownHooks. Isso garante
  // que um restart intencional não incremente o contador de crash-loop.
  const gracefulShutdown = (signal: NodeJS.Signals): void => {
    if (config.boot.circuitBreakerEnabled) {
      resetCircuitBreaker(config.boot.dataDir);
    }
    void app
      .close()
      .catch((err) => Logger.error(err instanceof Error ? err.stack : String(err), 'Bootstrap'))
      .finally(() => process.exit(0));
    Logger.log(`Shutdown gracioso (${signal}).`, 'Bootstrap');
  };
  process.once('SIGTERM', gracefulShutdown);
  process.once('SIGINT', gracefulShutdown);

  Logger.log(`API ouvindo em http://localhost:${config.apiPort}`, 'Bootstrap');
  Logger.log(`WebSocket em ws://localhost:${config.apiPort}${config.wsPath}`, 'Bootstrap');
}

void bootstrap();
