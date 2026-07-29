import { Injectable, Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type { ServerEvent } from '@kanban-ai/shared';

/**
 * Hub de broadcast de eventos WebSocket.
 *
 * Mantém o conjunto de conexões vivas e distribui `ServerEvent` tipados para
 * todos os clientes. Serviços de domínio injetam este hub e chamam `broadcast`
 * quando algo relevante acontece (ex: card.moved, iteration.appended).
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly clients = new Set<WebSocket>();

  register(socket: WebSocket): void {
    this.clients.add(socket);
    this.logger.log(`WS conectado (total=${this.clients.size})`);
    socket.on('close', () => {
      this.clients.delete(socket);
      this.logger.log(`WS desconectado (total=${this.clients.size})`);
    });
    // Evento inicial tipado: confirma a conexão e serve de keep-alive imediato.
    this.sendTo(socket, { type: 'ping', ts: Date.now() });
  }

  /** Envia um evento tipado para um único socket (se estiver aberto). */
  private sendTo(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(event));
  }

  /** Envia um evento tipado para todos os clientes conectados. */
  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.clients) {
      // readyState 1 === OPEN
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }
}
