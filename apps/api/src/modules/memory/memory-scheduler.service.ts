import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { MemoryGcService } from './memory-gc.service';
import { MemoryLockService } from './memory-lock.service';

/**
 * **Scheduler dos jobs de manutenção da colmeia** (ADR-0027, **EP-B**).
 *
 * Os métodos de manutenção (auto-release de leases vencidos e garbage
 * collection) existem nos serviços de domínio, mas nada os dispara em cadência.
 * Este provider é o **tick** que os aciona periodicamente, DENTRO do módulo
 * `memory` (o AGENTS.md antigo dizia que o agendamento vivia fora — não mais).
 *
 * **Sem `@nestjs/schedule`** (não está no projeto): usa `setInterval`/
 * `clearInterval` puros, ligados ao ciclo de vida do Nest (`OnModuleInit`/
 * `OnModuleDestroy`).
 *
 * **Defensivo:** cada job roda dentro do seu próprio `try/catch`; uma exceção
 * NUNCA derruba o processo nem para o scheduler — vira `logger.warn`.
 *
 * **Testável:** os métodos de "tick" (`sweepLocks`, `runGc`) são públicos e
 * podem ser chamados direto pelos specs, sem depender de timer real.
 */
@Injectable()
export class MemorySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemorySchedulerService.name);

  /** Handles dos timers ativos, limpos no shutdown. */
  private readonly timers: NodeJS.Timeout[] = [];

  /**
   * Guard de reentrância do GC (US-B2): impede que dois ticks se sobreponham
   * quando um job demora mais que o intervalo.
   */
  private gcRunning = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly memoryLock: MemoryLockService,
    private readonly memoryGc: MemoryGcService,
  ) {}

  onModuleInit(): void {
    const { schedulerEnabled, lockSweepIntervalMs, gcIntervalMs } = this.config.memory;
    if (!schedulerEnabled) {
      this.logger.log('Scheduler da memória desligado (MEMORY_SCHEDULER_ENABLED=false).');
      return;
    }

    this.timers.push(
      this.schedule(lockSweepIntervalMs, () => this.sweepLocks()),
      this.schedule(gcIntervalMs, () => this.runGc()),
    );
    this.logger.log(
      `Scheduler da memória iniciado (lockSweep=${lockSweepIntervalMs}ms, gc=${gcIntervalMs}ms).`,
    );
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /**
   * US-B1 — tick de auto-release de leases vencidos. Envolve `expireStale` em
   * try/catch: uma falha vira `warn` e nunca propaga nem para o scheduler.
   */
  async sweepLocks(): Promise<void> {
    try {
      this.logger.debug('sweepLocks: varredura de leases vencidos iniciada.');
      const released = await this.memoryLock.expireStale();
      if (released) {
        this.logger.log(`sweepLocks: ${released} lease(s) vencido(s) auto-liberado(s).`);
      } else {
        this.logger.debug('sweepLocks: nenhum lease vencido.');
      }
    } catch (err) {
      this.logger.warn(`sweepLocks falhou (ignorado, scheduler segue): ${asMessage(err)}`);
    }
  }

  /**
   * US-B2 — tick de garbage collection (reentrante, sem sobreposição). O guard
   * `gcRunning` impede que um novo tick comece enquanto o anterior ainda roda.
   *
   * Só dispara os jobs que NÃO exigem um `repoPath`/neuronPath: hoje isso é
   * `pruneEphemeralBranches()`. `sweepStale({ repoPath })` e
   * `summarizeHistory(neuronPath)` precisam de um alvo que não é conhecido
   * globalmente — não são invocados aqui (não inventamos um repo-alvo). Se/quando
   * um repo-alvo global for configurado, este método pode passar a chamá-los.
   */
  async runGc(): Promise<void> {
    if (this.gcRunning) {
      this.logger.debug('runGc: ciclo anterior ainda em execução — skip (guard de reentrância).');
      return;
    }
    this.gcRunning = true;
    this.logger.debug('runGc: ciclo de garbage collection iniciado.');
    try {
      try {
        const pruned = await this.memoryGc.pruneEphemeralBranches();
        if (pruned.length) {
          this.logger.log(`runGc: ${pruned.length} ramo(s) efêmero(s) podado(s).`);
        }
      } catch (err) {
        this.logger.warn(`runGc/pruneEphemeralBranches falhou (ignorado): ${asMessage(err)}`);
      }
      this.logger.debug('runGc: ciclo de garbage collection concluído.');
    } finally {
      this.gcRunning = false;
    }
  }

  /**
   * Agenda um tick periódico defensivo: o callback é chamado a cada `intervalMs`
   * e um `throw` nele nunca escapa (cada job já se protege). `unref` evita que o
   * timer segure o event loop no shutdown.
   */
  private schedule(intervalMs: number, tick: () => Promise<void> | void): NodeJS.Timeout {
    const handle = setInterval(() => {
      void Promise.resolve()
        .then(tick)
        .catch((err) => this.logger.warn(`tick falhou (ignorado): ${asMessage(err)}`));
    }, intervalMs);
    handle.unref?.();
    return handle;
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
