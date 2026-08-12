import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import { MemoryGitService } from './memory-git.service';
import { MemoryEventsService } from './memory-events.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import {
  MemoryLeaseExpiredError,
  MemoryLockHeldError,
  MemoryLockService,
  MemoryNotHolderError,
} from './memory-lock.service';

// --- MemoryLockService: locks advisory + presenca (ADR-0027, EP-78) ---
//
// Fake in-memory do `prisma.memoryIndex` cobrindo o subconjunto usado pelo
// lock service (findUnique/findMany/upsert/update). Datas ficam como Date, como
// no Postgres. O git roda de verdade num tmpdir (para resolveHead).

interface Row {
  path: string;
  headCommit: string;
  lockState: string;
  holder: string | null;
  leaseId: string | null;
  expiresAt: Date | null;
  baseCommit: string | null;
  activeBranch: string | null;
}

class FakeIndex {
  readonly rows = new Map<string, Row>();

  private normalize(r: Partial<Row> & { path: string }): Row {
    return {
      path: r.path,
      headCommit: r.headCommit ?? '',
      lockState: r.lockState ?? 'FREE',
      holder: r.holder ?? null,
      leaseId: r.leaseId ?? null,
      expiresAt: r.expiresAt ?? null,
      baseCommit: r.baseCommit ?? null,
      activeBranch: r.activeBranch ?? null,
    };
  }

  get memoryIndex() {
    const store = this.rows;
    const norm = this.normalize.bind(this);
    return {
      findUnique: async (a: { where: { path: string } }) => store.get(a.where.path) ?? null,
      findMany: async (a?: {
        where?: { lockState?: string; expiresAt?: { lte: Date } };
      }) => {
        let list = [...store.values()];
        const w = a?.where;
        if (w?.lockState) list = list.filter((r) => r.lockState === w.lockState);
        if (w?.expiresAt?.lte) {
          const cut = w.expiresAt.lte.getTime();
          list = list.filter((r) => r.expiresAt !== null && r.expiresAt.getTime() <= cut);
        }
        return list.map((r) => ({ path: r.path }));
      },
      upsert: async (a: {
        where: { path: string };
        create: Partial<Row> & { path: string };
        update: Partial<Row>;
      }) => {
        const existing = store.get(a.where.path);
        const merged = existing
          ? norm({ ...existing, ...a.update })
          : norm(a.create);
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
    };
  }
}

function makeTmpGitDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-lock-'));
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
  const events = new MemoryEventsService({ broadcast: () => undefined } as unknown as RealtimeService);
  const lock = new MemoryLockService(fake as unknown as PrismaService, gitStore, events);
  return { gitDir, git: gitStore, lock, fake };
}

test('acquire: FREE -> EDITING devolve baseCommit + leaseId + expiresAt', async () => {
  const h = await makeHarness();
  try {
    const res = await h.lock.acquire('api/cards.md', 'agent-1', 1000);
    const head = await h.git.resolveHead();
    assert.equal(res.baseCommit, head);
    assert.match(res.leaseId, /^lease_agent-1_/);
    assert.ok(res.expiresAt > Date.now());
    const row = h.fake.rows.get('api/cards.md')!;
    assert.equal(row.lockState, 'EDITING');
    assert.equal(row.holder, 'agent-1');
  } finally {
    cleanup(h.gitDir);
  }
});

test('acquire: outro holder com lease ativo -> MemoryLockHeldError', async () => {
  const h = await makeHarness();
  try {
    await h.lock.acquire('p.md', 'agent-1', 5000);
    await assert.rejects(() => h.lock.acquire('p.md', 'agent-2', 5000), MemoryLockHeldError);
  } finally {
    cleanup(h.gitDir);
  }
});

test('acquire: mesmo holder re-adquire (idempotente, mantem leaseId)', async () => {
  const h = await makeHarness();
  try {
    const first = await h.lock.acquire('p.md', 'agent-1', 5000);
    const again = await h.lock.acquire('p.md', 'agent-1', 5000);
    assert.equal(again.leaseId, first.leaseId);
  } finally {
    cleanup(h.gitDir);
  }
});

