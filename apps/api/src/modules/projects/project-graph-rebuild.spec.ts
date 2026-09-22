import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm as rmFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectGraphService } from './project-graph.service';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * US-F1.5 — rebuild INCREMENTAL do grafo ao fim da iteração do loop.
 *
 * Testes determinísticos e offline (wrapper fake via http.createServer, mesmo
 * padrão do project-graph.service.spec.ts) sobre o que realmente pode quebrar:
 *   (a) flag desligada (default) → NENHUMA chamada sai;
 *   (b) coalescing: rajada de N pedidos = 1 build (união dos arquivos); pedidos
 *       chegando DURANTE um build em voo = 1 build a mais ao final, não N;
 *   (c) fire-and-forget: build 500 / sidecar fora NUNCA propaga erro;
 *   (d) force periódico: a cada N builds do MESMO Project, um build completo
 *       com `force: true` (sem files) e o contador reseta;
 *   (e) extração dos paths do diff via git real (repo temporário): modificado,
 *       deletado, renomeado (delete+add via --no-renames), path com espaço e
 *       arquivo novo (via add -A -N);
 *   (f) grafo não-`ready` → rebuild pulado (merge incremental sem build
 *       inicial criaria um grafo só com os arquivos da iteração).
 */

function makeConfig(
  buildUrl: string,
  over: { apiKey?: string; enabled?: boolean; forceEvery?: number } = {},
): AppConfig {
  return {
    graphify: {
      buildUrl,
      apiKey: over.apiKey ?? 'test-key',
      buildTimeoutMs: 5_000,
      incrementalRebuildEnabled: over.enabled ?? true,
      incrementalForceEvery: over.forceEvery ?? 10,
    },
  } as unknown as AppConfig;
}

function makePrisma(graphState: string | null = 'ready'): {
  prisma: PrismaService;
  builtAtWrites: () => number;
} {
  let writes = 0;
  const prisma = {
    project: {
      findUnique: async () => (graphState ? { graphState } : null),
      update: async () => {
        writes += 1;
        return {};
      },
    },
  } as unknown as PrismaService;
  return { prisma, builtAtWrites: () => writes };
}

const realtime = { broadcast: () => undefined } as unknown as RealtimeService;

interface CapturedBuild {
  files?: string[];
  force?: boolean;
  projectId?: string;
}

/** Wrapper fake que captura os BODIES dos POST /build; delayMs atrasa a resposta. */
async function fakeWrapper(delayMs = 0): Promise<{
  url: string;
  close: () => Promise<void>;
  builds: CapturedBuild[];
  status: { code: number };
}> {
  const builds: CapturedBuild[] = [];
  const status = { code: 200 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/build') builds.push(JSON.parse(raw) as CapturedBuild);
      const reply = (): void => {
        res.writeHead(status.code, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            status.code === 200
              ? { ok: true, nodes: 10, edges: 5, durationMs: 9_100, incremental: true }
              : { ok: false, error: 'build falhou' },
          ),
        );
      };
      if (delayMs > 0) setTimeout(reply, delayMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    builds,
    status,
  };
}

test('US-F1.5 (a): flag desligada (default) → nenhuma chamada sai, nada muda', async () => {
  const wrapper = await fakeWrapper();
  try {
    const { prisma, builtAtWrites } = makePrisma();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url, { enabled: false }), realtime);
    svc.rebuildDebounceMs = 1;
    assert.equal(svc.incrementalEnabled, false);
    await svc.rebuildFromIteration('p1', '/qualquer/cwd', null);
    assert.equal(wrapper.builds.length, 0, 'flag OFF: zero POST /build');
    assert.equal(builtAtWrites(), 0);
    // Sem GRAPHIFY_API_KEY a integração inteira fica off, mesmo com a env ligada.
    const semChave = new ProjectGraphService(
      prisma,
      makeConfig(wrapper.url, { apiKey: '', enabled: true }),
      realtime,
    );
    assert.equal(semChave.incrementalEnabled, false);
  } finally {
    await wrapper.close();
  }
});

