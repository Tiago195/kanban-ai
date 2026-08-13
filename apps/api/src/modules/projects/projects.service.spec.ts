import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectsService } from './projects.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import { createProjectSchema } from './projects.schema';

/**
 * US-PROJ1 — CRUD de Project.
 *   (a) POST cria com cloneState='pending'.
 *   (b) DTO público NUNCA vaza credentialRef nem localPath.
 *   (c) validação Zod de repoUrl (https/ssh syntax).
 */

interface ProjectRow {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  authKind: 'none' | 'https' | 'ssh';
  credentialRef: string | null;
  localPath: string | null;
  cloneState: 'pending' | 'cloning' | 'ready' | 'failed';
  lastError: string | null;
  lastSyncedAt: Date | null;
  tenantId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeRow(over: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'p1',
    name: 'demo',
    repoUrl: 'https://github.com/owner/repo.git',
    defaultBranch: null,
    authKind: 'none',
    credentialRef: 'env:SECRET_TOKEN',
    localPath: '/srv/projects/p1',
    cloneState: 'pending',
    lastError: null,
    lastSyncedAt: null,
    tenantId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function makeService(): {
  svc: ProjectsService;
  lastCreateData: () => Record<string, unknown> | undefined;
} {
  let created: Record<string, unknown> | undefined;
  const prisma = {
    project: {
      findMany: async () => [makeRow()],
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'p1' ? makeRow() : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created = data;
        return makeRow({
          cloneState: (data.cloneState as ProjectRow['cloneState']) ?? 'pending',
          name: data.name as string,
          repoUrl: data.repoUrl as string,
          authKind: (data.authKind as ProjectRow['authKind']) ?? 'none',
        });
      },
    },
  } as unknown as PrismaService;
  return { svc: new ProjectsService(prisma), lastCreateData: () => created };
}

test('create: novo Project nasce com cloneState="pending"', async () => {
  const { svc } = makeService();
  const dto = await svc.create({ name: 'demo', repoUrl: 'https://github.com/owner/repo.git' });
  assert.equal(dto.cloneState, 'pending');
  assert.equal(dto.name, 'demo');
});

test('DTO público NÃO vaza credentialRef nem localPath (create/findOne/findAll)', async () => {
  const { svc } = makeService();
  const created = await svc.create({ name: 'demo', repoUrl: 'https://github.com/owner/repo.git' });
  const one = await svc.findOne('p1');
  const [listed] = await svc.findAll();
  for (const dto of [created, one, listed]) {
    assert.ok(!('credentialRef' in dto), 'DTO não deve conter credentialRef');
    assert.ok(!('localPath' in dto), 'DTO não deve conter localPath');
  }
});

test('findOne: id inexistente lança NotFound', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.findOne('nope'), /não encontrado/);
});

test('repoUrl: aceita https e ssh; rejeita lixo', () => {
  assert.ok(createProjectSchema.safeParse({ name: 'a', repoUrl: 'https://github.com/o/r.git' }).success);
  assert.ok(createProjectSchema.safeParse({ name: 'a', repoUrl: 'git@github.com:o/r.git' }).success);
  assert.ok(createProjectSchema.safeParse({ name: 'a', repoUrl: 'ssh://git@host/o/r.git' }).success);
  assert.ok(!createProjectSchema.safeParse({ name: 'a', repoUrl: 'not a url' }).success);
  assert.ok(!createProjectSchema.safeParse({ name: '', repoUrl: 'https://x' }).success);
});
