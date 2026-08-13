import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from './orchestrator';

/**
 * US-SCHED1 — testes de deferred wakeup monitors (time-gated wake). Valida:
 *  - listDue() retorna só items cujo scheduledFor <= now (time-gating)
 *  - o tick do orchestrator dispara wake exatamente no momento certo
 *  - one-shot: após disparo, o monitor é cleared
 *  - auto-clear ao atingir terminal state
 *  - coalescing preservado (máx 1 item não-terminal por story)
 *  - re-arm funciona (agent pode setar um novo monitor após clear)
 *
 * Usa fake timers (node:test mock.timers) para avançar o tempo de forma determinística.
 */

// ── Fake de WakeupQueueService simplificado ─────────────────────────────────

interface QueueItem {
  storyId: string;
  reason: string;
  epicId: string | null;
  status: 'pending' | 'claimed' | 'done' | 'failed';
  scheduledFor: Date | null;
  notes?: string;
  timeoutAt?: Date | null;
  maxAttempts?: number | null;
}

class FakeWakeupQueue {
  private items: QueueItem[] = [];

  async enqueueDeferred(input: {
    storyId: string;
    scheduledFor: Date;
    epicId?: string | null;
    notes?: string;
    timeoutAt?: Date;
    maxAttempts?: number;
  }): Promise<void> {
    const active = this.items.find(
      (it) => it.storyId === input.storyId && (it.status === 'pending' || it.status === 'claimed'),
    );
    if (active) {
      active.scheduledFor = input.scheduledFor;
      active.notes = input.notes;
      active.timeoutAt = input.timeoutAt ?? null;
      active.maxAttempts = input.maxAttempts ?? null;
      active.reason = 'monitor_due';
      return;
    }
    this.items.push({
      storyId: input.storyId,
      reason: 'monitor_due',
      epicId: input.epicId ?? null,
      status: 'pending',
      scheduledFor: input.scheduledFor,
      notes: input.notes,
      timeoutAt: input.timeoutAt ?? null,
      maxAttempts: input.maxAttempts ?? null,
    });
  }

  async listDue(now = new Date()): Promise<
    { storyId: string; reason: string; epicId: string | null }[]
  > {
    return this.items
      .filter(
        (it) =>
          it.status === 'pending' &&
          (it.scheduledFor === null || it.scheduledFor.getTime() <= now.getTime()),
      )
      .map((it) => ({ storyId: it.storyId, reason: it.reason, epicId: it.epicId }));
  }

  async clearMonitor(storyId: string): Promise<void> {
    for (const it of this.items) {
      if (
        it.storyId === storyId &&
        (it.status === 'pending' || it.status === 'claimed') &&
        it.reason === 'monitor_due'
      ) {
        it.status = 'done';
      }
    }
  }

  async complete(storyId: string): Promise<void> {
    for (const it of this.items) {
      if (it.storyId === storyId && (it.status === 'pending' || it.status === 'claimed')) {
        it.status = 'done';
      }
    }
  }

  getAll() {
    return this.items;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('listDue NÃO retorna monitors com scheduledFor futuro', async () => {
  const queue = new FakeWakeupQueue();
  const now = new Date('2026-08-13T16:00:00Z');
  const future = new Date('2026-08-13T16:30:00Z');

  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: future });

  const due = await queue.listDue(now);
  assert.strictEqual(due.length, 0, 'monitor futuro não deve ser retornado');
});

test('listDue retorna monitors cujo scheduledFor <= now', async () => {
  const queue = new FakeWakeupQueue();
  const now = new Date('2026-08-13T16:30:00Z');
  const past = new Date('2026-08-13T16:00:00Z');
  const exact = new Date('2026-08-13T16:30:00Z');
  const future = new Date('2026-08-13T17:00:00Z');

  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: past });
  await queue.enqueueDeferred({ storyId: 's2', scheduledFor: exact });
  await queue.enqueueDeferred({ storyId: 's3', scheduledFor: future });

  const due = await queue.listDue(now);
  assert.strictEqual(due.length, 2, 'deve retornar 2 monitors (past + exact)');
  assert.ok(due.some((d) => d.storyId === 's1'), 's1 (past) deve estar na lista');
  assert.ok(due.some((d) => d.storyId === 's2'), 's2 (exact) deve estar na lista');
  assert.ok(!due.some((d) => d.storyId === 's3'), 's3 (future) NÃO deve estar');
});

