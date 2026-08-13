import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import type { ServerEvent } from '@kanban-ai/shared';
import { ProjectWorkspaceService } from './project-workspace.service';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * US-PROJ2 — ProjectWorkspaceService (clone/sync/remove gerenciado).
 *
 * Testes DETERMINÍSTICOS e OFFLINE: isomorphic-git só fala http(s) (NÃO suporta
 * `file://` — `UnknownTransportError`), então subimos um servidor smart-HTTP
 * LOCAL delegando ao `git http-backend` (CGI) sobre `http.createServer`, e
 * clonamos de `http://127.0.0.1:<porta>/...`. Exercita o MESMO caminho
 * `git.clone` do isomorphic-git sem flakiness de rede.
 *
 * NOTA (smoke real): um clone contra um repositório público https REAL
 * (`https://github.com/octocat/Hello-World.git`) foi considerado e é o alvo do
 * smoke manual documentado no relatório da story — aqui priorizamos determinismo.
 *
 * Se `git` não estiver disponível, os testes que dependem do servidor são
 * pulados (skip); o guard-rail e o caminho de falha continuam sendo testados.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

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
    repoUrl: 'https://example.invalid/owner/repo.git',
    defaultBranch: null,
    authKind: 'none',
    credentialRef: null,
    localPath: null,
    cloneState: 'pending',
    lastError: null,
    lastSyncedAt: null,
    tenantId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** Prisma fake in-memory: guarda a linha e aplica updates parciais. */
function makePrisma(initial: ProjectRow): { prisma: PrismaService; row: () => ProjectRow } {
  let current = { ...initial };
  const prisma = {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === current.id ? { ...current } : null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<ProjectRow> }) => {
        if (where.id !== current.id) throw new Error('not found');
        current = { ...current, ...data };
        return { ...current };
      },
    },
  } as unknown as PrismaService;
  return { prisma, row: () => current };
}

/** RealtimeService fake que acumula os eventos emitidos. */
function makeRealtime(): { realtime: RealtimeService; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const realtime = {
    broadcast: (e: ServerEvent) => {
      events.push(e);
    },
  } as unknown as RealtimeService;
  return { realtime, events };
}

function makeConfig(dir: string): AppConfig {
  return { projects: { dir, gitTimeoutMs: 300_000 } } as unknown as AppConfig;
}

function tmpRoot(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'proj-ws-'));
}

function statesFrom(events: ServerEvent[]): string[] {
  return events
    .filter((e) => e.type === 'project.clone_state')
    .map((e) => (e as { state: string }).state);
}

/** Cria um repositório git LOCAL com 1 commit; retorna seu path absoluto. */
function makeLocalRepo(root: string): string {
  const repo = path.join(root, 'remote-repo');
  fsSync.mkdirSync(repo, { recursive: true });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, env });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@kanban-ai.local']);
  run(['config', 'user.name', 'test']);
  run(['config', 'http.receivepack', 'true']);
  fsSync.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'chore: initial']);
  run(['update-server-info']);
  return repo;
}

/**
 * Sobe um servidor smart-HTTP LOCAL delegando ao `git http-backend` (CGI).
 * Retorna a base URL (`http://127.0.0.1:<porta>`) e um `close()`.
 */
