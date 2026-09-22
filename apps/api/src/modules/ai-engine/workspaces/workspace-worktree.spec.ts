import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../../shared/config/config';
import {
  WorkspaceService,
  resolveWorktreePolicy,
  shouldMirrorIgnoredPath,
  executionBranchName,
  type WorktreePolicy,
} from './workspace.service';

/**
 * US-OBS2 (ADR-0035, refina ADR-0008) — testes do worktree ISOLADO por execução.
 *
 * Parte 1: políticas PURAS (sem I/O) — decisão de mirror/branch a partir da
 * config, exercitáveis independentemente do FS.
 * Parte 2: integração real com `git` num repo scratch fora do kanban-ai:
 * `resolveWorkdir` cria o worktree isolado, `cleanupWorktree` o remove SEM tocar
 * o repo-alvo; com a flag off, o comportamento é idêntico ao legado (retorna o
 * próprio repo-alvo, sem worktree).
 */

/** Config mínima de agente, sobrescrevendo só as flags de worktree relevantes. */
function makeConfig(overrides: Partial<AppConfig['agent']>): AppConfig {
  return {
    apiPort: 3333,
    wsPath: '/ws',
    databaseUrl: '',
    agent: {
      defaultModel: 'mock',
      maxConcurrentSessions: 3,
      watchdogIntervalMs: 120_000,
      autoStepIntervalMs: 1_500,
      workspacesDir: './.agent-workspaces',
      runnerKind: 'mock',
      cliCommand: 'copilot',
      cliArgs: [],
      promptMode: 'stdin',
      hitlTimeoutMs: 600_000,
      streamIdleTimeoutMs: 120_000,
      validationEnabled: false,
      validationTimeoutMs: 300_000,
      validationScripts: [],
      verifyFlowFiles: false,
      flowTestsEnabled: false,
      flowTestGlobs: ['.spec.', '.test.'],
      requireFlowCoverage: false,
      maxValidationFailures: 3,
      maxIterationsPerTask: 30,
      maxUnproductiveIterations: 3,
      maxDerivedDepth: 3,
      maxDerivedPerProblem: 2,
      maxTaskDurationMs: 0,
      maxTaskTokens: 0,
      serializeByRepo: false,
      thrashDetectionEnabled: false,
      thrashSimilarityThreshold: 0.9,
      thrashWindow: 2,
      requireStructuredEvidence: false,
      requireMinArtifact: false,
      runtimePersistEnabled: false,
      claimEnabled: false,
      claimTtlMs: 300_000,
      autostartDependents: false,
      wakeupQueueEnabled: false,
      worktreeIsolated: false,
      worktreeMirrorIgnored: true,
      worktreeInitSubmodules: true,
      worktreePreservePatch: true,
      ...overrides,
    },
  } as AppConfig;
}

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@kanban-ai.local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@kanban-ai.local',
    },
  });