test('US-F1.5 (b): rajada síncrona de N pedidos = 1 build com a união dos arquivos', async () => {
  const wrapper = await fakeWrapper();
  try {
    const { prisma } = makePrisma();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);
    svc.rebuildDebounceMs = 1;
    const flights = [
      svc.scheduleRebuild('p1', ['a.ts']),
      svc.scheduleRebuild('p1', ['b.ts']),
      svc.scheduleRebuild('p1', ['a.ts', 'c.ts']),
      svc.scheduleRebuild('p1', ['d.ts']),
      svc.scheduleRebuild('p1', ['e.ts']),
    ];
    await Promise.all(flights);
    assert.equal(wrapper.builds.length, 1, 'rajada de 5 pedidos → UM build');
    assert.deepEqual(wrapper.builds[0]?.files?.sort(), ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    // Rajada ESCALONADA (pedidos com ms de diferença, como iterações reais cujo
    // git diff termina em tempos distintos): o debounce junta tudo em 1 build.
    svc.rebuildDebounceMs = 80;
    const p1 = svc.scheduleRebuild('p1', ['s1.ts']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const p2 = svc.scheduleRebuild('p1', ['s2.ts']);
    await Promise.all([p1, p2]);
    assert.equal(wrapper.builds.length, 2, 'rajada escalonada dentro do debounce → UM build');
    assert.deepEqual(wrapper.builds[1]?.files?.sort(), ['s1.ts', 's2.ts']);
  } finally {
    await wrapper.close();
  }
});

test('US-F1.5 (b): pedidos DURANTE um build em voo acumulam e disparam UMA vez ao final', async () => {
  const wrapper = await fakeWrapper(200); // build "lento" (simula os ~9s)
  try {
    const { prisma } = makePrisma();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);
    svc.rebuildDebounceMs = 1;
    const first = svc.scheduleRebuild('p1', ['a.ts']);
    // Espera o build 1 estar EM VOO (pedido já chegou no wrapper) e então
    // dispara mais 3 pedidos — devem virar UM build 2, não três. Poll em vez
    // de sleep fixo: sob a suíte inteira o event loop pode atrasar o fetch.
    for (let i = 0; wrapper.builds.length === 0 && i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(wrapper.builds.length, 1, 'build 1 em voo');
    const during = [
      svc.scheduleRebuild('p1', ['x.ts']),
      svc.scheduleRebuild('p1', ['y.ts']),
      svc.scheduleRebuild('p1', ['x.ts', 'z.ts']),
    ];
    await Promise.all([first, ...during]);
    assert.equal(wrapper.builds.length, 2, '3 pedidos durante o voo → UM build a mais');
    assert.deepEqual(wrapper.builds[1]?.files?.sort(), ['x.ts', 'y.ts', 'z.ts']);
  } finally {
    await wrapper.close();
  }
});

test('US-F1.5 (c): falha do build (500) e sidecar fora NUNCA propagam', async () => {
  const wrapper = await fakeWrapper();
  wrapper.status.code = 500;
  try {
    const { prisma, builtAtWrites } = makePrisma();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);
    svc.rebuildDebounceMs = 1;
    // Não lança (falha vira logger.warn) e não grava graphBuiltAt.
    await svc.scheduleRebuild('p1', ['a.ts']);
    assert.equal(wrapper.builds.length, 1);
    assert.equal(builtAtWrites(), 0, 'falha não refresca graphBuiltAt');
  } finally {
    await wrapper.close();
  }
  // Sidecar fora do ar (porta fechada): também resolve sem lançar.
  const { prisma } = makePrisma();
  const morto = new ProjectGraphService(prisma, makeConfig('http://127.0.0.1:1'), realtime);
  await morto.scheduleRebuild('p1', ['a.ts']);
});

test('US-F1.5 (d): a cada N builds do Project, um força FULL (force sem files) e o contador reseta', async () => {
  const wrapper = await fakeWrapper();
  try {
    const { prisma, builtAtWrites } = makePrisma();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url, { forceEvery: 3 }), realtime);
    svc.rebuildDebounceMs = 1;
    for (const f of ['1.ts', '2.ts', '3.ts', '4.ts']) {
      await svc.scheduleRebuild('p1', [f]);
    }
    assert.equal(wrapper.builds.length, 4);
    assert.deepEqual(wrapper.builds[0], { projectId: 'p1', files: ['1.ts'] });
    assert.deepEqual(wrapper.builds[1], { projectId: 'p1', files: ['2.ts'] });
    // 3º build: force FULL — sem files (rebuild completo restaura o corpus).
    assert.deepEqual(wrapper.builds[2], { projectId: 'p1', force: true });
    // Contador resetou: o 4º volta a ser incremental.
    assert.deepEqual(wrapper.builds[3], { projectId: 'p1', files: ['4.ts'] });
    // Contador é POR Project: outro Project começa do zero.
    await svc.scheduleRebuild('p2', ['a.ts']);
    assert.deepEqual(wrapper.builds[4], { projectId: 'p2', files: ['a.ts'] });
    assert.equal(builtAtWrites(), 5, 'cada build ok refresca graphBuiltAt');
  } finally {
    await wrapper.close();
  }
});

test('US-F1.5 (e): extração dos paths — modificado, deletado, renomeado, espaço e novo', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'usf15-repo-'));
  const git = (...args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd: repo },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  const wrapper = await fakeWrapper();
  try {
    await git('init');
    await writeFile(join(repo, 'mod.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'del.ts'), 'export const b = 2;\n');
    await writeFile(join(repo, 'com espaco.ts'), 'export const c = 3;\n');
    await git('add', '-A');
    await git('commit', '-m', 'base');
    // A "iteração": modifica, deleta, renomeia (fs) e cria arquivo novo.
    await writeFile(join(repo, 'mod.ts'), 'export const a = 42;\n');
    await rmFile(join(repo, 'del.ts'));
    await rename(join(repo, 'com espaco.ts'), join(repo, 'renomeado.ts'));
    await writeFile(join(repo, 'novo.ts'), 'export const d = 4;\n');

    const { prisma } = makePrisma();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);
    svc.rebuildDebounceMs = 1;
    await svc.rebuildFromIteration('p1', repo, null);

    assert.equal(wrapper.builds.length, 1);
    // Repo-relativos, NUL-separados (espaço sai literal, sem quoting) e
    // --no-renames decompõe o rename em delete do path antigo + add do novo.
    // Paths deletados VÃO na lista: o wrapper trata inexistente como remoção.
    assert.deepEqual(wrapper.builds[0]?.files?.sort(), [
      'com espaco.ts',
      'del.ts',
      'mod.ts',
      'novo.ts',
      'renomeado.ts',
    ]);
    // cwd que não é repo git → lista vazia → NENHUM build (best-effort).
    await svc.rebuildFromIteration('p1', tmpdir(), null);
    assert.equal(wrapper.builds.length, 1);
  } finally {
    await wrapper.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test('US-F1.5 (f): grafo não-ready → rebuild pulado sem chamada de build', async () => {
  const wrapper = await fakeWrapper();
  try {
    for (const state of ['pending', 'building', 'failed', null] as const) {
      const { prisma } = makePrisma(state);
      const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);
      svc.rebuildDebounceMs = 1;
      await svc.scheduleRebuild('p1', ['a.ts']);
    }
    assert.equal(wrapper.builds.length, 0, 'sem build inicial ready, nada sai');
  } finally {
    await wrapper.close();
  }
});
