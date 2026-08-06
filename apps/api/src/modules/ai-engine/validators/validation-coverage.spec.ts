import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AffectedFlow } from '@kanban-ai/shared';
import type { AppConfig } from '../../../shared/config/config';
import type { WorkspaceService } from '../workspaces/workspace.service';
import { ValidationRunner } from './validation.runner';

// --- #5: teste de mesa empírico por fluxo (suite verde ≠ fluxo coberto) ---

type ProjectCheckResult = {
  name: string;
  ran: boolean;
  passed: boolean;
  exitCode: number | null;
  output: string;
};

/** Fake determinístico de WorkspaceService com comportamento configurável. */
function makeWorkspaces(opts: {
  existing?: Set<string>;
  relatedByFile?: Record<string, string[]>;
  runTests?: (files: string[]) => ProjectCheckResult;
}): WorkspaceService {
  const existing = opts.existing ?? new Set<string>();
  return {
    fileExistsInWorktree: async (_cwd: string, rel: string) => existing.has(rel),
    findRelatedTestFiles: async (_cwd: string, file: string) => opts.relatedByFile?.[file] ?? [],
    runTestsForFiles: async (_cwd: string, files: string[]) =>
      opts.runTests?.(files) ?? { name: 'test:flow', ran: true, passed: true, exitCode: 0, output: '' },
    runProjectChecks: async () => [],
  } as unknown as WorkspaceService;
}

function makeConfig(overrides: Partial<AppConfig['agent']>): AppConfig {
  const agent = {
    verifyFlowFiles: false,
    validationEnabled: false,
    validationScripts: [],
    flowTestsEnabled: true,
    flowTestGlobs: ['.spec.', '.test.'],
    requireFlowCoverage: false,
    ...overrides,
  } as unknown as AppConfig['agent'];
  return { agent } as unknown as AppConfig;
}

const flow = (name: string, files: string[]): AffectedFlow =>
  ({ name, files, note: '' }) as AffectedFlow;

test('#5: fluxo com fonte sem spec + requireFlowCoverage -> problema (não passa)', async () => {
  const ws = makeWorkspaces({ relatedByFile: { 'src/a.ts': [] } });
  const runner = new ValidationRunner(ws, makeConfig({ requireFlowCoverage: true }));
  const out = await runner.validate({
    storyId: 's1',
    strategy: 'flows+regression',
    affectedFlows: [flow('Fluxo A', ['src/a.ts'])],
    cwd: '/wt',
  });
  assert.equal(out.passed, false);
  assert.match(out.problems[0].title, /sem cobertura de teste/i);
});

test('#5: fluxo com fonte sem spec + requireFlowCoverage=false -> passa (só aviso)', async () => {
  const ws = makeWorkspaces({ relatedByFile: { 'src/a.ts': [] } });
  const runner = new ValidationRunner(ws, makeConfig({ requireFlowCoverage: false }));
  const out = await runner.validate({
    storyId: 's1',
    strategy: 'flows+regression',
    affectedFlows: [flow('Fluxo A', ['src/a.ts'])],
    cwd: '/wt',
  });
  assert.equal(out.passed, true);
});

test('#5: fluxo com spec localizado mas runner indeterminado + requireFlowCoverage -> problema', async () => {
  const ws = makeWorkspaces({
    relatedByFile: { 'src/a.ts': ['src/a.spec.ts'] },
    runTests: () => ({ name: 'test:flow', ran: false, passed: true, exitCode: null, output: 'runner desconhecido' }),
  });
  const runner = new ValidationRunner(ws, makeConfig({ requireFlowCoverage: true }));
  const out = await runner.validate({
    storyId: 's1',
    strategy: 'flows+regression',
    affectedFlows: [flow('Fluxo A', ['src/a.ts'])],
    cwd: '/wt',
  });
  assert.equal(out.passed, false);
  assert.match(out.problems[0].title, /testes não executados/i);
});

test('#5: fluxo com spec executado com sucesso -> passa', async () => {
  const ws = makeWorkspaces({
    relatedByFile: { 'src/a.ts': ['src/a.spec.ts'] },
    runTests: () => ({ name: 'test:flow', ran: true, passed: true, exitCode: 0, output: 'ok' }),
  });
  const runner = new ValidationRunner(ws, makeConfig({ requireFlowCoverage: true }));
  const out = await runner.validate({
    storyId: 's1',
    strategy: 'flows+regression',
    affectedFlows: [flow('Fluxo A', ['src/a.ts'])],
    cwd: '/wt',
  });
  assert.equal(out.passed, true);
});

test('#5: fluxo que só declara spec (sem fonte) não gera lacuna mesmo com requireFlowCoverage', async () => {
  const ws = makeWorkspaces({
    relatedByFile: { 'src/a.spec.ts': ['src/a.spec.ts'] },
    runTests: () => ({ name: 'test:flow', ran: true, passed: true, exitCode: 0, output: 'ok' }),
  });
  const runner = new ValidationRunner(ws, makeConfig({ requireFlowCoverage: true }));
  const out = await runner.validate({
    storyId: 's1',
    strategy: 'flows+regression',
    affectedFlows: [flow('Fluxo A', ['src/a.spec.ts'])],
    cwd: '/wt',
  });
  assert.equal(out.passed, true);
});

test('#5: teste do fluxo executado que FALHA -> problema mencionando o fluxo', async () => {
  const ws = makeWorkspaces({
    relatedByFile: { 'src/a.ts': ['src/a.spec.ts'] },
    runTests: () => ({ name: 'test:flow', ran: true, passed: false, exitCode: 1, output: '1 failed' }),
  });
  const runner = new ValidationRunner(ws, makeConfig({ requireFlowCoverage: false }));
  const out = await runner.validate({
    storyId: 's1',
    strategy: 'flows+regression',
    affectedFlows: [flow('Fluxo A', ['src/a.ts'])],
    cwd: '/wt',
  });
  assert.equal(out.passed, false);
  assert.match(out.problems[0].title, /Testes do fluxo "Fluxo A" falharam/);
});
