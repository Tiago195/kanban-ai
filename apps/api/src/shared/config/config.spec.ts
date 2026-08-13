import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_MEMORY_GIT_DIR,
  loadConfig,
  resolveMemoryGitDir,
} from './config';

// --- config-boot: guard-rail anti-alucinação do arquivo-fantasma ---
// Regressão: `apps/api/.env.example` NUNCA deve existir (ver o aviso
// anti-alucinação no cabeçalho de config.ts e o ADR-0019). Existe um único
// template versionado: `.env.example` na raiz do monorepo. Se alguém (humano
// ou agent) recriar o path-fantasma, ou remover o template real da raiz, este
// teste falha cedo.
test('config-boot: apps/api/.env.example não existe (path-fantasma)', () => {
  // __dirname em runtime = apps/api/src/shared/config; ../../../ sobe até apps/api.
  const phantom = resolve(__dirname, '../../../.env.example');
  assert.equal(
    existsSync(phantom),
    false,
    'apps/api/.env.example é um path-fantasma e não deve existir; o único ' +
      'template versionado é .env.example na raiz do monorepo (ver ADR-0019).',
  );

  // Asserção positiva: o único template legítimo deve estar na raiz do
  // monorepo (apps/api/src/shared/config -> ../../../../../ = raiz).
  const rootTemplate = resolve(__dirname, '../../../../../.env.example');
  assert.equal(
    existsSync(rootTemplate),
    true,
    'o template .env.example deve existir na raiz do monorepo; todas as ' +
      'chaves de env ficam documentadas nele (ver ADR-0019).',
  );
});

// --- MEMORY_GIT_DIR: bare repo da memória (ADR-0027, Camada 1) ---

test('resolveMemoryGitDir: ausente usa o default documentado', () => {
  assert.equal(resolveMemoryGitDir(undefined), DEFAULT_MEMORY_GIT_DIR);
});

test('resolveMemoryGitDir: valor explícito é respeitado (com trim)', () => {
  assert.equal(resolveMemoryGitDir('/srv/memory/git'), '/srv/memory/git');
  assert.equal(resolveMemoryGitDir('  /srv/memory/git  '), '/srv/memory/git');
});

test('resolveMemoryGitDir: definido vazio/whitespace falha cedo com mensagem clara', () => {
  assert.throws(() => resolveMemoryGitDir(''), /MEMORY_GIT_DIR/);
  assert.throws(() => resolveMemoryGitDir('   '), /MEMORY_GIT_DIR/);
});

test('loadConfig: memory.gitDir usa default quando MEMORY_GIT_DIR ausente', () => {
  const prev = process.env.MEMORY_GIT_DIR;
  delete process.env.MEMORY_GIT_DIR;
  try {
    assert.equal(loadConfig().memory.gitDir, DEFAULT_MEMORY_GIT_DIR);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_GIT_DIR;
    else process.env.MEMORY_GIT_DIR = prev;
  }
});

test('loadConfig: memory.gitDir respeita override via env', () => {
  const prev = process.env.MEMORY_GIT_DIR;
  process.env.MEMORY_GIT_DIR = '/var/lib/kanban-ai/memory';
  try {
    assert.equal(loadConfig().memory.gitDir, '/var/lib/kanban-ai/memory');
  } finally {
    if (prev === undefined) delete process.env.MEMORY_GIT_DIR;
    else process.env.MEMORY_GIT_DIR = prev;
  }
});

test('loadConfig: falha cedo quando MEMORY_GIT_DIR está vazio', () => {
  const prev = process.env.MEMORY_GIT_DIR;
  process.env.MEMORY_GIT_DIR = '   ';
  try {
    assert.throws(() => loadConfig(), /MEMORY_GIT_DIR/);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_GIT_DIR;
    else process.env.MEMORY_GIT_DIR = prev;
  }
});