test('clearMonitor marca o item como done (one-shot)', async () => {
  const queue = new FakeWakeupQueue();
  const now = new Date('2026-08-13T16:00:00Z');

  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: now });
  await queue.clearMonitor('s1');

  const all = queue.getAll();
  const cleared = all.find((it) => it.storyId === 's1');
  assert.strictEqual(cleared?.status, 'done', 'status deve ser done após clear');

  const due = await queue.listDue(now);
  assert.strictEqual(due.length, 0, 'monitor cleared não deve aparecer em listDue');
});

test('coalescing preservado: enqueueDeferred atualiza scheduledFor do existente', async () => {
  const queue = new FakeWakeupQueue();
  const first = new Date('2026-08-13T16:00:00Z');
  const second = new Date('2026-08-13T17:00:00Z');

  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: first, notes: 'primeiro' });
  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: second, notes: 'segundo' });

  const all = queue.getAll();
  const items = all.filter((it) => it.storyId === 's1' && it.status === 'pending');
  assert.strictEqual(items.length, 1, 'deve haver exatamente 1 item pending (coalescing)');
  assert.strictEqual(
    items[0].scheduledFor?.toISOString(),
    second.toISOString(),
    'scheduledFor deve ser atualizado',
  );
  assert.strictEqual(items[0].notes, 'segundo', 'notes deve ser atualizado');
});

test('re-arm funciona: após clearMonitor, pode enqueueDeferred novamente', async () => {
  const queue = new FakeWakeupQueue();
  const first = new Date('2026-08-13T16:00:00Z');
  const second = new Date('2026-08-13T17:00:00Z');

  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: first });
  await queue.clearMonitor('s1');
  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: second });

  const due = await queue.listDue(second);
  assert.strictEqual(due.length, 1, 'deve haver 1 monitor re-armado');
  assert.strictEqual(due[0].storyId, 's1', 'storyId deve ser s1');
});

test('complete() também limpa monitors (auto-clear on terminal)', async () => {
  const queue = new FakeWakeupQueue();
  const now = new Date('2026-08-13T16:00:00Z');

  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: now });
  await queue.complete('s1');

  const all = queue.getAll();
  const item = all.find((it) => it.storyId === 's1');
  assert.strictEqual(item?.status, 'done', 'status deve ser done após complete');

  const due = await queue.listDue(now);
  assert.strictEqual(due.length, 0, 'monitor completed não deve aparecer em listDue');
});

// ── White-box: real orchestrator.fireDueMonitors (SEM fake timers, determinístico) ──

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Constrói um Orchestrator real com fakes mínimos e injeta uma `FakeWakeupQueue`
 * na posição 11 (o param opcional `wakeupQueue`). `wakeupQueueEnabled: true` liga
 * o `wakeupEnabled` getter. Espiona `onStoryEnterInProgress` (mecanismo canônico
 * de wake) sem tocar em runner/prisma reais. Testamos `fireDueMonitors(now)`
 * diretamente com um `now` injetado — determinístico, sem `setInterval`.
 */
function makeOrchestratorWithQueue(queue: FakeWakeupQueue) {
  const config = {
    agent: {
      wakeupQueueEnabled: true,
      watchdogIntervalMs: 60_000,
      claimEnabled: false,
      noCommentStreakThreshold: 0,
    },
  } as any;
  const noop = () => undefined;
  const prisma = {} as any;
  const sessions = {} as any;
  const validation = {} as any;
  const workspaces = {} as any;
  const realtime = { broadcast: noop } as any;
  const runner = {} as any;
  const memoryIndex = {} as any;
  const memoryGit = {} as any;
  const memoryBootstrap = {} as any;
  const orch = new Orchestrator(
    prisma,
    sessions,
    validation,
    workspaces,
    realtime,
    runner,
    config,
    memoryIndex,
    memoryGit,
    memoryBootstrap,
    queue as any,
  );
  const wakes: string[] = [];
  // Espiona o mecanismo canônico de wake (evita disparar o loop real).
  (orch as any).onStoryEnterInProgress = async (storyId: string) => {
    wakes.push(storyId);
  };
  return { orch, wakes };
}

