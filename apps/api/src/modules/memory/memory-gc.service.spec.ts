import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import { MemoryGitService } from './memory-git.service';
import { MemoryIndexService } from './memory-index.service';
import { MemoryGcService } from './memory-gc.service';

// --- MemoryGcService: garbage collection da colmeia (ADR-0027, EP-85) ---
//
// Git roda de verdade num tmpdir; o Postgres e um fake in-memory minimo que
// cobre exatamente o que a GC usa: findMany(select/where.activeBranch),
// update(stale/archivedAt/lastSeenCommit) e o upsert que o Index usa ao
// reindexar. Cada teste cria um repo-alvo em disco para a deteccao de modulos.

interface GcRow {
  path: string;
  activeBranch: string | null;
  stale: boolean;
  archivedAt: Date | null;
  lastSeenCommit: string | null;
}

class FakeGcIndex {
  readonly rows = new Map<string, GcRow>();

  seed(path: string, extra: Partial<GcRow> = {}): void {
    this.rows.set(path, {
      path,
      activeBranch: extra.activeBranch ?? null,
      stale: extra.stale ?? false,
      archivedAt: extra.archivedAt ?? null,
      lastSeenCommit: extra.lastSeenCommit ?? null,
    });
  }

  get memoryIndex() {
    const store = this.rows;
    return {
      // O Index (reindexOne) usa upsert; aqui so precisamos preservar a linha.
      upsert: async (a: { where: { path: string }; create: { path: string } }) => {
        if (!store.has(a.where.path)) {
          store.set(a.where.path, {
            path: a.where.path,
            activeBranch: null,
            stale: false,
            archivedAt: null,
            lastSeenCommit: null,
          });
        }
        return store.get(a.where.path);
      },
      findMany: async (a?: { where?: { activeBranch?: { not: null } } }) => {
        let rows = [...store.values()];
        if (a?.where?.activeBranch) rows = rows.filter((r) => r.activeBranch !== null);
        return rows;
      },
      update: async (a: { where: { path: string }; data: Partial<GcRow> }) => {
        const existing = store.get(a.where.path);
        if (!existing) throw new Error('not found');
        const merged = { ...existing, ...a.data };
        store.set(a.where.path, merged);
        return merged;
      },
    };
  }
}

function makeTmpGitDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-gc-'));
  return path.join(root, 'git');
}
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
function makeRepo(dirs: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-gc-repo-'));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

async function makeHarness() {
  const gitDir = makeTmpGitDir();
  const config = { memory: { gitDir } } as unknown as AppConfig;
  const git = new MemoryGitService(config);
  await git.provision();
  const fake = new FakeGcIndex();
  const index = new MemoryIndexService(fake as unknown as PrismaService, git);
  const gc = new MemoryGcService(fake as unknown as PrismaService, git);
  return { gitDir, git, index, gc, fake };
}

// ---------------------------------------------------------------------------
// US-215 — sweepStale
// ---------------------------------------------------------------------------

test('sweepStale arquiva neuronio de modulo que sumiu e reativa o que voltou', async () => {
  const h = await makeHarness();
  const repo = makeRepo(['apps/api/src/modules/cards']); // "memory" sumiu
  try {
    h.fake.seed('modules/cards.md');
    h.fake.seed('modules/memory.md');
    h.fake.seed('docs/adr.md'); // nao e neuronio de modulo: ignorado

    const r1 = await h.gc.sweepStale({ repoPath: repo });
    assert.deepEqual(r1.archived, ['modules/memory.md']);
    assert.equal(h.fake.rows.get('modules/memory.md')?.stale, true);
    assert.ok(h.fake.rows.get('modules/memory.md')?.archivedAt);
    assert.equal(h.fake.rows.get('modules/cards.md')?.stale, false);
    assert.equal(h.fake.rows.get('docs/adr.md')?.stale, false);

    // "memory" volta -> reativa.
    fs.mkdirSync(path.join(repo, 'apps/api/src/modules/memory'), { recursive: true });
    const r2 = await h.gc.sweepStale({ repoPath: repo });
    assert.deepEqual(r2.revived, ['modules/memory.md']);
    assert.equal(h.fake.rows.get('modules/memory.md')?.stale, false);
    assert.equal(h.fake.rows.get('modules/memory.md')?.archivedAt, null);
  } finally {
    cleanup(path.dirname(h.gitDir));
    cleanup(repo);
  }
});

test('sweepStale e idempotente (rodar 2x nao muda o estado)', async () => {
  const h = await makeHarness();
  const repo = makeRepo(['apps/api/src/modules/cards']);
  try {
    h.fake.seed('modules/memory.md');
    const a = await h.gc.sweepStale({ repoPath: repo });
    const b = await h.gc.sweepStale({ repoPath: repo });
    assert.deepEqual(a.archived, ['modules/memory.md']);
    assert.deepEqual(b.archived, []); // ja stale, nao arquiva de novo
    assert.deepEqual(b.revived, []);
  } finally {
    cleanup(path.dirname(h.gitDir));
    cleanup(repo);
  }
});

// ---------------------------------------------------------------------------
// US-216 — summarizeHistory
// ---------------------------------------------------------------------------

test('summarizeHistory retorna null quando o historico e curto', async () => {
  const h = await makeHarness();
  try {
    await h.index.commitAndReindex({ path: 'n.md', content: '# a', sessionId: 's', message: 'c1' });
    const out = await h.gc.summarizeHistory('n.md', 10);
    assert.equal(out, null);
  } finally {
    cleanup(path.dirname(h.gitDir));
  }
});

test('summarizeHistory condensa o historico longo mantendo os N recentes', async () => {
  const h = await makeHarness();
  try {
    for (let i = 1; i <= 5; i++) {
      await h.index.commitAndReindex({
        path: 'n.md',
        content: `# v${i}`,
        sessionId: 's',
        message: `commit ${i}`,
      });
    }
    const out = await h.gc.summarizeHistory('n.md', 2);
    assert.ok(out);
    assert.match(out as string, /Historico condensado \(3 commit\(s\) antigos\)/);
    assert.match(out as string, /Commits recentes preservados/);
    // Mantem exatamente os 2 mais recentes na lista preservada.
    const preserved = (out as string).match(/^- [0-9a-f]{8} /gm) ?? [];
    assert.equal(preserved.length, 2);
  } finally {
    cleanup(path.dirname(h.gitDir));
  }
});

// ---------------------------------------------------------------------------
// US-217 — pruneEphemeralBranches
// ---------------------------------------------------------------------------

test('pruneEphemeralBranches poda ramos mem/ai/* orfaos e preserva os ativos e o main', async () => {
  const h = await makeHarness();
  try {
    // Cria 2 ramos efemeros escrevendo neuronios sem integrar.
    await h.git.writeNeuron({ path: 'a.md', content: '# a', sessionId: 'orfao', message: 'x' });
    await h.git.writeNeuron({ path: 'b.md', content: '# b', sessionId: 'ativo', message: 'y' });
    const activeBranch = 'mem/ai/ativo/b.md';
    h.fake.seed('b.md', { activeBranch });

    const before = await h.git.listBranches();
    assert.ok(before.includes('mem/ai/orfao/a.md'));
    assert.ok(before.includes(activeBranch));

    const pruned = await h.gc.pruneEphemeralBranches();
    assert.deepEqual(pruned, ['mem/ai/orfao/a.md']);

    const after = await h.git.listBranches();
    assert.ok(!after.includes('mem/ai/orfao/a.md'));
    assert.ok(after.includes(activeBranch)); // ativo preservado
    assert.ok(after.includes('main')); // main nunca podado
  } finally {
    cleanup(path.dirname(h.gitDir));
  }
});
