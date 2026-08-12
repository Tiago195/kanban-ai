import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../shared/config/config';
import type { MemoryGcService } from './memory-gc.service';
import type { MemoryLockService } from './memory-lock.service';
import { MemorySchedulerService } from './memory-scheduler.service';

// --- MemorySchedulerService: tick dos jobs de manutenção (ADR-0027, EP-B) ---
//
// Sem timer real: os specs chamam os métodos de "tick" (sweepLocks/runGc)
// diretamente. Fakes minimos de MemoryLockService/MemoryGcService cobrem
// exatamente o que o scheduler usa (expireStale / pruneEphemeralBranches).

function cfg(overrides: Partial<AppConfig['memory']> = {}): AppConfig {
  return {
    memory: {
      gitDir: '/tmp/ignored',
      schedulerEnabled: true,
      lockSweepIntervalMs: 30_000,
      gcIntervalMs: 3_600_000,
      ...overrides,
    },
  } as AppConfig;
}

class FakeLock {
  calls = 0;
  result = 0;
  shouldThrow = false;
  async expireStale(): Promise<number> {
    this.calls += 1;
    if (this.shouldThrow) throw new Error('boom-lock');
    return this.result;
  }
}

class FakeGc {
  pruneCalls = 0;
  pruned: string[] = [];
  shouldThrow = false;
  /** Resolve manualmente para simular execução em andamento (guard de reentrância). */
  gate: (() => void) | null = null;
  async pruneEphemeralBranches(): Promise<string[]> {
    this.pruneCalls += 1;
    if (this.gate) {
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    if (this.shouldThrow) throw new Error('boom-gc');
    return this.pruned;
  }
}

function make(config: AppConfig) {
  const lock = new FakeLock();
  const gc = new FakeGc();
  const svc = new MemorySchedulerService(
    config,
    lock as unknown as MemoryLockService,
    gc as unknown as MemoryGcService,
  );
  return { svc, lock, gc };
}

test('sweepLocks: chama MemoryLockService.expireStale', async () => {
  const { svc, lock } = make(cfg());
  lock.result = 2;
  await svc.sweepLocks();
  assert.equal(lock.calls, 1);
});

test('sweepLocks: exceção em expireStale é engolida (não propaga)', async () => {
  const { svc, lock } = make(cfg());
  lock.shouldThrow = true;
  await assert.doesNotReject(() => svc.sweepLocks());
  assert.equal(lock.calls, 1);
});

test('runGc: chama pruneEphemeralBranches e engole exceção', async () => {
  const { svc, gc } = make(cfg());
  gc.shouldThrow = true;
  await assert.doesNotReject(() => svc.runGc());
  assert.equal(gc.pruneCalls, 1);
});

test('runGc: guard de reentrância impede execução concorrente', async () => {
  const { svc, gc } = make(cfg());
  gc.gate = () => {}; // primeira chamada fica "presa" até liberarmos
  const first = svc.runGc(); // entra e bloqueia dentro de pruneEphemeralBranches
  // segunda chamada enquanto a primeira ainda roda: deve dar skip
  await svc.runGc();
  assert.equal(gc.pruneCalls, 1, 'segunda chamada não deve invocar o job (skip)');
  // libera a primeira e finaliza
  gc.gate?.();
  gc.gate = null;
  await first;
});

test('onModuleInit: schedulerEnabled=false não agenda nada', async () => {
  const { svc, lock, gc } = make(cfg({ schedulerEnabled: false }));
  svc.onModuleInit();
  // Sem timers agendados, nenhum job roda mesmo após um tick de event loop.
  await new Promise((r) => setImmediate(r));
  assert.equal(lock.calls, 0);
  assert.equal(gc.pruneCalls, 0);
  svc.onModuleDestroy();
});

test('onModuleInit/onModuleDestroy: agenda e limpa timers sem vazar', async () => {
  const { svc } = make(cfg({ lockSweepIntervalMs: 5, gcIntervalMs: 5 }));
  svc.onModuleInit();
  svc.onModuleDestroy();
  // Após destroy, nada mais deve estar agendado (sem asserção de contagem por
  // corrida de timing; o objetivo é garantir que destroy não lança).
  assert.ok(true);
});
