import 'reflect-metadata';
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
