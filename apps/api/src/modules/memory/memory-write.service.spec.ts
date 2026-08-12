import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import { MemoryGitService } from './memory-git.service';
import { MemoryIndexService } from './memory-index.service';
import { MemoryEventsService } from './memory-events.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { MemoryStaleWriteError, MemoryWriteService } from './memory-write.service';

// --- MemoryWriteService: escrita otimista + compare-and-swap (ADR-0027, EP-79) ---
//
// Git roda de verdade num tmpdir; o Postgres e um fake in-memory que suporta o
// que Index + Write usam (findUnique/findMany/upsert/delete/deleteMany).

interface Row {
  path: string;
  headCommit: string;
  title: string;
  tags: string;
  summary: string;
  searchText: string;
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
      delete: async (a: { where: { path: string } }) => {
        if (!store.has(a.where.path)) throw new Error('not found');
        const row = store.get(a.where.path)!;
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-write-'));
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
  const events = new MemoryEventsService({ broadcast: () => undefined } as unknown as RealtimeService);
  const write = new MemoryWriteService(fake as unknown as PrismaService, gitStore, index, events);
  return { gitDir, git: gitStore, index, write, fake };
}

test('commit: escrita limpa integra em main e reindexa (retries=0)', async () => {
  const h = await makeHarness();
  try {
    const base = await h.git.resolveHead();
    const res = await h.write.commit({
      path: 'api/cards.md',
      content: '# Cards\n\nDominio de cards.',
      sessionId: 's1',
      baseCommit: base,
      message: 'add cards',
    });
    assert.equal(res.retries, 0);
    assert.equal(res.projection.title, 'Cards');
    // main avancou e o indice reflete o novo head.
    assert.equal(res.headCommit, await h.git.resolveHead());
    assert.equal(h.fake.rows.get('api/cards.md')!.headCommit, res.headCommit);
  } finally {
    cleanup(h.gitDir);
  }
});

test('commit: base stale mas rebase inline re-le e integra mesmo assim', async () => {
  const h = await makeHarness();
  try {
    const base0 = await h.git.resolveHead();
    // Primeiro escreve o proprio path -> passa a existir no indice com head H1.
    const first = await h.write.commit({
      path: 'mine.md',
      content: '# Mine v1',
      sessionId: 's1',
      baseCommit: base0,
      message: 'mine v1',
    });
    const head1 = first.headCommit;
    assert.equal(h.fake.rows.get('mine.md')?.headCommit, head1);

    // Segunda escrita do MESMO path com base DEFASADA (base0, nao head1):
    // o compare-and-swap detecta stale (head efetivo do path = head1 != base0),
    // adota head1 como novo base (rebase inline) e integra a proposta.
    const res = await h.write.commit({
      path: 'mine.md',
      content: '# Mine v2',
      sessionId: 's1',
      baseCommit: base0, // defasado em relacao ao head atual do path (head1)
      message: 'mine v2',
    });

    // A escrita stale foi reconciliada e integrada em main (nao lancou 409).
    assert.ok(h.fake.rows.has('mine.md'));
    assert.notEqual(res.headCommit, head1); // main avancou de fato
    assert.equal(h.fake.rows.get('mine.md')?.headCommit, res.headCommit);
  } finally {
    cleanup(h.gitDir);
  }
});

test('commit: stale persistente esgota retries -> MemoryStaleWriteError(stale)', async () => {
  const h = await makeHarness();
  try {
    // Semeia o path com um headCommit fixo e mantem main sempre a frente:
    // usamos maxRetries=0 e base propositalmente diferente do head para forcar 409.
    const head = await h.git.resolveHead();
    h.fake.rows.set('p.md', {
      path: 'p.md',
      headCommit: head,
      title: 'p',
      tags: '[]',
      summary: '',
      searchText: '',
      updatedAt: new Date(),
    });
    await assert.rejects(
      () =>
        h.write.commit({
          path: 'p.md',
          content: '# P2',
          sessionId: 's1',
          baseCommit: 'sha-que-nao-casa',
          message: 'm',
          maxRetries: 0,
        }),
      (err: unknown) => err instanceof MemoryStaleWriteError && err.reason === 'stale',
    );
  } finally {
    cleanup(h.gitDir);
  }
});

test('writeOptimistic: materializa no ramo efemero sem tocar main', async () => {
  const h = await makeHarness();
  try {
    const headBefore = await h.git.resolveHead();
    const { branch } = await h.write.writeOptimistic({
      path: 'z.md',
      content: '# Z',
      sessionId: 's1',
      message: 'z',
    });
    assert.match(branch, /^mem\/ai\/s1\//);
    // main NAO mudou (a integracao so acontece no commit()).
    assert.equal(await h.git.resolveHead(), headBefore);
    // o neuronio ainda nao existe em main.
    assert.equal(await h.git.readNeuron('z.md'), null);
  } finally {
    cleanup(h.gitDir);
  }
});

test('MemoryStaleWriteError: expoe path/base/head/reason', () => {
  const err = new MemoryStaleWriteError('a.md', 'b1', 'h1', 'conflict');
  assert.equal(err.name, 'MemoryStaleWriteError');
  assert.equal(err.reason, 'conflict');
  assert.equal(err.path, 'a.md');
});
