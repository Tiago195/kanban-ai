import { Global, Module } from '@nestjs/common';
import { MemoryEventsService } from './memory-events.service';
import { MemoryGitService } from './memory-git.service';
import { MemoryIndexService } from './memory-index.service';
import { MemoryLockService } from './memory-lock.service';
import { MemoryReviewService } from './memory-review.service';
import { MemoryWriteService } from './memory-write.service';

/**
 * Módulo da **memória** (ADR-0027).
 *
 * - **Camada 1** (`MemoryGitService`): git como fonte da verdade — provisiona o
 *   bare repo e faz read/write/merge/diff/history de neurônios.
 * - **Camada 2** (`MemoryIndexService`): índice Postgres derivado/descartável —
 *   reindex/rebuild/query e a ordem de escrita git → índice.
 * - **Locks advisory + presença** (`MemoryLockService`, EP-78): lease com
 *   TTL/heartbeat, release e anti-deadlock sobre o índice.
 * - **Escrita otimista + CAS** (`MemoryWriteService`, EP-79): ramo efêmero por
 *   agent, compare-and-swap anti-stale, merge 3-way e retry.
 * - **REVIEW + arbitragem** (`MemoryReviewService`, EP-80): `EDITING → REVIEW`
 *   por conflito semântico ou escrita fora de escopo, `memory.conflict` e
 *   `resolve` (aceitar/descartar) fechando `REVIEW → FREE`.
 *
 * É `@Global` (como `workspaces`) para que consumidores (MCP, gateway WS)
 * injetem os serviços sem reimportar o módulo.
 */
@Global()
@Module({
  providers: [
    MemoryGitService,
    MemoryIndexService,
    MemoryEventsService,
    MemoryLockService,
    MemoryWriteService,
    MemoryReviewService,
  ],
  exports: [
    MemoryGitService,
    MemoryIndexService,
    MemoryEventsService,
    MemoryLockService,
    MemoryWriteService,
    MemoryReviewService,
  ],
})
export class MemoryModule {}
