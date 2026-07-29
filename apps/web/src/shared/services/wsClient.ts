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

  constructor(private readonly options: WsClientOptions = {}) {
    this.url = options.url ?? import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL;
  }

  connect(): void {
    if (this.socket) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => this.options.onOpen?.());
    socket.addEventListener('close', () => {
      this.socket = null;
      this.options.onClose?.();
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
    this.socket?.close();
    this.socket = null;
  }
}