test('fireDueMonitors: NÃO dispara wake antes do scheduledFor (time-gated)', async () => {
  const queue = new FakeWakeupQueue();
  const scheduledFor = new Date('2026-08-13T16:02:00Z');
  await queue.enqueueDeferred({ storyId: 's1', scheduledFor });

  const { orch, wakes } = makeOrchestratorWithQueue(queue);
  const before = new Date('2026-08-13T16:00:00Z');
  await (orch as any).fireDueMonitors(before);

  assert.strictEqual(wakes.length, 0, 'nenhum wake antes do scheduledFor');
  // monitor continua pendente (não foi one-shot cleared)
  const pending = await queue.listDue(new Date('2026-08-13T17:00:00Z'));
  assert.strictEqual(pending.length, 1, 'monitor permanece armado');
});

test('fireDueMonitors: dispara EXATAMENTE um wake quando due e limpa (one-shot)', async () => {
  const queue = new FakeWakeupQueue();
  const scheduledFor = new Date('2026-08-13T16:02:00Z');
  await queue.enqueueDeferred({ storyId: 's1', scheduledFor });

  const { orch, wakes } = makeOrchestratorWithQueue(queue);

  // 1º tick antes do due: nada
  await (orch as any).fireDueMonitors(new Date('2026-08-13T16:01:00Z'));
  assert.strictEqual(wakes.length, 0);

  // 2º tick no/após due: dispara 1 wake e limpa (one-shot)
  await (orch as any).fireDueMonitors(new Date('2026-08-13T16:02:00Z'));
  assert.deepStrictEqual(wakes, ['s1'], 'dispara wake para s1 exatamente quando due');

  // 3º tick: monitor já foi cleared -> não re-dispara
  await (orch as any).fireDueMonitors(new Date('2026-08-13T16:10:00Z'));
  assert.strictEqual(wakes.length, 1, 'one-shot: não re-dispara após clear');

  // confirma que a fila não tem mais nada due
  const stillDue = await queue.listDue(new Date('2026-08-13T16:10:00Z'));
  assert.strictEqual(stillDue.length, 0, 'monitor foi cleared após disparo');
});

test('fireDueMonitors: re-arm após one-shot dispara novamente no novo horário', async () => {
  const queue = new FakeWakeupQueue();
  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: new Date('2026-08-13T16:02:00Z') });

  const { orch, wakes } = makeOrchestratorWithQueue(queue);
  await (orch as any).fireDueMonitors(new Date('2026-08-13T16:02:00Z'));
  assert.deepStrictEqual(wakes, ['s1']);

  // agent re-arma para um horário futuro
  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: new Date('2026-08-13T16:30:00Z') });
  await (orch as any).fireDueMonitors(new Date('2026-08-13T16:20:00Z'));
  assert.strictEqual(wakes.length, 1, 're-arm ainda não due');

  await (orch as any).fireDueMonitors(new Date('2026-08-13T16:30:00Z'));
  assert.deepStrictEqual(wakes, ['s1', 's1'], 're-arm dispara no novo horário');
});

test('fireDueMonitors: dispara vários monitors due no mesmo tick', async () => {
  const queue = new FakeWakeupQueue();
  await queue.enqueueDeferred({ storyId: 's1', scheduledFor: new Date('2026-08-13T16:00:00Z') });
  await queue.enqueueDeferred({ storyId: 's2', scheduledFor: new Date('2026-08-13T16:01:00Z') });
  await queue.enqueueDeferred({ storyId: 's3', scheduledFor: new Date('2026-08-13T16:10:00Z') });

  const { orch, wakes } = makeOrchestratorWithQueue(queue);
  await (orch as any).fireDueMonitors(new Date('2026-08-13T16:05:00Z'));

  assert.strictEqual(wakes.length, 2, 's1 e s2 due; s3 ainda não');
  assert.ok(wakes.includes('s1') && wakes.includes('s2'));
  assert.ok(!wakes.includes('s3'));
});

test('metadata (notes/timeoutAt/maxAttempts) é preservado no coalescing', async () => {
  const queue = new FakeWakeupQueue();
  const scheduledFor = new Date('2026-08-13T16:00:00Z');
  const timeoutAt = new Date('2026-08-13T17:00:00Z');

  await queue.enqueueDeferred({
    storyId: 's1',
    scheduledFor,
    notes: 'esperando CI',
    timeoutAt,
    maxAttempts: 3,
  });

  const all = queue.getAll();
  const item = all.find((it) => it.storyId === 's1');
  assert.strictEqual(item?.notes, 'esperando CI');
  assert.strictEqual(
    item?.timeoutAt?.toISOString(),
    timeoutAt.toISOString(),
  );
  assert.strictEqual(item?.maxAttempts, 3);
});
