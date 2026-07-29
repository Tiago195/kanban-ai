import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Módulo de tempo real. `RealtimeService` é global para que qualquer serviço de
 * domínio possa emitir eventos WS sem acoplamento.
 */
@Global()
@Module({
  providers: [RealtimeService, RealtimeGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
