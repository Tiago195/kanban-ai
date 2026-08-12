import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import { MemoryGitService } from './memory-git.service';
import { MemoryIndexService } from './memory-index.service';
import {
  MemoryNotInReviewError,
  MemoryReviewService,
  MemoryReviewStaleError,
} from './memory-review.service';

// --- MemoryReviewService: REVIEW + arbitragem (ADR-0027, EP-80) ---
//
// Git roda de verdade num tmpdir; o Postgres e um fake in-memory que cobre o
// que Index + Review usam (findUnique/findMany/upsert/update/delete/deleteMany),
// incluindo os campos de coordenacao (lockState/holder/baseCommit/activeBranch/
// reviewQueued) e de projecao (title/tags/summary/searchText/headCommit).

interface Row {
  path: string;
  headCommit: string;
  title: string;
  tags: string;
  summary: string;
  searchText: string;
  lockState: string;
  holder: string | null;
  leaseId: string | null;
  expiresAt: Date | null;
  baseCommit: string | null;
  activeBranch: string | null;
  reviewQueued: boolean;
  updatedAt: Date;
}

class FakeIndex {
  readonly rows = new Map<string, Row>();
  private clock = 0;

  private norm(r: Partial<Row> & { path: string }): Row {
    return {
      path: r.path,
      headCommit: r.headCommit ?? '',
      title: r.title ?? '',
      tags: r.tags ?? '[]',
      summary: r.summary ?? '',
      searchText: r.searchText ?? '',
      lockState: r.lockState ?? 'FREE',
      holder: r.holder ?? null,
      leaseId: r.leaseId ?? null,
      expiresAt: r.expiresAt ?? null,
      baseCommit: r.baseCommit ?? null,
      activeBranch: r.activeBranch ?? null,
      reviewQueued: r.reviewQueued ?? false,
      updatedAt: new Date(2026, 0, 1, 0, 0, ++this.clock),
    };
  }

  get memoryIndex() {
    const store = this.rows;
    const norm = this.norm.bind(this);
    return {
      findUnique: async (a: { where: { path: string } }) => store.get(a.where.path) ?? null,
      findMany: async () => [...store.values()],
      upsert: async (a: {
        where: { path: string };
        create: Partial<Row> & { path: string };
        update: Partial<Row>;
      }) => {
        const existing = store.get(a.where.path);
        const merged = existing ? norm({ ...existing, ...a.update }) : norm(a.create);
        store.set(a.where.path, merged);
        return merged;
      },
      update: async (a: { where: { path: string }; data: Partial<Row> }) => {
        const existing = store.get(a.where.path);
        if (!existing) throw new Error('not found');
        const merged = norm({ ...existing, ...a.data });
        store.set(a.where.path, merged);
        return merged;
      },
      delete: async (a: { where: { path: string } }) => {
        const row = store.get(a.where.path);
        if (!row) throw new Error('not found');
        store.delete(a.where.path);
        return row;
      },
      deleteMany: async () => {
        const count = store.size;
        store.clear();
        return { count };
      },
    };
  }
}

function makeTmpGitDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-review-'));
  return path.join(root, 'git');
}
function cleanup(gitDir: string): void {
  fs.rmSync(path.dirname(gitDir), { recursive: true, force: true });
}

async function makeHarness() {
  const gitDir = makeTmpGitDir();
  const config = { memory: { gitDir } } as unknown as AppConfig;
  const gitStore = new MemoryGitService(config);
  await gitStore.provision();
  const fake = new FakeIndex();
  const index = new MemoryIndexService(fake as unknown as PrismaService, gitStore);
  const review = new MemoryReviewService(fake as unknown as PrismaService, gitStore, index);
  return { gitDir, git: gitStore, index, review, fake };
}

test('enterReview(semantic-conflict): EDITING -> REVIEW e monta MemoryConflict (base/ours/theirs)', async () => {
  const h = await makeHarness();
  try {
    // Estado estavel: "n.md" ja integrado em main com "v1".
    const p = await h.index.commitAndReindex({
      path: 'n.md',
      content: '# v1',
      sessionId: 'sBase',
      message: 'base',
    });
    const oursHead = p.projection.headCommit;

    // Um agent propos "v2" no seu ramo efemero (theirs), mas nao integrou.
    await h.git.writeNeuron({
      path: 'n.md',
      content: '# v2 do agent',
      sessionId: 's1',
      message: 'proposta',
    });

    const item = await h.review.enterReview({
      path: 'n.md',
      reason: 'semantic-conflict',
      sessionId: 's1',
      holder: 'ai:s1',
      baseCommit: oursHead,
    });

    assert.equal(item.path, 'n.md');
    assert.equal(item.reason, 'semantic-conflict');
    assert.ok(item.conflict, 'deve carregar o MemoryConflict');
    assert.equal(item.conflict!.ours.content, '# v1');
    assert.equal(item.conflict!.theirs.content, '# v2 do agent');
    assert.equal(item.conflict!.ours.ref, oursHead);
    assert.equal(item.conflict!.holder, 'ai:s1');

    const row = h.fake.rows.get('n.md')!;
    assert.equal(row.lockState, 'REVIEW');
    assert.equal(row.reviewQueued, true);
    // HEAD estavel preservado durante o REVIEW.
    assert.equal(row.headCommit, oursHead);
  } finally {
    cleanup(h.gitDir);
  }
});