// --- EP-B: scheduler dos jobs de manutenção da memória (ADR-0027) ---

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('loadConfig: scheduler da memória usa defaults quando envs ausentes', () => {
  withEnv('MEMORY_SCHEDULER_ENABLED', undefined, () =>
    withEnv('MEMORY_LOCK_SWEEP_INTERVAL_MS', undefined, () =>
      withEnv('MEMORY_GC_INTERVAL_MS', undefined, () => {
        const { memory } = loadConfig();
        assert.equal(memory.schedulerEnabled, true);
        assert.equal(memory.lockSweepIntervalMs, 30_000);
        assert.equal(memory.gcIntervalMs, 3_600_000);
      }),
    ),
  );
});

test('loadConfig: MEMORY_SCHEDULER_ENABLED=false desliga o scheduler', () => {
  withEnv('MEMORY_SCHEDULER_ENABLED', 'false', () => {
    assert.equal(loadConfig().memory.schedulerEnabled, false);
  });
});

test('loadConfig: intervalos do scheduler respeitam override via env', () => {
  withEnv('MEMORY_LOCK_SWEEP_INTERVAL_MS', '15000', () =>
    withEnv('MEMORY_GC_INTERVAL_MS', '600000', () => {
      const { memory } = loadConfig();
      assert.equal(memory.lockSweepIntervalMs, 15_000);
      assert.equal(memory.gcIntervalMs, 600_000);
    }),
  );
});

test('loadConfig: intervalos inválidos caem no default', () => {
  withEnv('MEMORY_LOCK_SWEEP_INTERVAL_MS', 'abc', () =>
    withEnv('MEMORY_GC_INTERVAL_MS', 'not-a-number', () => {
      const { memory } = loadConfig();
      assert.equal(memory.lockSweepIntervalMs, 30_000);
      assert.equal(memory.gcIntervalMs, 3_600_000);
    }),
  );
});

// --- US-OBS2 (ADR-0035): flags do worktree isolado resiliente ---

test('loadConfig: worktree flags têm defaults corretos (off/isolated, on/resto)', () => {
  withEnv('AGENT_WORKTREE_ISOLATED', undefined, () =>
    withEnv('AGENT_WORKTREE_MIRROR_IGNORED', undefined, () =>
      withEnv('AGENT_WORKTREE_INIT_SUBMODULES', undefined, () =>
        withEnv('AGENT_WORKTREE_PRESERVE_PATCH', undefined, () => {
          const { agent } = loadConfig();
          assert.equal(agent.worktreeIsolated, false, 'isolated default OFF (retrocompat)');
          assert.equal(agent.worktreeMirrorIgnored, true);
          assert.equal(agent.worktreeInitSubmodules, true);
          assert.equal(agent.worktreePreservePatch, true);
        }),
      ),
    ),
  );
});

test('loadConfig: AGENT_WORKTREE_ISOLATED=true liga o worktree isolado', () => {
  withEnv('AGENT_WORKTREE_ISOLATED', 'true', () => {
    assert.equal(loadConfig().agent.worktreeIsolated, true);
  });
});

test('loadConfig: AGENT_WORKTREE_ISOLATED só liga com o literal "true"', () => {
  withEnv('AGENT_WORKTREE_ISOLATED', '1', () => {
    assert.equal(loadConfig().agent.worktreeIsolated, false);
  });
});

test('loadConfig: MIRROR/INIT/PRESERVE desligam com o literal "false"', () => {
  withEnv('AGENT_WORKTREE_MIRROR_IGNORED', 'false', () =>
    withEnv('AGENT_WORKTREE_INIT_SUBMODULES', 'false', () =>
      withEnv('AGENT_WORKTREE_PRESERVE_PATCH', 'false', () => {
        const { agent } = loadConfig();
        assert.equal(agent.worktreeMirrorIgnored, false);
        assert.equal(agent.worktreeInitSubmodules, false);
        assert.equal(agent.worktreePreservePatch, false);
      }),
    ),
  );
});
