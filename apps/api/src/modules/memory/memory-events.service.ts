import { Injectable } from '@nestjs/common';
import type {
  AgentId,
  MemoryConflict,
  MemoryReviewItem,
  Owner,
} from '@kanban-ai/shared';
import { RealtimeService } from '../../realtime/realtime.service';

/**
 * EP-81 — Emissor tipado dos eventos `memory.*` no WebSocket.
 *
 * Fina fachada sobre {@link RealtimeService}: os serviços de memória (lock/write/
 * review) chamam estes métodos como **3º passo** da ordem de escrita
 * (git → índice → WS), sem acoplar-se ao gateway. Todo evento aqui já existe na
 * união `ServerEvent` de `packages/shared` (ver `apps/api/src/realtime/AGENTS.md`).
 *
 * Isolar a emissão num serviço próprio mantém os testes das camadas de domínio
 * simples (injeta-se um fake sem WS) e concentra o mapeamento payload↔evento.
 */
@Injectable()
export class MemoryEventsService {
  constructor(private readonly realtime: RealtimeService) {}

  /** `memory.locked` — um neurônio passou de FREE para EDITING. */
  locked(path: string, headCommit: string, owner: Owner): void {
    this.realtime.broadcast({ type: 'memory.locked', path, headCommit, owner });
  }

  /** `memory.released` — um neurônio voltou (de EDITING ou REVIEW) para FREE. */
  released(path: string, headCommit: string, owner: Owner): void {
    this.realtime.broadcast({ type: 'memory.released', path, headCommit, owner });
  }

  /** `memory.updated` — novo commit gravado no path (write/CAS ou resolve-aceitar). */
  updated(path: string, headCommit: string, agentId: AgentId): void {
    this.realtime.broadcast({ type: 'memory.updated', path, headCommit, agentId });
  }

  /** `memory.conflict` — colisão semântica levou o path a REVIEW. */
  conflict(conflict: MemoryConflict): void {
    this.realtime.broadcast({ type: 'memory.conflict', conflict });
  }

  /** `memory.review` — um item entrou na fila de REVIEW aguardando arbitragem. */
  review(item: MemoryReviewItem): void {
    this.realtime.broadcast({ type: 'memory.review', item });
  }
}
