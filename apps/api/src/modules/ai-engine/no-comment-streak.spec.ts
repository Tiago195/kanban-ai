import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectNoCommentStreak,
  iterationHasHumanFacingComment,
  trailingNoCommentStreak,
  type StreakIteration,
} from './no-comment-streak';

/**
 * US-OBS2-4 — testes PUROS do detector de no-comment streak (sem DB).
 *
 * Cobre o DOD:
 *   - abaixo do threshold → não anômalo; no/acima → anômalo;
 *   - um comentário reseta o streak;
 *   - edge cases: histórico vazio, exatamente o threshold, threshold=0 (off).
 */

/** Iteração SEM comentário voltado ao humano. */
const blank: StreakIteration = { summary: '', handoffNextStep: '', needsHuman: false };
/** Iteração COM comentário (summary preenchido). */
const withSummary: StreakIteration = { summary: 'fez X', handoffNextStep: '' };

function blanks(n: number): StreakIteration[] {
  return Array.from({ length: n }, () => ({ ...blank }));
}

test('iterationHasHumanFacingComment: summary não-vazio conta', () => {
  assert.equal(iterationHasHumanFacingComment({ summary: 'algo' }), true);
});

test('iterationHasHumanFacingComment: handoffNextStep não-vazio conta', () => {
  assert.equal(iterationHasHumanFacingComment({ handoffNextStep: 'próximo' }), true);
});

test('iterationHasHumanFacingComment: needsHuman conta', () => {
  assert.equal(iterationHasHumanFacingComment({ needsHuman: true }), true);
});

test('iterationHasHumanFacingComment: whitespace-only NÃO conta', () => {
  assert.equal(
    iterationHasHumanFacingComment({ summary: '   ', handoffNextStep: '\n\t' }),
    false,
  );
});

test('iterationHasHumanFacingComment: tudo vazio NÃO conta', () => {
  assert.equal(iterationHasHumanFacingComment(blank), false);
});

test('trailingNoCommentStreak: conta a partir do fim', () => {
  assert.equal(trailingNoCommentStreak([...blanks(3)]), 3);
});

test('trailingNoCommentStreak: um comentário no fim reseta para 0', () => {
  assert.equal(trailingNoCommentStreak([...blanks(5), withSummary]), 0);
});

test('trailingNoCommentStreak: só conta o streak TRAILING (comentário no meio corta)', () => {
  // [blank, blank, withSummary, blank, blank] → streak = 2 (só os do fim)
  const hist = [...blanks(2), withSummary, ...blanks(2)];
  assert.equal(trailingNoCommentStreak(hist), 2);
});

test('detectNoCommentStreak: abaixo do threshold → não anômalo', () => {
  const r = detectNoCommentStreak(blanks(9), { threshold: 10 });
  assert.deepEqual(r, { anomalous: false, streak: 9 });
});

test('detectNoCommentStreak: exatamente no threshold → anômalo', () => {
  const r = detectNoCommentStreak(blanks(10), { threshold: 10 });
  assert.deepEqual(r, { anomalous: true, streak: 10 });
});

test('detectNoCommentStreak: acima do threshold → anômalo', () => {
  const r = detectNoCommentStreak(blanks(15), { threshold: 10 });
  assert.deepEqual(r, { anomalous: true, streak: 15 });
});

test('detectNoCommentStreak: comentário recente reseta → não anômalo', () => {
  const r = detectNoCommentStreak([...blanks(20), withSummary], { threshold: 10 });
  assert.deepEqual(r, { anomalous: false, streak: 0 });
});

test('detectNoCommentStreak: histórico vazio → streak 0, não anômalo', () => {
  const r = detectNoCommentStreak([], { threshold: 10 });
  assert.deepEqual(r, { anomalous: false, streak: 0 });
});

test('detectNoCommentStreak: threshold 0 desliga a detecção', () => {
  const r = detectNoCommentStreak(blanks(50), { threshold: 0 });
  assert.equal(r.anomalous, false);
  assert.equal(r.streak, 50);
});

test('detectNoCommentStreak: threshold negativo desliga a detecção', () => {
  const r = detectNoCommentStreak(blanks(50), { threshold: -1 });
  assert.equal(r.anomalous, false);
});
