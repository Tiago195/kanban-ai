import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectExplorerService } from './project-explorer.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { MemoryGitService } from '../memory/memory-git.service';

/**
 * US-PROJ7 — Project Explorer (SÓ leitura).
 *   (a) GET /projects/:id/memory → MemoryNeuronSummary[]: `tags` desserializado
 *       para ARRAY e NUNCA vaza leaseId/activeBranch/baseCommit/etc.
 *   (b) GET /projects/:id/memory/read → MemoryNeuronDetail (summary + content +
 *       headCommit).
 *   (c) GET /projects/:id/repo-info → trata "ainda não clonado" (localPath null)
 *       graciosamente: git fields null, modules [].
 *   (d) 404 quando o Project não existe.
 */

interface IndexRow {
  path: string;
  title: string;
  tags: string; // JSON string
  summary: string;
  lockState: string;
  holder: string | null;
  stale: boolean;
  archivedAt: Date | null;
  updatedAt: Date;
}

function makeIndexRow(over: Partial<IndexRow> = {}): IndexRow {
  return {
    path: 'modules/cards.md',
    title: 'Cards',
    tags: JSON.stringify(['domain', 'crud']),
    summary: 'Regras de cards',
    lockState: 'FREE',
    holder: null,
    stale: false,
    archivedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

function makeService(opts: {
  project?: { id: string; localPath: string | null } | null;
  projectRow?: Record<string, unknown> | null;
  indexRows?: IndexRow[];
  indexOne?: IndexRow | null;
  neuronContent?: string | null;
}): { svc: ProjectExplorerService } {
  const prisma = {
    project: {
      findUnique: async ({ select }: { select: Record<string, boolean> }) => {
        // repoInfo pede cloneState/lastSyncedAt/localPath/defaultBranch; os
        // outros métodos pedem id/localPath.
        if (opts.projectRow !== undefined && 'cloneState' in select) return opts.projectRow;
        return opts.project ?? null;
      },
    },
    memoryIndex: {
      findMany: async () => opts.indexRows ?? [],
      findUnique: async () => opts.indexOne ?? null,
    },
  } as unknown as PrismaService;

  const git = {
    readNeuron: async () => opts.neuronContent ?? null,
    resolveHead: async () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  } as unknown as MemoryGitService;

  return { svc: new ProjectExplorerService(prisma, git) };
}

test('listMemory: tags vem como ARRAY (desserializado do JSON)', async () => {
  const { svc } = makeService({
    project: { id: 'p1', localPath: null },
    indexRows: [makeIndexRow()],
  });
  const list = await svc.listMemory('p1');
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].tags, ['domain', 'crud']);
  assert.equal(Array.isArray(list[0].tags), true);
});

test('listMemory: NÃO vaza campos internos de coordenação', async () => {
  const { svc } = makeService({
    project: { id: 'p1', localPath: null },
    indexRows: [makeIndexRow()],
  });
  const [n] = await svc.listMemory('p1');
  for (const forbidden of [
    'leaseId',
    'activeBranch',
    'baseCommit',
    'expiresAt',
    'reviewQueued',
    'lastSeenCommit',
    'searchText',
    'headCommit',
  ]) {
    assert.ok(!(forbidden in n), `summary não deve conter ${forbidden}`);
  }
  // Campos esperados presentes:
  for (const key of ['path', 'title', 'tags', 'summary', 'lockState', 'holder', 'stale', 'archivedAt', 'updatedAt']) {
    assert.ok(key in n, `summary deve conter ${key}`);
  }
});

test('listMemory: lockState desconhecido cai para FREE (união fechada)', async () => {
  const { svc } = makeService({
    project: { id: 'p1', localPath: null },
    indexRows: [makeIndexRow({ lockState: 'WEIRD' }), makeIndexRow({ path: 'x.md', lockState: 'EDITING' })],
  });
  const list = await svc.listMemory('p1');
  assert.equal(list[0].lockState, 'FREE');
  assert.equal(list[1].lockState, 'EDITING');
});

test('listMemory: tags inválido/corrompido vira [] (defensivo)', async () => {
  const { svc } = makeService({
    project: { id: 'p1', localPath: null },
    indexRows: [makeIndexRow({ tags: 'not-json' })],
  });
  const [n] = await svc.listMemory('p1');
  assert.deepEqual(n.tags, []);
});

test('readMemory: merge summary + content + headCommit', async () => {
  const { svc } = makeService({
    project: { id: 'p1', localPath: null },
    indexOne: makeIndexRow(),
    neuronContent: '# Cards\ncorpo markdown',
  });
  const detail = await svc.readMemory('p1', 'modules/cards.md');
  assert.equal(detail.content, '# Cards\ncorpo markdown');
  assert.equal(detail.headCommit.length, 40);
  assert.deepEqual(detail.tags, ['domain', 'crud']);
  assert.equal(detail.title, 'Cards');
});

test('readMemory: neurônio sem linha no índice ainda retorna content+headCommit', async () => {
  const { svc } = makeService({
    project: { id: 'p1', localPath: null },
    indexOne: null,
    neuronContent: 'orfão',
  });
  const detail = await svc.readMemory('p1', 'modules/orphan.md');
  assert.equal(detail.content, 'orfão');
  assert.equal(detail.title, '');
  assert.deepEqual(detail.tags, []);
  assert.equal(detail.lockState, 'FREE');
});

test('repoInfo: Project ainda NÃO clonado (localPath null) → git fields null, modules []', async () => {
  const { svc } = makeService({
    projectRow: {
      cloneState: 'pending',
      lastSyncedAt: null,
      localPath: null,
      defaultBranch: null,
    },
  });
  const info = await svc.repoInfo('p1');
  assert.equal(info.cloneState, 'pending');
  assert.equal(info.defaultBranch, null);
  assert.equal(info.headCommit, null);
  assert.equal(info.lastSyncedAt, null);
  assert.deepEqual(info.modules, []);
});

test('repoInfo: lastSyncedAt é serializado para ISO string', async () => {
  const { svc } = makeService({
    projectRow: {
      cloneState: 'ready',
      lastSyncedAt: new Date('2026-02-02T03:04:05.000Z'),
      localPath: null,
      defaultBranch: 'main',
    },
  });
  const info = await svc.repoInfo('p1');
  assert.equal(info.lastSyncedAt, '2026-02-02T03:04:05.000Z');
  // localPath null ⇒ mesmo com defaultBranch na linha, não lemos git ⇒ mantém o da linha.
  assert.equal(info.defaultBranch, 'main');
});

test('404: Project inexistente lança NotFound em todos os métodos', async () => {
  const { svc } = makeService({ project: null, projectRow: null });
  await assert.rejects(() => svc.listMemory('nope'), /não encontrado/);
  await assert.rejects(() => svc.readMemory('nope', 'x.md'), /não encontrado/);
  await assert.rejects(() => svc.repoInfo('nope'), /não encontrado/);
});