test('enterReview(out-of-scope): EDITING -> REVIEW sem conflict payload', async () => {
  const h = await makeHarness();
  try {
    await h.index.commitAndReindex({
      path: 'x.md',
      content: '# x',
      sessionId: 'sBase',
      message: 'base',
    });
    const item = await h.review.enterReview({
      path: 'x.md',
      reason: 'out-of-scope',
      sessionId: 's9',
      holder: 'ai:s9',
    });
    assert.equal(item.reason, 'out-of-scope');
    assert.equal(item.conflict, undefined);
    assert.equal(h.fake.rows.get('x.md')!.lockState, 'REVIEW');
  } finally {
    cleanup(h.gitDir);
  }
});

test('resolve(aceitar): commita mutacao arbitrada, REVIEW -> FREE e novo headCommit', async () => {
  const h = await makeHarness();
  try {
    const p = await h.index.commitAndReindex({
      path: 'n.md',
      content: '# v1',
      sessionId: 'sBase',
      message: 'base',
    });
    const oursHead = p.projection.headCommit;
    await h.git.writeNeuron({
      path: 'n.md',
      content: '# v2',
      sessionId: 's1',
      message: 'proposta',
    });
    await h.review.enterReview({
      path: 'n.md',
      reason: 'semantic-conflict',
      sessionId: 's1',
      holder: 'ai:s1',
      baseCommit: oursHead,
    });

    const res = await h.review.resolve({
      path: 'n.md',
      baseCommit: oursHead,
      content: '# final arbitrado',
      arbiter: 'human:tiago',
    });

    assert.notEqual(res.headCommit, oursHead, 'HEAD deve avancar apos aceitar');
    // Git integrou o texto arbitrado em main.
    assert.equal(await h.git.readNeuron('n.md'), '# final arbitrado');
    const row = h.fake.rows.get('n.md')!;
    assert.equal(row.lockState, 'FREE');
    assert.equal(row.reviewQueued, false);
    assert.equal(row.holder, null);
    assert.equal(row.headCommit, res.headCommit);
  } finally {
    cleanup(h.gitDir);
  }
});

test('resolve(descartar): HEAD estavel permanece, REVIEW -> FREE, ramo podado', async () => {
  const h = await makeHarness();
  try {
    const p = await h.index.commitAndReindex({
      path: 'n.md',
      content: '# v1',
      sessionId: 'sBase',
      message: 'base',
    });
    const oursHead = p.projection.headCommit;
    await h.git.writeNeuron({
      path: 'n.md',
      content: '# v2 descartado',
      sessionId: 's1',
      message: 'proposta',
    });
    await h.review.enterReview({
      path: 'n.md',
      reason: 'semantic-conflict',
      sessionId: 's1',
      holder: 'ai:s1',
      baseCommit: oursHead,
    });

    const res = await h.review.resolve({ path: 'n.md', baseCommit: oursHead });

    assert.equal(res.headCommit, oursHead, 'HEAD estavel inalterado ao descartar');
    assert.equal(await h.git.readNeuron('n.md'), '# v1');
    // Ramo efemero podado.
    const theirs = await h.git.readSessionBranch({ sessionId: 's1', path: 'n.md' });
    assert.equal(theirs, null);
    assert.equal(h.fake.rows.get('n.md')!.lockState, 'FREE');
  } finally {
    cleanup(h.gitDir);
  }
});

test('resolve: neuronio que nao esta em REVIEW -> MemoryNotInReviewError', async () => {
  const h = await makeHarness();
  try {
    await h.index.commitAndReindex({
      path: 'n.md',
      content: '# v1',
      sessionId: 'sBase',
      message: 'base',
    });
    await assert.rejects(
      () => h.review.resolve({ path: 'n.md', baseCommit: 'x' }),
      (err: unknown) => err instanceof MemoryNotInReviewError,
    );
  } finally {
    cleanup(h.gitDir);
  }
});

test('resolve: base defasado do HEAD estavel -> MemoryReviewStaleError', async () => {
  const h = await makeHarness();
  try {
    const p = await h.index.commitAndReindex({
      path: 'n.md',
      content: '# v1',
      sessionId: 'sBase',
      message: 'base',
    });
    await h.review.enterReview({
      path: 'n.md',
      reason: 'out-of-scope',
      sessionId: 's1',
      holder: 'ai:s1',
      baseCommit: p.projection.headCommit,
    });
    await assert.rejects(
      () =>
        h.review.resolve({
          path: 'n.md',
          baseCommit: 'sha-que-nao-casa-nem-com-base-nem-com-head',
          content: '# tenta',
        }),
      (err: unknown) => err instanceof MemoryReviewStaleError,
    );
  } finally {
    cleanup(h.gitDir);
  }
});
