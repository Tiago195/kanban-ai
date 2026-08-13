import { test } from 'node:test';
import assert from 'node:assert';
import {
  computeBackoffSeconds,
  nextAttemptState,
  INITIAL_STATE,
  BACKOFF_SCHEDULE_SECONDS,
  type CircuitBreakerState,
} from './circuit-breaker';

test('computeBackoffSeconds maps attempts to the schedule and clamps', () => {
  assert.strictEqual(computeBackoffSeconds(0), 0);
  assert.strictEqual(computeBackoffSeconds(1), 0);
  assert.strictEqual(computeBackoffSeconds(2), 10);
  assert.strictEqual(computeBackoffSeconds(3), 30);
  assert.strictEqual(computeBackoffSeconds(4), 120);
  assert.strictEqual(computeBackoffSeconds(5), 300);
  assert.strictEqual(computeBackoffSeconds(6), 900);
  // Clamp at the last schedule entry for out-of-range attempts.
  assert.strictEqual(computeBackoffSeconds(7), 900);
  assert.strictEqual(computeBackoffSeconds(99), 900);
});

test('computeBackoffSeconds treats invalid attempts as 0', () => {
  assert.strictEqual(computeBackoffSeconds(-1), 0);
  assert.strictEqual(computeBackoffSeconds(Number.NaN), 0);
});

test('backoff schedule matches the documented values', () => {
  assert.deepStrictEqual([...BACKOFF_SCHEDULE_SECONDS], [0, 0, 10, 30, 120, 300, 900]);
});

test('nextAttemptState increments when previous run did not shut down cleanly within window', () => {
  const now = 10_000;
  const prev: CircuitBreakerState = { attempt: 2, timestamp: now - 1_000 };
  const next = nextAttemptState(prev, false, now, 60_000);
  assert.strictEqual(next.attempt, 3);
  assert.strictEqual(next.timestamp, now);
});

test('nextAttemptState resets when the previous shutdown was clean', () => {
  const now = 10_000;
  const prev: CircuitBreakerState = { attempt: 5, timestamp: now - 1_000 };
  const next = nextAttemptState(prev, true, now, 60_000);
  assert.strictEqual(next.attempt, 0);
  assert.strictEqual(next.timestamp, now);
});

test('nextAttemptState resets when dirty state is older than the recovery window', () => {
  const now = 1_000_000;
  const prev: CircuitBreakerState = { attempt: 3, timestamp: now - 120_000 };
  const next = nextAttemptState(prev, false, now, 60_000);
  assert.strictEqual(next.attempt, 0);
});

test('nextAttemptState starts at 0 from the initial state', () => {
  const now = 5_000;
  const next = nextAttemptState(INITIAL_STATE, false, now, 60_000);
  assert.strictEqual(next.attempt, 0);
  assert.strictEqual(next.timestamp, now);
});

test('nextAttemptState with windowMs=0 disables the stale-by-window reset', () => {
  const now = 1_000_000;
  const prev: CircuitBreakerState = { attempt: 2, timestamp: 1 };
  const next = nextAttemptState(prev, false, now, 0);
  assert.strictEqual(next.attempt, 3);
});
