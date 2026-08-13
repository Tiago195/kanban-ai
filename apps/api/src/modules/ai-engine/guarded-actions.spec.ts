import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defineGuardedAction,
  runGuarded,
  GuardedActionDeniedError,
  GUARDED_ACTIONS,
  type GuardedActionContext,
  type GuardResult,
} from './guarded-actions';

/**
 * US-HARD4 — catálogo de ações guardadas (fail-closed allow|hold|deny) que
 * REUSA o HITL existente. Cobre:
 *   - allow  → `perform` roda, `ran=true`.
 *   - hold   → chama `ctx.escalate(reason)` (o adaptador HITL) e NÃO roda `perform`.
 *   - deny   → lança `GuardedActionDeniedError` (o chamador surfaça).
 *   - guard que lança → tratado como deny (fail-closed): `perform` NÃO roda.
 */

function makeCtx(): { ctx: GuardedActionContext; calls: Array<{ reason: string }> } {
  const calls: Array<{ reason: string }> = [];
  const ctx: GuardedActionContext = {
    escalate: (reason) => {
      calls.push({ reason });
    },
  };
  return { ctx, calls };
}

test('allow → perform roda e devolve o valor', async () => {
  const action = defineGuardedAction<'x', { n: number }>('x', () => ({ decision: 'allow' }));
  const { ctx, calls } = makeCtx();
  let ran = false;

  const res = await runGuarded(action, { n: 21 }, ctx, (input) => {
    ran = true;
    return input.n * 2;
  });

  assert.equal(ran, true);
  assert.equal(res.ran, true);
  if (res.ran) assert.equal(res.value, 42);
  assert.equal(calls.length, 0, 'allow não escala');
});

test('hold → chama escalate com o reason e NÃO roda perform', async () => {
  const reason = 'preciso de revisão humana';
  const action = defineGuardedAction<'x', unknown>('x', () => ({ decision: 'hold', reason }));
  const { ctx, calls } = makeCtx();
  let ran = false;

  const res = await runGuarded(action, {}, ctx, () => {
    ran = true;
    return 'commit';
  });

  assert.equal(ran, false, 'hold não pode rodar perform');
  assert.equal(res.ran, false);
  if (!res.ran) {
    assert.equal(res.held, true);
    assert.equal(res.reason, reason);
  }
  assert.equal(calls.length, 1, 'hold reusa o HITL exatamente uma vez');
  assert.equal(calls[0].reason, reason);
});

test('deny → lança GuardedActionDeniedError e NÃO roda perform', async () => {
  const action = defineGuardedAction<'danger', unknown>('danger', () => ({
    decision: 'deny',
    reason: 'ação proibida',
  }));
  const { ctx, calls } = makeCtx();
  let ran = false;

  await assert.rejects(
    () =>
      runGuarded(action, {}, ctx, () => {
        ran = true;
        return 'x';
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardedActionDeniedError);
      assert.equal(err.actionName, 'danger');
      assert.match(err.reason, /proibida/);
      return true;
    },
  );

  assert.equal(ran, false, 'deny nunca roda perform');
  assert.equal(calls.length, 0, 'deny não escala HITL');
});

test('guard que lança → tratado como deny (fail-closed), perform NÃO roda', async () => {
  const action = defineGuardedAction<'boom', unknown>('boom', (): GuardResult => {
    throw new Error('boom no guard');
  });
  const { ctx, calls } = makeCtx();
  let ran = false;

  await assert.rejects(
    () =>
      runGuarded(action, {}, ctx, () => {
        ran = true;
        return 'x';
      }),
    (err: unknown) => {
      assert.ok(err instanceof GuardedActionDeniedError, 'fail-closed vira deny tipado');
      assert.equal(err.actionName, 'boom');
      assert.match(err.reason, /fail-closed/);
      return true;
    },
  );

  assert.equal(ran, false, 'fail-closed nunca roda perform');
  assert.equal(calls.length, 0);
});

test('guard async também é aguardado (allow assíncrono)', async () => {
  const action = defineGuardedAction<'a', unknown>('a', async () => {
    await Promise.resolve();
    return { decision: 'allow' } as GuardResult;
  });
  const { ctx } = makeCtx();

  const res = await runGuarded(action, {}, ctx, () => 'ok');
  assert.equal(res.ran, true);
  if (res.ran) assert.equal(res.value, 'ok');
});

// --- catálogo real (autoCommit) ---

test('GUARDED_ACTIONS.autoCommit: opt-in off → allow (delega ao perform)', async () => {
  const { ctx, calls } = makeCtx();
  let ran = false;
  const res = await runGuarded(
    GUARDED_ACTIONS.autoCommit,
    { autoCommitEnabled: false, evidenceVerified: false, requireHumanApproval: true },
    ctx,
    () => {
      ran = true;
      return 'disabled-outcome';
    },
  );
  assert.equal(res.ran, true);
  assert.equal(ran, true);
  assert.equal(calls.length, 0);
});

test('GUARDED_ACTIONS.autoCommit: opt-in on + evidência não verificável → allow (skip benigno no perform)', async () => {
  const { ctx, calls } = makeCtx();
  let ran = false;
  const res = await runGuarded(
    GUARDED_ACTIONS.autoCommit,
    { autoCommitEnabled: true, evidenceVerified: false, requireHumanApproval: true },
    ctx,
    () => {
      ran = true;
      return 'not-verified';
    },
  );
  assert.equal(res.ran, true, 'skip benigno segue para o perform, não escala');
  assert.equal(ran, true);
  assert.equal(calls.length, 0);
});

test('GUARDED_ACTIONS.autoCommit: opt-in on + verificável + aprovação exigida → hold (HITL)', async () => {
  const { ctx, calls } = makeCtx();
  let ran = false;
  const res = await runGuarded(
    GUARDED_ACTIONS.autoCommit,
    { autoCommitEnabled: true, evidenceVerified: true, requireHumanApproval: true },
    ctx,
    () => {
      ran = true;
      return 'commit';
    },
  );
  assert.equal(res.ran, false);
  assert.equal(ran, false, 'não commita sem aprovação');
  assert.equal(calls.length, 1, 'segura via HITL');
  assert.match(calls[0].reason, /aprovação humana/);
});

test('GUARDED_ACTIONS.autoCommit: opt-in on + verificável + sem exigência → allow', async () => {
  const { ctx, calls } = makeCtx();
  const res = await runGuarded(
    GUARDED_ACTIONS.autoCommit,
    { autoCommitEnabled: true, evidenceVerified: true, requireHumanApproval: false },
    ctx,
    () => 'commit',
  );
  assert.equal(res.ran, true);
  if (res.ran) assert.equal(res.value, 'commit');
  assert.equal(calls.length, 0);
});
