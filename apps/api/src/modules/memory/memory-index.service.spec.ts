import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import { MemoryGitService } from './memory-git.service';
import { MemoryIndexService, MemoryWriteConflictError } from './memory-index.service';

// --- MemoryIndexService: indice Postgres derivado (ADR-0027, Camada 2) ---
//
// O indice e uma projecao descartavel do git (Camada 1 = fonte da verdade).
// Aqui o git roda de verdade num tmpdir; o Postgres e substituido por um fake
// in-memory que implementa APENAS o subconjunto de `memoryIndex` consumido
// pelo servico (upsert/delete/deleteMany/findMany). Isso valida a ORQUESTRACAO
// (ordem git -> indice, idempotencia, rebuild, query) sem depender de um DB.

interface Row {
  path: string;
  headCommit: string;
  title: string;
  tags: string;
  summary: string;
  searchText: string;
  updatedAt: Date;
}

/** Fake in-memory do `prisma.memoryIndex` (so o que o servico usa). */
class FakeMemoryIndex {
  readonly rows = new Map<string, Row>();
  private clock = 0;

  get memoryIndex() {
    const store = this.rows;
    const nextClock = () => new Date(2026, 0, 1, 0, 0, ++this.clock);
    return {
      upsert: async (args: {
        where: { path: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = store.get(args.where.path);
        const base = existing ?? { path: args.where.path };
        const merged = {
          ...base,
          ...(existing ? args.update : args.create),
          updatedAt: nextClock(),
        } as Row;
        store.set(args.where.path, merged);
        return merged;
      },
      delete: async (args: { where: { path: string } }) => {
        if (!store.has(args.where.path)) {
          throw new Error('not found');
        }
        const row = store.get(args.where.path)!;
        store.delete(args.where.path);
        return row;
      },
      deleteMany: async () => {
        const count = store.size;
        store.clear();
        return { count };
      },
      findMany: async (args?: {
        where?: {
          OR?: Array<Record<string, { contains: string }>>;
          path?: { startsWith?: string };
        };
        take?: number;
      }) => {
        let list = [...store.values()];
        // US-PROJ4 — filtro de namespace (prefixo de path) aplicado antes do termo.
        const startsWith = args?.where?.path?.startsWith;
        if (startsWith) {
          list = list.filter((r) => r.path.startsWith(startsWith));
        }
        const or = args?.where?.OR;
        if (or) {
          const term = Object.values(or[0])[0].contains.toLowerCase();
          list = list.filter((r) =>
            [r.title, r.summary, r.searchText, r.path]
              .join('\n')
              .toLowerCase()
              .includes(term),
          );
        }
        list.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return args?.take ? list.slice(0, args.take) : list;
      },
    };
  }
}

function makeTmpGitDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-memidx-'));
  return path.join(root, 'git');
}

function cleanup(gitDir: string): void {
  fs.rmSync(path.dirname(gitDir), { recursive: true, force: true });
}

/** Provisiona git real + fake prisma e devolve os dois servicos prontos. */
async function makeHarness(): Promise<{
  gitDir: string;
  git: MemoryGitService;
  index: MemoryIndexService;
  fake: FakeMemoryIndex;
}> {
  const gitDir = makeTmpGitDir();
  const config = { memory: { gitDir } } as unknown as AppConfig;
  const gitStore = new MemoryGitService(config);
  await gitStore.provision();
  const fake = new FakeMemoryIndex();
  const index = new MemoryIndexService(fake as unknown as PrismaService, gitStore);
  return { gitDir, git: gitStore, index, fake };
}

test('commitAndReindex: escreve no git ANTES do indice e projeta o neuronio', async () => {
  const h = await makeHarness();
  try {
    const res = await h.index.commitAndReindex({
      path: 'notes/pool.md',
      content: '# Connection Pool\n\ntags: infra db\n\nO pool reutiliza conexoes.',
      sessionId: 'sess-1',
      message: 'add pool note',
    });

    // Git integrou em main (a projecao aponta pro head atual).
    const head = await h.git.resolveHead();
    assert.equal(res.projection.headCommit, head);
    assert.equal(res.projection.title, 'Connection Pool');
    assert.deepEqual(res.projection.tags, ['infra', 'db']);

    // O indice reflete o mesmo estado.
    const row = h.fake.rows.get('notes/pool.md');
    assert.ok(row);
    assert.equal(row!.headCommit, head);
    assert.equal(row!.title, 'Connection Pool');
  } finally {
    cleanup(h.gitDir);
  }
});

test('reindexOne: idempotente (rodar N vezes converge para o mesmo estado)', async () => {
  const h = await makeHarness();
  try {
    await h.index.commitAndReindex({
      path: 'a.md',
      content: '# A\n\ncorpo',
      sessionId: 's',
      message: 'm',
    });
    const first = await h.index.reindexOne('a.md');
    const second = await h.index.reindexOne('a.md');
    assert.deepEqual(first, second);
    assert.equal(h.fake.rows.size, 1);
  } finally {
    cleanup(h.gitDir);
  }
});

test('reindexOne: neuronio ausente no git remove a projecao e retorna null', async () => {
  const h = await makeHarness();
  try {
    // Semeia uma projecao orfa (nao existe no git).
    await h.fake.memoryIndex.upsert({
      where: { path: 'ghost.md' },
      create: {
        path: 'ghost.md',
        headCommit: 'x',
        title: 'ghost',
        tags: '[]',
        summary: '',
        searchText: '',
      },
      update: {},
    });
    assert.ok(h.fake.rows.has('ghost.md'));

    const res = await h.index.reindexOne('ghost.md');
    assert.equal(res, null);
    assert.equal(h.fake.rows.has('ghost.md'), false);
  } finally {
    cleanup(h.gitDir);
  }
});

test('rebuildAll: reconstroi o indice inteiro do git (fonte da verdade)', async () => {
  const h = await makeHarness();
  try {
    await h.index.commitAndReindex({ path: 'x/1.md', content: '# Um', sessionId: 's', message: 'm' });
    await h.index.commitAndReindex({ path: 'x/2.md', content: '# Dois', sessionId: 's', message: 'm' });

    // Corrompe o indice: apaga tudo e injeta lixo. rebuild deve corrigir.
    h.fake.rows.clear();
    h.fake.rows.set('lixo.md', {
      path: 'lixo.md',
      headCommit: 'z',
      title: 'lixo',
      tags: '[]',
      summary: '',
      searchText: '',
      updatedAt: new Date(),
    });

    const count = await h.index.rebuildAll();
    assert.equal(count, 2);
    assert.equal(h.fake.rows.has('lixo.md'), false);
    assert.ok(h.fake.rows.has('x/1.md'));
    assert.ok(h.fake.rows.has('x/2.md'));
  } finally {
    cleanup(h.gitDir);
  }
});

test('query: filtra case-insensitive por termo; sem termo lista tudo', async () => {
  const h = await makeHarness();
  try {
    await h.index.commitAndReindex({
      path: 'auth.md',
      content: '# Autenticacao\n\nUsa JWT e refresh token.',
      sessionId: 's',
      message: 'm',
    });
    await h.index.commitAndReindex({
      path: 'cache.md',
      content: '# Cache\n\nRedis com TTL.',
      sessionId: 's',
      message: 'm',
    });

    const hits = await h.index.query('JWT');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, 'auth.md');

    const all = await h.index.query();
    assert.equal(all.length, 2);
  } finally {
    cleanup(h.gitDir);
  }
});