test('acquire: lease expirado de outro holder e sobrescrito (auto-release lazy)', async () => {
  const h = await makeHarness();
  try {
    await h.lock.acquire('p.md', 'agent-1', 1); // expira quase imediato
    await new Promise((r) => setTimeout(r, 5));
    const res = await h.lock.acquire('p.md', 'agent-2', 5000);
    assert.ok(res.leaseId.includes('agent-2'));
    assert.equal(h.fake.rows.get('p.md')!.holder, 'agent-2');
  } finally {
    cleanup(h.gitDir);
  }
});

test('heartbeat: holder renova empurrando expiresAt', async () => {
  const h = await makeHarness();
  try {
    const acq = await h.lock.acquire('p.md', 'agent-1', 1000);
    await new Promise((r) => setTimeout(r, 5));
    const next = await h.lock.heartbeat('p.md', 'agent-1', 5000);
    assert.ok(next > acq.expiresAt);
  } finally {
    cleanup(h.gitDir);
  }
});

test('heartbeat: nao-holder -> MemoryNotHolderError', async () => {
  const h = await makeHarness();
  try {
    await h.lock.acquire('p.md', 'agent-1', 5000);
    await assert.rejects(() => h.lock.heartbeat('p.md', 'agent-2'), MemoryNotHolderError);
  } finally {
    cleanup(h.gitDir);
  }
});

test('heartbeat: apos expirar -> MemoryLeaseExpiredError e libera', async () => {
  const h = await makeHarness();
  try {
    await h.lock.acquire('p.md', 'agent-1', 1);
    await new Promise((r) => setTimeout(r, 5));
    await assert.rejects(() => h.lock.heartbeat('p.md', 'agent-1'), MemoryLeaseExpiredError);
    assert.equal(h.fake.rows.get('p.md')!.lockState, 'FREE');
  } finally {
    cleanup(h.gitDir);
  }
});

test('release: holder solta EDITING -> FREE (idempotente)', async () => {
  const h = await makeHarness();
  try {
    await h.lock.acquire('p.md', 'agent-1', 5000);
    await h.lock.release('p.md', 'agent-1');
    assert.equal(h.fake.rows.get('p.md')!.lockState, 'FREE');
    await h.lock.release('p.md', 'agent-1'); // no-op, nao lanca
  } finally {
    cleanup(h.gitDir);
  }
});

test('release: nao-holder -> MemoryNotHolderError', async () => {
  const h = await makeHarness();
  try {
    await h.lock.acquire('p.md', 'agent-1', 5000);
    await assert.rejects(() => h.lock.release('p.md', 'agent-2'), MemoryNotHolderError);
  } finally {
    cleanup(h.gitDir);
  }
});

test('expireStale: libera todos os leases vencidos', async () => {
  const h = await makeHarness();
  try {
    await h.lock.acquire('a.md', 'agent-1', 1);
    await h.lock.acquire('b.md', 'agent-1', 100000);
    await new Promise((r) => setTimeout(r, 5));
    const freed = await h.lock.expireStale();
    assert.equal(freed, 1);
    assert.equal(h.fake.rows.get('a.md')!.lockState, 'FREE');
    assert.equal(h.fake.rows.get('b.md')!.lockState, 'EDITING');
  } finally {
    cleanup(h.gitDir);
  }
});

test('acquireMany: ordena paths e faz rollback se algum estiver preso (anti-deadlock)', async () => {
  const h = await makeHarness();
  try {
    // agent-2 ja segura "b.md".
    await h.lock.acquire('b.md', 'agent-2', 60000);
    // agent-1 tenta [c, a, b] -> pega a,c mas b esta preso -> rollback total.
    await assert.rejects(
      () => h.lock.acquireMany(['c.md', 'a.md', 'b.md'], 'agent-1'),
      MemoryLockHeldError,
    );
    // Nenhum dos que agent-1 pegou pode ficar preso por ele.
    assert.notEqual(h.fake.rows.get('a.md')?.holder, 'agent-1');
    assert.notEqual(h.fake.rows.get('c.md')?.holder, 'agent-1');
  } finally {
    cleanup(h.gitDir);
  }
});

test('acquireMany: sucesso adquire todos para o mesmo holder', async () => {
  const h = await makeHarness();
  try {
    const map = await h.lock.acquireMany(['x.md', 'y.md'], 'agent-1', 5000);
    assert.equal(map.size, 2);
    assert.equal(h.fake.rows.get('x.md')!.holder, 'agent-1');
    assert.equal(h.fake.rows.get('y.md')!.holder, 'agent-1');
  } finally {
    cleanup(h.gitDir);
  }
});
