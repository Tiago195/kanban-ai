import { Global, Module } from '@nestjs/common';
import { MemoryGitService } from './memory-git.service';
import { MemoryIndexService } from './memory-index.service';
import { MemoryLockService } from './memory-lock.service';

/**
 * Módulo da **memória** (ADR-0027).
 *
 * - **Camada 1** (`MemoryGitService`): git como fonte da verdade — provisiona o
 *   bare repo e faz read/write/merge/diff/history de neurônios.
 * - **Camada 2** (`MemoryIndexService`): índice Postgres derivado/descartável —
 *   reindex/rebuild/query e a ordem de escrita git → índice.
 * - **Locks advisory + presença** (`MemoryLockService`, EP-78): lease com
 *   TTL/heartbeat, release e anti-deadlock sobre o índice.
 *
 * É `@Global` (como `workspaces`) para que consumidores (MCP, gateway WS)
 * injetem os serviços sem reimportar o módulo.
 */
@Global()
@Module({
  providers: [MemoryGitService, MemoryIndexService, MemoryLockService],
  exports: [MemoryGitService, MemoryIndexService, MemoryLockService],
})
export class MemoryModule {}
