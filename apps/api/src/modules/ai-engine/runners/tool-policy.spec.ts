import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolPolicyFlags } from './tool-policy';
import type { ToolPolicy } from '../../../shared/config/config';

/**
 * Specs do tradutor PURO da `ToolPolicy` para flags nativas da Copilot CLI
 * (US-HARD5). Prova: default allow-all preservado (backwards-compat); deny list
 * → `--deny-tool`; addDirs + worktree → `--add-dir`; disallowTempDir; denyUrls;
 * allowlist (`--available-tools`) e exclusão.
 */

/** Política default: preserva o comportamento atual (`--allow-all`). */
function defaultPolicy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    allowAll: true,
    denyTools: [],
    availableTools: [],
    excludedTools: [],
    addDirs: [],
    denyUrls: [],
    disallowTempDir: false,
    ...overrides,
  };
}

test('allow-all default (sem restrições) → exatamente [--allow-all]', () => {
  assert.deepEqual(buildToolPolicyFlags(defaultPolicy()), ['--allow-all']);
});

test('allow-all default ignora worktreeCwd quando não há sandbox', () => {
  assert.deepEqual(buildToolPolicyFlags(defaultPolicy(), '/repo/wt'), [
    '--allow-all',
  ]);
});

test('deny list → --deny-tool=csv (troca allow-all cru por granular)', () => {
  const flags = buildToolPolicyFlags(
    defaultPolicy({ denyTools: ['shell', 'write'] }),
  );
  assert.ok(!flags.includes('--allow-all'), 'não emite allow-all cru');
  assert.ok(flags.includes('--allow-all-tools'));
  assert.ok(flags.includes('--deny-tool=shell,write'));
  // paths/urls seguem liberados por não ter restrição própria
  assert.ok(flags.includes('--allow-all-paths'));
  assert.ok(flags.includes('--allow-all-urls'));
});

test('addDirs + worktree → um --add-dir por dir, worktree primeiro', () => {
  const flags = buildToolPolicyFlags(
    defaultPolicy({ addDirs: ['/data', '/cache'] }),
    '/repo/wt',
  );
  const idx = flags.indexOf('--add-dir');
  assert.ok(idx >= 0);
  // sequência: --add-dir /repo/wt --add-dir /data --add-dir /cache
  assert.deepEqual(
    flags.slice(idx, idx + 6),
    [
      '--add-dir',
      '/repo/wt',
      '--add-dir',
      '/data',
      '--add-dir',
      '/cache',
    ],
  );
  // sandbox de paths ativo → NÃO emite --allow-all-paths
  assert.ok(!flags.includes('--allow-all-paths'));
});

test('addDirs deduplica worktree repetido', () => {
  const flags = buildToolPolicyFlags(
    defaultPolicy({ addDirs: ['/repo/wt'] }),
    '/repo/wt',
  );
  const count = flags.filter((f) => f === '/repo/wt').length;
  assert.equal(count, 1);
});

test('disallowTempDir → --disallow-temp-dir e sandbox de paths ativo', () => {
  const flags = buildToolPolicyFlags(
    defaultPolicy({ disallowTempDir: true }),
  );
  assert.ok(flags.includes('--disallow-temp-dir'));
  assert.ok(!flags.includes('--allow-all-paths'));
});

test('denyUrls → --deny-url=csv (mantém allow-all-urls sob allowAll)', () => {
  const flags = buildToolPolicyFlags(
    defaultPolicy({ denyUrls: ['http://evil.test', 'http://bad.test'] }),
  );
  assert.ok(flags.includes('--deny-url=http://evil.test,http://bad.test'));
  assert.ok(flags.includes('--allow-all-urls'));
});

test('availableTools → --available-tools e NÃO --allow-all-tools', () => {
  const flags = buildToolPolicyFlags(
    defaultPolicy({ availableTools: ['read', 'edit'] }),
  );
  assert.ok(flags.includes('--available-tools=read,edit'));
  assert.ok(!flags.includes('--allow-all-tools'));
});

test('excludedTools → --excluded-tools=csv', () => {
  const flags = buildToolPolicyFlags(
    defaultPolicy({ excludedTools: ['cron'] }),
  );
  assert.ok(flags.includes('--excluded-tools=cron'));
});

test('allowAll=false sem restrições → não emite allow-all nem granular de allow', () => {
  const flags = buildToolPolicyFlags(defaultPolicy({ allowAll: false }));
  assert.ok(!flags.includes('--allow-all'));
  assert.ok(!flags.includes('--allow-all-tools'));
  assert.ok(!flags.includes('--allow-all-paths'));
  assert.ok(!flags.includes('--allow-all-urls'));
  assert.deepEqual(flags, []);
});