test('MemoryWriteConflictError: exportado e nomeado para tratamento na Camada 2', () => {
  const err = new MemoryWriteConflictError('p.md');
  assert.equal(err.name, 'MemoryWriteConflictError');
  assert.equal(err.path, 'p.md');
});

// US-PROJ4 (§1.2 / decisão #6) — query com pathPrefix restringe a busca ao
// namespace do Project; sem pathPrefix, busca global (legado).
test('query: pathPrefix restringe ao namespace do Project (isola colmeias)', async () => {
  const h = await makeHarness();
  try {
    await h.index.commitAndReindex({
      path: 'projects/proj-A/modules/auth.md',
      content: '# Autenticacao\n\nUsa JWT.',
      sessionId: 's',
      message: 'm',
    });
    await h.index.commitAndReindex({
      path: 'projects/proj-B/modules/auth.md',
      content: '# Autenticacao\n\nUsa JWT tambem.',
      sessionId: 's',
      message: 'm',
    });
    await h.index.commitAndReindex({
      path: 'modules/auth.md',
      content: '# Autenticacao\n\nJWT legado global.',
      sessionId: 's',
      message: 'm',
    });

    // Sem prefixo: busca global encontra os 3.
    const all = await h.index.query('JWT');
    assert.equal(all.length, 3, 'sem pathPrefix, busca é global (legado)');

    // Com prefixo do Project A: só o neurônio de A.
    const onlyA = await h.index.query('JWT', 20, 'projects/proj-A');
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0].path, 'projects/proj-A/modules/auth.md');

    // Prefixo tolera barra final e não vaza para B nem para o global.
    const onlyB = await h.index.query('JWT', 20, 'projects/proj-B/');
    assert.equal(onlyB.length, 1);
    assert.equal(onlyB[0].path, 'projects/proj-B/modules/auth.md');
  } finally {
    cleanup(h.gitDir);
  }
});
