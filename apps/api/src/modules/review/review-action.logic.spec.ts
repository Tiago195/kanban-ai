import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideReviewFlag, reviewActionKey } from './review-action.logic';

/**
 * US-OBS2-4 — testes PUROS do rate-limit + snooze de review actions (sem DB).
 *
 * Cobre o DOD:
 *   - suprimido dentro do cooldown;
 *   - suprimido enquanto snoozed;
 *   - permitido após o cooldown expirar;
 *   - permitido após o snooze expirar;
 *   - snooze tem precedência sobre cooldown;
 *   - cooldown=0 desliga o rate-limit;
 *   - sem estado prévio → permitido.
 */

const HOUR = 3_600_000;
const NOW = 1_000_000_000;

test('sem estado prévio → permite (primeira flag)', () => {
  const d = decideReviewFlag({ nowMs: NOW, cooldownMs: HOUR, state: null });
  assert.deepEqual(d, { shouldFlag: true });
});

test('dentro do cooldown → suprime (reason=cooldown)', () => {
  const d = decideReviewFlag({
    nowMs: NOW,
    cooldownMs: HOUR,
    state: { lastFlaggedAtMs: NOW - HOUR / 2 },
  });
  assert.deepEqual(d, { shouldFlag: false, reason: 'cooldown' });
});

test('após o cooldown expirar → permite', () => {
  const d = decideReviewFlag({
    nowMs: NOW,
    cooldownMs: HOUR,
    state: { lastFlaggedAtMs: NOW - HOUR - 1 },
  });
  assert.deepEqual(d, { shouldFlag: true });
});

test('exatamente no limite do cooldown → permite (>= cooldown)', () => {
  const d = decideReviewFlag({
    nowMs: NOW,
    cooldownMs: HOUR,
    state: { lastFlaggedAtMs: NOW - HOUR },
  });
  assert.deepEqual(d, { shouldFlag: true });
});

test('enquanto snoozed → suprime (reason=snoozed)', () => {
  const d = decideReviewFlag({
    nowMs: NOW,
    cooldownMs: HOUR,
    state: { lastFlaggedAtMs: NOW - HOUR - 1, snoozedUntilMs: NOW + HOUR },
  });
  assert.deepEqual(d, { shouldFlag: false, reason: 'snoozed' });
});

test('snooze expirado → não suprime por snooze (permite se fora do cooldown)', () => {
  const d = decideReviewFlag({
    nowMs: NOW,
    cooldownMs: HOUR,
    state: { lastFlaggedAtMs: NOW - HOUR - 1, snoozedUntilMs: NOW - 1 },
  });
  assert.deepEqual(d, { shouldFlag: true });
});

test('snooze tem precedência sobre cooldown', () => {
  // snoozed E dentro do cooldown → reason deve ser snoozed (checado primeiro).
  const d = decideReviewFlag({
    nowMs: NOW,
    cooldownMs: HOUR,
    state: { lastFlaggedAtMs: NOW - 10, snoozedUntilMs: NOW + HOUR },
  });
  assert.deepEqual(d, { shouldFlag: false, reason: 'snoozed' });
});

test('snooze exatamente em nowMs → NÃO suprime (until > now)', () => {
  const d = decideReviewFlag({
    nowMs: NOW,
    cooldownMs: 0,
    state: { snoozedUntilMs: NOW },
  });
  assert.deepEqual(d, { shouldFlag: true });
});

test('cooldownMs=0 desliga o rate-limit', () => {
  const d = decideReviewFlag({
    nowMs: NOW,
    cooldownMs: 0,
    state: { lastFlaggedAtMs: NOW - 1 },
  });
  assert.deepEqual(d, { shouldFlag: true });
});

test('reviewActionKey: chave estável por (card, kind)', () => {
  assert.equal(reviewActionKey('card-1', 'no_comment_streak'), 'card-1::no_comment_streak');
});
