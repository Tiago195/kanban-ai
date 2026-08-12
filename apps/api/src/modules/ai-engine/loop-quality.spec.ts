import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVerifiableEvidence, minimumArtifactSatisfied } from '@kanban-ai/shared';
import type { StructuredEvidence } from '@kanban-ai/shared';
import {
  evidenceToString,
  textSimilarity,
  isThrashing,
  type ThrashSample,
} from './loop-helpers';

// --- #6: gate de `done` com evidência estruturada verificável ---

test('isVerifiableEvidence: string livre nunca é verificável', () => {
  assert.equal(isVerifiableEvidence('rodei os testes, tudo ok'), false);
  assert.equal(isVerifiableEvidence(''), false);
  assert.equal(isVerifiableEvidence(null), false);
  assert.equal(isVerifiableEvidence(undefined), false);
});

test('isVerifiableEvidence: estruturada sem check passado NÃO fecha done', () => {
  const ev: StructuredEvidence = {
    checks: [{ name: 'test', passed: false, output: 'falhou' }],
  };
  assert.equal(isVerifiableEvidence(ev), false);
});

test('isVerifiableEvidence: estruturada com ao menos um check passado fecha done', () => {
  const ev: StructuredEvidence = {
    checks: [
      { name: 'lint', passed: false },
      { name: 'test', passed: true, output: '10 passed' },
    ],
    filesChanged: ['src/a.ts'],
  };
  assert.equal(isVerifiableEvidence(ev), true);
});

test('isVerifiableEvidence: estruturada com checks vazio NÃO é verificável', () => {
  assert.equal(isVerifiableEvidence({ checks: [] }), false);
});

test('evidenceToString: serializa estruturada de forma legível', () => {
  const ev: StructuredEvidence = {
    checks: [
      { name: 'test', passed: true, output: '10 passed' },
      { name: 'lint', passed: false },
    ],
    filesChanged: ['src/a.ts', 'src/b.ts'],
    note: 'pronto',
  };
  const s = evidenceToString(ev);
  assert.match(s, /\[ok\] test: 10 passed/);
  assert.match(s, /\[x\] lint/);
  assert.match(s, /arquivos: src\/a\.ts, src\/b\.ts/);
  assert.match(s, /pronto/);
});

test('evidenceToString: string passa direto (trim)', () => {
  assert.equal(evidenceToString('  ok  '), 'ok');
  assert.equal(evidenceToString(undefined), '');
});

// --- #3: anti-thrash (similaridade + detecção) ---

test('textSimilarity: textos idênticos = 1', () => {
  assert.equal(textSimilarity('corrigir o bug do parser', 'corrigir o bug do parser'), 1);
});

test('textSimilarity: dois vazios = 1, um vazio = 0', () => {
  assert.equal(textSimilarity('', ''), 1);
  assert.equal(textSimilarity('algo', ''), 0);
});

test('textSimilarity: textos totalmente diferentes ~0', () => {
  const sim = textSimilarity('implementar login', 'refatorar css do rodape');
  assert.ok(sim < 0.2, `esperava baixa similaridade, veio ${sim}`);
});

test('isThrashing: precisa de ao menos 2 amostras', () => {
  const one: ThrashSample[] = [{ summary: 'a', nextStep: 'b' }];
  assert.equal(isThrashing(one, 0.9, 2), false);
  assert.equal(isThrashing([], 0.9, 2), false);
});

test('isThrashing: iterações quase idênticas => travado', () => {
  const samples: ThrashSample[] = [
    { summary: 'tentando corrigir o teste que falha no parser', nextStep: 'rodar npm test' },
    { summary: 'tentando corrigir o teste que falha no parser', nextStep: 'rodar npm test' },
  ];
  assert.equal(isThrashing(samples, 0.9, 2), true);
});

test('isThrashing: progresso real (textos distintos) => não travado', () => {
  const samples: ThrashSample[] = [
    { summary: 'criei o modulo de auth', nextStep: 'adicionar rota de login' },
    { summary: 'adicionei a rota de login', nextStep: 'escrever testes de integracao do fluxo' },
  ];
  assert.equal(isThrashing(samples, 0.9, 2), false);
});

test('isThrashing: janela só olha as últimas N amostras', () => {
  const samples: ThrashSample[] = [
    { summary: 'passo um totalmente diferente', nextStep: 'x' },
    { summary: 'iteracao repetida identica aqui', nextStep: 'rodar build' },
    { summary: 'iteracao repetida identica aqui', nextStep: 'rodar build' },
  ];
  assert.equal(isThrashing(samples, 0.9, 2), true);
});

// --- US-ROB1: artefato mínimo por classe de resultado ---

test('minimumArtifactSatisfied: code-change com diff não-vazio => ok (null)', () => {
  assert.equal(
    minimumArtifactSatisfied({
      resultClass: 'code-change',
      evidence: null,
      diff: 'diff --git a/x b/x\n+linha',
      flowFilesPresent: false,
    }),
    null,
  );
});

test('minimumArtifactSatisfied: code-change com diff vazio => problema', () => {
  const p = minimumArtifactSatisfied({
    resultClass: 'code-change',
    evidence: null,
    diff: '   ',
    flowFilesPresent: true,
  });
  assert.ok(p);
  assert.match(p!.title, /sem diff/i);
});

test('minimumArtifactSatisfied: test-green com check de teste passado => ok (null)', () => {
  const evidence: StructuredEvidence = {
    checks: [{ name: 'test', passed: true, output: '10 passed' }],
  };
  assert.equal(
    minimumArtifactSatisfied({
      resultClass: 'test-green',
      evidence,
      diff: '',
      flowFilesPresent: false,
    }),
    null,
  );
});

test('minimumArtifactSatisfied: test-green sem check de teste verde => problema', () => {
  const evidence: StructuredEvidence = {
    checks: [{ name: 'lint', passed: true }],
  };
  const p = minimumArtifactSatisfied({
    resultClass: 'test-green',
    evidence,
    diff: '',
    flowFilesPresent: true,
  });
  assert.ok(p);
  assert.match(p!.title, /teste verde/i);
});

test('minimumArtifactSatisfied: flow-artifact com arquivos presentes => ok (null)', () => {
  assert.equal(
    minimumArtifactSatisfied({
      resultClass: 'flow-artifact',
      evidence: null,
      diff: '',
      flowFilesPresent: true,
    }),
    null,
  );
});

test('minimumArtifactSatisfied: flow-artifact com arquivos ausentes => problema', () => {
  const p = minimumArtifactSatisfied({
    resultClass: 'flow-artifact',
    evidence: null,
    diff: '',
    flowFilesPresent: false,
  });
  assert.ok(p);
  assert.match(p!.title, /fluxo/i);
});
