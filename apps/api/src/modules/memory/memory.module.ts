import { Global, Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { MemoryBootstrapService } from './memory-bootstrap.service';
import { MemoryEventsService } from './memory-events.service';
import { MemoryPolicyService } from './memory-policy.service';
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
 * - **Bootstrap** (`MemoryBootstrapService`, EP-84): semeia 1 neurônio por
 *   módulo do repo-alvo (varredura idempotente) e criação lazy sob demanda.
 *
 * É `@Global` (como `workspaces`) para que consumidores (MCP, gateway WS)
 * injetem os serviços sem reimportar o módulo.
 */
@Global()
@Module({
  controllers: [MemoryController],
  providers: [
    MemoryGitService,
    MemoryIndexService,
    MemoryEventsService,
    MemoryLockService,
    MemoryWriteService,
    MemoryReviewService,
    MemoryPolicyService,
    MemoryBootstrapService,
  ],
  exports: [
    MemoryGitService,
    MemoryIndexService,
    MemoryEventsService,
    MemoryLockService,
    MemoryWriteService,
    MemoryReviewService,
    MemoryPolicyService,
    MemoryBootstrapService,
  ],
})
export class MemoryModule {}
