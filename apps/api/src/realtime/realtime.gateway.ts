import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { RealtimeService } from './realtime.service';
import { APP_CONFIG, type AppConfig } from '../shared/config/config';

/**
 * Registra a rota WebSocket no Fastify e liga cada conexão ao RealtimeService.
 *
 * O plugin `@fastify/websocket` é registrado em `main.ts` (antes do listen).
 * Aqui declaramos a rota no path configurável (`WS_PATH`) e mantemos um ping
 * periódico de keep-alive.
 */
@Injectable()
export class RealtimeGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private pingTimer?: NodeJS.Timeout;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly realtime: RealtimeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();

    fastify.get(this.config.wsPath, { websocket: true }, (connection) => {
      // @fastify/websocket entrega o socket em `connection.socket` (v8) ou como
      // o próprio `connection` — normalizamos aqui.
      const socket = (connection as unknown as { socket?: unknown }).socket ?? connection;
      this.realtime.register(socket as never);
    });

    this.logger.log(`WS gateway registrado em ${this.config.wsPath}`);

    // Ping periódico de keep-alive para todos os clientes conectados.
    this.pingTimer = setInterval(() => {
      this.realtime.broadcast({ type: 'ping', ts: Date.now() });
    }, 30_000);
  }

  onModuleDestroy(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
  }
}
