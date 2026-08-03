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

async function bootstrap(): Promise<void> {
  const config = loadConfig();
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
  Logger.log(`API ouvindo em http://localhost:${config.apiPort}`, 'Bootstrap');
  Logger.log(`WebSocket em ws://localhost:${config.apiPort}${config.wsPath}`, 'Bootstrap');
}

void bootstrap();
