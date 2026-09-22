import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectExplorerService } from './project-explorer.service';
import { ProjectHiveService } from './project-hive.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { AppConfig } from '../../shared/config/config';

/**
 * US-PROJ7 — Project Explorer (SÓ leitura), lado do REPO + 404.
 *
 * US-F2.3 — as specs do caminho legado de memória (`MemoryIndex` + git da
 * memória) morreram junto com o substrato; a leitura da colmeia do clone é
 * coberta por `project-explorer.hive.spec.ts`. Aqui fica o que sempre foi
 * independente da memória:
 *   (c) GET /projects/:id/repo-info → trata "ainda não clonado" (localPath
 *       null) graciosamente: git fields null, modules [];
 *   (d) 404 quando o Project não existe.
 */

function makeService(opts: {
  project?: { id: string; localPath: string | null } | null;
  projectRow?: Record<string, unknown> | null;
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
  } as unknown as PrismaService;
  const hive = new ProjectHiveService({ projects: { dir: '/tmp/nao-usado' } } as unknown as AppConfig);
  return { svc: new ProjectExplorerService(prisma, hive) };
}

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
