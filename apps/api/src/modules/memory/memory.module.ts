import { Global, Module } from '@nestjs/common';
import { MemoryGitService } from './memory-git.service';

/**
 * Módulo da **memória** (ADR-0027, Camada 1 — git como fonte da verdade).
 *
 * Expõe o `MemoryGitService`, responsável por provisionar o **bare git
 * repository** da memória num volume dedicado. É `@Global` (como `workspaces`)
 * para que futuros consumidores (Camada 2, MCP) injetem o serviço sem reimportar
 * o módulo.
 */
@Global()
@Module({
  providers: [MemoryGitService],
  exports: [MemoryGitService],
})
export class MemoryModule {}