/** Cria um repo git scratch (fora do kanban-ai) com 1 commit e node_modules ignorado. */
async function makeScratchRepo(): Promise<{ repo: string; base: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-wt-spec-'));
  const repo = path.join(root, 'target-repo');
  const base = path.join(root, 'worktrees');
  await fs.mkdir(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@kanban-ai.local'], repo);
  git(['config', 'user.name', 'test'], repo);
  await fs.writeFile(path.join(repo, 'README.md'), '# target\n', 'utf8');
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules\n', 'utf8');
  await fs.mkdir(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
  await fs.writeFile(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n', 'utf8');
  git(['add', 'README.md', '.gitignore'], repo);
  git(['commit', '-q', '-m', 'initial'], repo);
  return {
    repo,
    base,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Parte 1 — política pura (sem I/O)
// ---------------------------------------------------------------------------

test('resolveWorktreePolicy: mapeia as flags de config 1:1', () => {
  const policy = resolveWorktreePolicy(
    makeConfig({
      worktreeIsolated: true,
      worktreeMirrorIgnored: false,
      worktreeInitSubmodules: true,
      worktreePreservePatch: false,
    }),
  );
  assert.deepEqual(policy, {
    isolated: true,
    mirrorIgnoredPaths: false,
    initSubmodules: true,
    preservePatchOnTrash: false,
  });
});

test('executionBranchName: prefixa kanban-ai/<key>', () => {
  assert.equal(executionBranchName('us-obs2'), 'kanban-ai/us-obs2');
});

test('shouldMirrorIgnoredPath: só espelha quando isolado + mirror ligado', () => {
  const on: WorktreePolicy = {
    isolated: true,
    mirrorIgnoredPaths: true,
    initSubmodules: false,
    preservePatchOnTrash: false,
  };
  assert.equal(shouldMirrorIgnoredPath(on, 'node_modules'), true);
  // desligado por qualquer flag
  assert.equal(shouldMirrorIgnoredPath({ ...on, isolated: false }, 'node_modules'), false);
  assert.equal(shouldMirrorIgnoredPath({ ...on, mirrorIgnoredPaths: false }, 'node_modules'), false);
});

test('shouldMirrorIgnoredPath: nunca espelha .git nem paths que escapam', () => {
  const on: WorktreePolicy = {
    isolated: true,
    mirrorIgnoredPaths: true,
    initSubmodules: false,
    preservePatchOnTrash: false,
  };
  assert.equal(shouldMirrorIgnoredPath(on, '.git'), false);
  assert.equal(shouldMirrorIgnoredPath(on, '.git/objects'), false);
  assert.equal(shouldMirrorIgnoredPath(on, '../escape'), false);
  assert.equal(shouldMirrorIgnoredPath(on, ''), false);
});

// ---------------------------------------------------------------------------
// Parte 2 — integração real com git
// ---------------------------------------------------------------------------

test('resolveWorkdir (flag OFF): retorna o repo-alvo, SEM worktree (legado)', async () => {
  const { repo, base, cleanup } = await makeScratchRepo();
  try {
    const svc = new WorkspaceService(makeConfig({ worktreeIsolated: false, workspacesDir: base }));
    const cwd = await svc.resolveWorkdir('story-off', repo);
    assert.equal(cwd, repo, 'flag off deve retornar o próprio repo-alvo');
    // Nenhum worktree registrado no repo-alvo.
    const list = git(['worktree', 'list'], repo);
    assert.equal(list.trim().split('\n').length, 1, 'não deve haver worktree extra');
  } finally {
    await cleanup();
  }
});

test('resolveWorkdir (flag ON): cria worktree isolado; cleanupWorktree remove sem tocar o alvo', async () => {
  const { repo, base, cleanup } = await makeScratchRepo();
  try {
    const svc = new WorkspaceService(
      makeConfig({ worktreeIsolated: true, workspacesDir: base, worktreeInitSubmodules: false }),
    );
    const cwd = await svc.resolveWorkdir('story-on', repo);

    // 1. O worktree fica DENTRO da base configurada, não é o repo-alvo.
    assert.notEqual(cwd, repo);
    assert.equal(path.dirname(cwd), path.resolve(base));

    // 2. `git worktree list` no repo-alvo mostra o novo path.
    const list = git(['worktree', 'list'], repo);
    assert.ok(list.includes(cwd), `git worktree list deve conter ${cwd}:\n${list}`);

    // 3. O worktree existe no FS e está na branch de execução.
    const stat = await fs.stat(cwd);
    assert.ok(stat.isDirectory());
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
    assert.equal(branch, 'kanban-ai/story-on');

    // 4. Trabalho do agent acontece no worktree, não no repo-alvo.
    await fs.writeFile(path.join(cwd, 'agent-work.txt'), 'done by agent\n', 'utf8');
    assert.equal(
      await fs
        .access(path.join(repo, 'agent-work.txt'))
        .then(() => true)
        .catch(() => false),
      false,
      'o arquivo do agent NÃO pode aparecer no repo-alvo',
    );

    // 5. cleanupWorktree roda `git worktree remove` e some da lista, e o
    //    repo-alvo continua intacto (README ainda lá, worktree list só o main).
    await svc.cleanupWorktree('story-on');
    const listAfter = git(['worktree', 'list'], repo);
    assert.ok(!listAfter.includes(cwd), `worktree removido da lista:\n${listAfter}`);
    assert.equal(
      await fs
        .access(path.join(repo, 'README.md'))
        .then(() => true)
        .catch(() => false),
      true,
      'repo-alvo permanece intacto',
    );
  } finally {
    await cleanup();
  }
});

test('resolveWorkdir (mirror ON): worktree ganha symlink de node_modules', async () => {
  const { repo, base, cleanup } = await makeScratchRepo();
  try {
    const svc = new WorkspaceService(
      makeConfig({
        worktreeIsolated: true,
        worktreeMirrorIgnored: true,
        worktreeInitSubmodules: false,
        workspacesDir: base,
      }),
    );
    const cwd = await svc.resolveWorkdir('story-mirror', repo);
    const link = path.join(cwd, 'node_modules');
    const lstat = await fs.lstat(link);
    assert.ok(lstat.isSymbolicLink(), 'node_modules deve ser um symlink no worktree');
    // Resolve para o node_modules do repo-alvo (conteúdo acessível via link).
    const viaLink = await fs.readFile(path.join(link, 'left-pad', 'index.js'), 'utf8');
    assert.match(viaLink, /module\.exports/);
    await svc.cleanupWorktree('story-mirror');
  } finally {
    await cleanup();
  }
});

test('resolveWorkdir (mirror OFF): worktree NÃO cria symlink de node_modules', async () => {
  const { repo, base, cleanup } = await makeScratchRepo();
  try {
    const svc = new WorkspaceService(
      makeConfig({
        worktreeIsolated: true,
        worktreeMirrorIgnored: false,
        worktreeInitSubmodules: false,
        workspacesDir: base,
      }),
    );
    const cwd = await svc.resolveWorkdir('story-nomirror', repo);
    assert.equal(
      await fs
        .access(path.join(cwd, 'node_modules'))
        .then(() => true)
        .catch(() => false),
      false,
      'sem mirror, node_modules não deve existir no worktree',
    );
    await svc.cleanupWorktree('story-nomirror');
  } finally {
    await cleanup();
  }
});

test('resolveWorkdir (submodules ON): init é best-effort e não quebra repo sem submódulos', async () => {
  const { repo, base, cleanup } = await makeScratchRepo();
  try {
    const svc = new WorkspaceService(
      makeConfig({
        worktreeIsolated: true,
        worktreeMirrorIgnored: false,
        worktreeInitSubmodules: true,
        workspacesDir: base,
      }),
    );
    // Repo sem submódulos: `git submodule update --init --recursive` é no-op
    // seguro. O worktree deve ser criado normalmente (init não bloqueia).
    const cwd = await svc.resolveWorkdir('story-sub', repo);
    const stat = await fs.stat(cwd);
    assert.ok(stat.isDirectory(), 'worktree criado mesmo com initSubmodules ligado');
    await svc.cleanupWorktree('story-sub');
  } finally {
    await cleanup();
  }
});

test('patch-preserve: patch não-commitado sobrevive a um restart simulado', async () => {  const { repo, base, cleanup } = await makeScratchRepo();
  try {
    const svc = new WorkspaceService(
      makeConfig({
        worktreeIsolated: true,
        worktreeMirrorIgnored: false,
        worktreeInitSubmodules: false,
        worktreePreservePatch: true,
        workspacesDir: base,
      }),
    );
    // Execução 1: agent modifica um arquivo versionado (mudança não-commitada).
    const cwd1 = await svc.resolveWorkdir('story-patch', repo);
    await fs.writeFile(path.join(cwd1, 'README.md'), '# target\n\nedit do agent\n', 'utf8');
    // Trash/restart: cleanup captura o patch e remove o worktree.
    await svc.cleanupWorktree('story-patch');

    // Execução 2 (mesma key): recria o worktree e reaplica o patch preservado.
    const cwd2 = await svc.resolveWorkdir('story-patch', repo);
    const restored = await fs.readFile(path.join(cwd2, 'README.md'), 'utf8');
    assert.match(restored, /edit do agent/, 'a mudança não-commitada deve sobreviver ao restart');
    await svc.cleanupWorktree('story-patch');
  } finally {
    await cleanup();
  }
});
