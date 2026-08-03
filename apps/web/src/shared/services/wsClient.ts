import type { ServerEvent, ServerEventType } from '@kanban-ai/shared';

const DEFAULT_WS_URL = 'ws://localhost:3333/ws';

export type EventHandler = (event: ServerEvent) => void;

export interface WsClientOptions {
  url?: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
  onEvent?: EventHandler;
}

/**
 * Cliente WebSocket tipado pelo contrato `ServerEvent` do pacote shared.
 * Faz JSON.parse das mensagens e roteia para handlers por `type`.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers = new Map<ServerEventType, Set<EventHandler>>();
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: WsClientOptions = {}) {
    this.url = options.url ?? import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL;
  }

  connect(): void {
    if (this.socket) return;
    this.shouldReconnect = true;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.options.onOpen?.();
    });
    socket.addEventListener('close', () => {
      this.socket = null;
      this.options.onClose?.();
      this.scheduleReconnect();
    });
    socket.addEventListener('error', (err) => this.options.onError?.(err));
    socket.addEventListener('message', (msg: MessageEvent<string>) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(msg.data) as ServerEvent;
      } catch {
        return;
      }
      this.dispatch(event);
    });
  }

  /** Reconecta com backoff exponencial (cap 10s) enquanto `shouldReconnect`. */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.connect();
    }, delay);
  }

  /** Registra um handler para um tipo específico de evento. Retorna um unsubscribe. */
  on<T extends ServerEventType>(
    type: T,
    handler: (event: Extract<ServerEvent, { type: T }>) => void,
  ): () => void {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler as EventHandler);
    this.handlers.set(type, set);
    return () => set.delete(handler as EventHandler);
  }

  private dispatch(event: ServerEvent): void {
    this.options.onEvent?.(event);
    const set = this.handlers.get(event.type);
    set?.forEach((handler) => handler(event));
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    // Fechar um socket ainda em CONNECTING dispara o warning "closed before
    // established". Adiamos o close até abrir; se já estiver abrindo/aberto,
    // fechamos direto.
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.addEventListener('open', () => socket.close(), { once: true });
    } else {
      socket.close();
    }
  }
}
