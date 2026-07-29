import { useEffect, useRef, useState } from 'react';
import type { ServerEvent } from '@kanban-ai/shared';

import { WsClient } from '@/shared/services/wsClient';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface UseRealtimeResult {
  status: ConnectionStatus;
  lastEvent: ServerEvent | null;
}

/**
 * Conecta ao gateway WebSocket, loga eventos recebidos e expõe o último evento
 * mais o status da conexão. Fundação — consumidores por feature virão depois.
 */
export function useRealtime(url?: string): UseRealtimeResult {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const client = new WsClient({
      url,
      onOpen: () => setStatus('open'),
      onClose: () => setStatus('closed'),
      onEvent: (event) => {
        console.log('[realtime] evento recebido:', event);
        setLastEvent(event);
      },
    });
    clientRef.current = client;
    setStatus('connecting');
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [url]);

  return { status, lastEvent };
}
