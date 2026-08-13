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
import { ProjectCredentialsService } from './project-credentials.service';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * US-PROJ3 — wiring das credenciais no clone/fetch gerenciado.
 *   (a) https+token: o token vem de uma ENV VAR (credentialRef) e é injetado no
 *       onAuth do isomorphic-git — clonamos de um servidor smart-HTTP LOCAL que
 *       EXIGE Basic auth e valida que o password recebido == token da env.
 *   (b) ssh desabilitado por default → failed + lastError legível.
 *   (c) redaction: o token NUNCA aparece em lastError nem nos eventos WS emitidos.
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

function makeRealtime(): { realtime: RealtimeService; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const realtime = { broadcast: (e: ServerEvent) => events.push(e) } as unknown as RealtimeService;
  return { realtime, events };
}

function makeConfig(dir: string, allowSsh = false): AppConfig {
  return { projects: { dir, gitTimeoutMs: 300_000, allowSsh } } as unknown as AppConfig;
}

function tmpRoot(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'proj-auth-'));
}

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
 * Servidor smart-HTTP LOCAL que EXIGE Basic auth. Registra o password recebido
 * (para asserção do wiring). Rejeita (401) se ausente/errado.
 */
async function startAuthedGitHttpServer(
  repoParent: string,
  expected: { username: string; password: string },
): Promise<{ baseUrl: string; close: () => Promise<void>; seenPasswords: string[] }> {
  const seenPasswords: string[] = [];
  const server = http.createServer((req, res) => {
    const authz = req.headers['authorization'];
    if (!authz || !authz.startsWith('Basic ')) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm="git"');
      res.end('auth required');
      return;
    }
    const decoded = Buffer.from(authz.slice('Basic '.length), 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    const pass = sepIdx === -1 ? '' : decoded.slice(sepIdx + 1);
    seenPasswords.push(pass);
    if (pass !== expected.password) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm="git"');
      res.end('bad credentials');
      return;
    }
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
    seenPasswords,
  };
}

test(
  'https+token: onAuth injeta o token da ENV var (clone autenticado chega a ready)',
  { skip: !GIT_AVAILABLE },
  async () => {
    const root = tmpRoot();
    makeLocalRepo(root);
    const token = 'ghp_env_resolved_token_xyz';
    const envVar = 'GH_TOKEN_PROJ3_TEST';
    process.env[envVar] = token;
    const srv = await startAuthedGitHttpServer(root, { username: 'x-access-token', password: token });
    try {
      const projectsDir = path.join(root, 'managed');
      const row = makeRow({
        repoUrl: `${srv.baseUrl}/remote-repo/.git`,
        authKind: 'https',
        credentialRef: envVar,
      });
      const { prisma, row: getRow } = makePrisma(row);
      const { realtime, events } = makeRealtime();
      const creds = new ProjectCredentialsService(makeConfig(projectsDir));
      const svc = new ProjectWorkspaceService(prisma, makeConfig(projectsDir), realtime, creds);

      const localPath = await svc.ensureCloned('p1');

      assert.equal(getRow().cloneState, 'ready', `esperado ready: ${getRow().lastError}`);
      assert.ok(fsSync.existsSync(path.join(localPath, 'README.md')));
      // Wiring provado: o servidor recebeu o token vindo da ENV (não o nome do ref).
      assert.ok(srv.seenPasswords.includes(token), 'servidor deve ter recebido o token da env');
      assert.ok(!srv.seenPasswords.includes(envVar), 'não deve enviar o NOME do ref como senha');
      // Redaction: nenhum evento WS carrega o token.
      for (const e of events) {
        assert.doesNotMatch(JSON.stringify(e), new RegExp(token));
      }
    } finally {
      delete process.env[envVar];
      await srv.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test('https+token: env var ausente → failed com lastError legível (sem vazar valor)', async () => {
  const root = tmpRoot();
  try {
    const projectsDir = path.join(root, 'managed');
    const envVar = 'GH_TOKEN_ABSENT_PROJ3';
    delete process.env[envVar];
    const row = makeRow({
      repoUrl: 'https://127.0.0.1:1/owner/repo.git',
      authKind: 'https',
      credentialRef: envVar,
    });
    const { prisma, row: getRow } = makePrisma(row);
    const { realtime, events } = makeRealtime();
    const creds = new ProjectCredentialsService(makeConfig(projectsDir));
    const svc = new ProjectWorkspaceService(prisma, makeConfig(projectsDir), realtime, creds);

    await assert.rejects(() => svc.ensureCloned('p1'), new RegExp(envVar));
    assert.equal(getRow().cloneState, 'failed');
    assert.match(getRow().lastError ?? '', new RegExp(envVar));
    assert.ok(!getRow().lastError!.includes('\n'), 'lastError legível (uma linha)');
    // Não deve nem sequer transicionar para cloning (falha cedo, sem resíduo no FS).
    const states = events
      .filter((e) => e.type === 'project.clone_state')
      .map((e) => (e as { state: string }).state);
    assert.deepEqual(states, ['failed']);
    assert.ok(!fsSync.existsSync(path.join(projectsDir, 'p1')), 'não deve deixar diretório');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ssh desabilitado (PROJECTS_ALLOW_SSH=false) → failed com erro claro', async () => {
  const root = tmpRoot();
  try {
    const projectsDir = path.join(root, 'managed');
    const row = makeRow({ repoUrl: 'git@github.com:owner/repo.git', authKind: 'ssh' });
    const { prisma, row: getRow } = makePrisma(row);
    const { realtime } = makeRealtime();
    const creds = new ProjectCredentialsService(makeConfig(projectsDir, false));
    const svc = new ProjectWorkspaceService(prisma, makeConfig(projectsDir, false), realtime, creds);

    await assert.rejects(() => svc.ensureCloned('p1'), /PROJECTS_ALLOW_SSH=true/);
    assert.equal(getRow().cloneState, 'failed');
    assert.match(getRow().lastError ?? '', /ssh/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