async function startGitHttpServer(
  repoParent: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: repoParent,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.searchParams.toString(),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
    };
    const cp = spawn('git', ['http-backend'], { env });
    const chunks: Buffer[] = [];
    cp.stdout.on('data', (c) => chunks.push(c as Buffer));
    cp.on('close', () => {
      const out = Buffer.concat(chunks);
      const sep = out.indexOf('\r\n\r\n');
      if (sep === -1) {
        res.statusCode = 500;
        res.end('bad cgi');
        return;
      }
      const header = out.subarray(0, sep).toString('utf8');
      const body = out.subarray(sep + 4);
      let status = 200;
      for (const line of header.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (/^status$/i.test(k)) status = parseInt(v, 10) || 200;
        else if (k) res.setHeader(k, v);
      }
      res.statusCode = status;
      res.end(body);
    });
    req.pipe(cp.stdin);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test(
  'ensureCloned: repo http local chega a ready com localPath e git log',
  { skip: !GIT_AVAILABLE },
  async () => {
    const root = tmpRoot();
    makeLocalRepo(root);
    const srv = await startGitHttpServer(root);
    try {
      const projectsDir = path.join(root, 'managed');
      const row = makeRow({ repoUrl: `${srv.baseUrl}/remote-repo/.git` });
      const { prisma, row: getRow } = makePrisma(row);
      const { realtime, events } = makeRealtime();
      const svc = new ProjectWorkspaceService(prisma, makeConfig(projectsDir), realtime);

      const localPath = await svc.ensureCloned('p1');

      assert.equal(localPath, path.join(projectsDir, 'p1'));
      assert.equal(
        getRow().cloneState,
        'ready',
        `esperado ready, veio ${getRow().cloneState}: ${getRow().lastError}`,
      );
      assert.equal(getRow().localPath, localPath);
      assert.equal(getRow().lastError, null);
      assert.ok(fsSync.existsSync(path.join(localPath, '.git')));
      assert.ok(fsSync.existsSync(path.join(localPath, 'README.md')));
      assert.deepEqual(statesFrom(events), ['cloning', 'ready']);
    } finally {
      await srv.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test('ensureCloned: URL inválida → failed + lastError legível (sem stacktrace)', async () => {
  const root = tmpRoot();
  try {
    const projectsDir = path.join(root, 'managed');
    // Porta fechada → erro de transporte http, convertido em mensagem legível.
    const row = makeRow({ repoUrl: 'http://127.0.0.1:1/nonexistent/repo.git' });
    const { prisma, row: getRow } = makePrisma(row);
    const { realtime, events } = makeRealtime();
    const svc = new ProjectWorkspaceService(prisma, makeConfig(projectsDir), realtime);

    // Em falha, o serviço marca `failed` + emite evento e RE-LANÇA (mensagem legível).
    await assert.rejects(() => svc.ensureCloned('p1'));

    assert.equal(getRow().cloneState, 'failed');
    assert.ok(getRow().lastError, 'lastError deve estar preenchido');
    assert.ok(
      !getRow().lastError!.includes('\n'),
      'lastError deve ser legível (uma linha, sem stacktrace)',
    );
    const failed = events.find(
      (e) => e.type === 'project.clone_state' && (e as { state: string }).state === 'failed',
    ) as { error?: string } | undefined;
    assert.ok(failed, 'deve emitir evento failed');
    assert.ok(failed!.error, 'evento failed deve carregar error');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('guard-rail: PROJECTS_DIR dentro do kanban-ai é recusado', async () => {
  const insideDir = path.join(process.cwd(), '.tmp-projects-guard');
  const row = makeRow({ repoUrl: 'http://127.0.0.1:1/whatever.git' });
  const { prisma } = makePrisma(row);
  const { realtime } = makeRealtime();
  const svc = new ProjectWorkspaceService(prisma, makeConfig(insideDir), realtime);
  await assert.rejects(() => svc.ensureCloned('p1'), /DENTRO do repo do kanban-ai/);
});

test(
  'ensureCloned: chamadas concorrentes do MESMO id serializam (mesma Promise)',
  { skip: !GIT_AVAILABLE },
  async () => {
    const root = tmpRoot();
    makeLocalRepo(root);
    const srv = await startGitHttpServer(root);
    try {
      const projectsDir = path.join(root, 'managed');
      const row = makeRow({ repoUrl: `${srv.baseUrl}/remote-repo/.git` });
      const { prisma, row: getRow } = makePrisma(row);
      const { realtime, events } = makeRealtime();
      const svc = new ProjectWorkspaceService(prisma, makeConfig(projectsDir), realtime);

      const [a, b] = await Promise.all([svc.ensureCloned('p1'), svc.ensureCloned('p1')]);
      assert.equal(a, b);
      assert.equal(getRow().cloneState, 'ready');
      // Serializado: um único par cloning→ready (não dois clones concorrentes).
      assert.deepEqual(statesFrom(events), ['cloning', 'ready']);
    } finally {
      await srv.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test('sync: atualiza lastSyncedAt após fetch+checkout', { skip: !GIT_AVAILABLE }, async () => {
  const root = tmpRoot();
  makeLocalRepo(root);
  const srv = await startGitHttpServer(root);
  try {
    const projectsDir = path.join(root, 'managed');
    const row = makeRow({ repoUrl: `${srv.baseUrl}/remote-repo/.git`, defaultBranch: 'main' });
    const { prisma, row: getRow } = makePrisma(row);
    const { realtime } = makeRealtime();
    const svc = new ProjectWorkspaceService(prisma, makeConfig(projectsDir), realtime);

    await svc.ensureCloned('p1');
    const afterClone = getRow().lastSyncedAt;
    assert.ok(afterClone instanceof Date, 'ensureCloned marca lastSyncedAt no ready');
    await new Promise((r) => setTimeout(r, 5));
    await svc.sync('p1');
    const afterSync = getRow().lastSyncedAt;
    assert.ok(afterSync instanceof Date, 'sync mantém/atualiza lastSyncedAt');
    assert.ok(
      afterSync!.getTime() >= afterClone!.getTime(),
      'sync deve avançar (ou manter) lastSyncedAt',
    );
  } finally {
    await srv.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remove: apaga o diretório gerenciado (idempotente)', { skip: !GIT_AVAILABLE }, async () => {
  const root = tmpRoot();
  makeLocalRepo(root);
  const srv = await startGitHttpServer(root);
  try {
    const projectsDir = path.join(root, 'managed');
    const row = makeRow({ repoUrl: `${srv.baseUrl}/remote-repo/.git` });
    const { prisma } = makePrisma(row);
    const { realtime } = makeRealtime();
    const svc = new ProjectWorkspaceService(prisma, makeConfig(projectsDir), realtime);

    const localPath = await svc.ensureCloned('p1');
    assert.ok(fsSync.existsSync(localPath));
    await svc.remove('p1');
    assert.ok(!fsSync.existsSync(localPath), 'diretório deve ter sido removido');
    await svc.remove('p1'); // idempotente
  } finally {
    await srv.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
