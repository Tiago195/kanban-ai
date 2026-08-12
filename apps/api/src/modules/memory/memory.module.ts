import { Global, Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { MemoryAuthGuard } from './memory-auth.guard';
import { MemoryBootstrapService } from './memory-bootstrap.service';
import { MemoryEventsService } from './memory-events.service';
import { MemoryGcService } from './memory-gc.service';
import { MemoryPolicyService } from './memory-policy.service';
import { MemoryGitService } from './memory-git.service';
import { MemoryIndexService } from './memory-index.service';
import { MemoryLockService } from './memory-lock.service';
import { MemoryReviewService } from './memory-review.service';
import { MemorySchedulerService } from './memory-scheduler.service';
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
 * - **Garbage collection** (`MemoryGcService`, EP-85): jobs de baixa prioridade
 *   — arquiva neurônios stale, sumariza histórico longo e poda ramos efêmeros.
 * - **Scheduler** (`MemorySchedulerService`, EP-B): tick periódico que dispara
 *   `expireStale` (locks) e a garbage collection em cadência (setInterval puro).
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
    MemoryGcService,
    MemorySchedulerService,
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
    MemoryGcService,
    MemoryAuthGuard,
  ],
})
export class MemoryModule {}
