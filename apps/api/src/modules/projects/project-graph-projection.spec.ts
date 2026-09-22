import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GraphProjection } from '@kanban-ai/shared';
import { ProjectGraphService } from './project-graph.service';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * US-F4.1 — projeção do grafo por Project (`ProjectGraphService.projection`).
 *
 * Testes DETERMINÍSTICOS e OFFLINE (estilo da casa — ver
 * `project-graph.service.spec.ts`): um `http.createServer` local faz o papel
 * do wrapper do sidecar (`POST /projection` de
 * `docker/graphify_build_server.py`), respondendo o MESMO contrato
 * estruturado. Cobrem os pontos frágeis da story:
 *   (a) grafo `ready` → a projeção estruturada do wrapper é repassada intacta
 *       (nós/arestas/comunidades/meta), com auth e params no corpo;
 *   (b) estados honestos: `pending`/`building`/`failed` → `{ok:false}` tipado
 *       com o estado e erro legível, SEM tocar a rede;
 *   (c) sidecar fora do ar / wrapper em erro → `{ok:false}` legível, sem lançar;
 *   (d) integração desligada (sem GRAPHIFY_API_KEY) → `{ok:false}`, sem rede;
 *   (e) Project inexistente → `{ok:false}` (guard defensivo; o controller
 *       404-a antes via `findOne`).
 */

interface Row {
  id: string;
  graphState: 'pending' | 'building' | 'ready' | 'failed';
  graphLastError: string | null;
}

function makePrisma(row: Row | null): PrismaService {
  return {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        row && where.id === row.id ? { ...row } : null,
    },
  } as unknown as PrismaService;
}

const realtime = { broadcast: () => undefined } as unknown as RealtimeService;

function makeConfig(buildUrl: string, apiKey = 'test-key'): AppConfig {
  return {
    graphify: { buildUrl, apiKey, buildTimeoutMs: 5_000, queryTimeoutMs: 5_000 },
  } as unknown as AppConfig;
}

/** Projeção mínima válida no contrato do wrapper (`/projection`, US-F4.1). */
function sampleProjection(): GraphProjection {
  return {
    ok: true,
    mode: 'overview',
    focus: null,
    nodes: [
      {
        id: 'file:apps/api/src/main.ts',
        label: 'main.ts',
        type: 'code',
        sourceFile: 'apps/api/src/main.ts',
        community: 0,
        communityName: 'API',
        degree: 42,
      },
    ],
    edges: [{ source: 'file:apps/api/src/main.ts', target: 'x', relation: 'imports' }],
    communities: [{ id: 0, name: 'API', size: 120 }],
    totalNodes: 3500,
    totalEdges: 6300,
    truncated: true,
  };
}

/** Sobe um wrapper fake; `onProjection` decide a resposta do POST /projection. */
async function fakeWrapper(
  onProjection: (body: Record<string, unknown>) => { status: number; body: unknown },
): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: { path: string; auth: string | undefined; body: Record<string, unknown> }[];
}> {
  const requests: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      requests.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      const out =
        req.url === '/projection'
          ? onProjection(body)
          : { status: 404, body: { ok: false, error: 'not found' } };
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    requests,
  };
}

const readyRow: Row = { id: 'p1', graphState: 'ready', graphLastError: null };

test('grafo ready: repassa a projeção estruturada do wrapper, com auth e params no corpo', async () => {
  const wrapper = await fakeWrapper(() => ({ status: 200, body: sampleProjection() }));
  try {
    const svc = new ProjectGraphService(makePrisma(readyRow), makeConfig(wrapper.url), realtime);

    const res = await svc.projection('p1', { focus: 'main.ts', depth: 2, limit: 50 });

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.mode, 'overview');
      assert.equal(res.nodes[0]?.sourceFile, 'apps/api/src/main.ts');
      assert.equal(res.totalNodes, 3500);
      assert.equal(res.truncated, true);
      assert.deepEqual(res.communities, [{ id: 0, name: 'API', size: 120 }]);
    }
    // Contrato com o wrapper: params da navegação viajam no corpo do POST.
    assert.equal(wrapper.requests[0]?.path, '/projection');
    assert.equal(wrapper.requests[0]?.auth, 'Bearer test-key');
    assert.deepEqual(wrapper.requests[0]?.body, {
      projectId: 'p1',
      focus: 'main.ts',
      depth: 2,
      limit: 50,
    });
  } finally {
    await wrapper.close();
  }
});

test('grafo não-ready: {ok:false} com o estado, SEM chamada de rede', async () => {
  const wrapper = await fakeWrapper(() => ({ status: 200, body: sampleProjection() }));
  try {
    for (const [state, errPattern] of [
      ['pending', /ainda não construído/],
      ['building', /em construção/],
    ] as const) {
      const svc = new ProjectGraphService(
        makePrisma({ id: 'p1', graphState: state, graphLastError: null }),
        makeConfig(wrapper.url),
        realtime,
      );
      const res = await svc.projection('p1');
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.graphState, state);
        assert.match(res.error, errPattern);
      }
    }
    assert.equal(wrapper.requests.length, 0, 'grafo não-ready nunca chega ao sidecar');
  } finally {
    await wrapper.close();
  }
});

test('grafo failed: {ok:false} carrega o graphLastError legível', async () => {
  const svc = new ProjectGraphService(
    makePrisma({ id: 'p1', graphState: 'failed', graphLastError: 'clone nao encontrado' }),
    makeConfig('http://127.0.0.1:1'),
    realtime,
  );
  const res = await svc.projection('p1');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.graphState, 'failed');
    assert.match(res.error, /clone nao encontrado/);
  }
});

test('sidecar fora do ar: {ok:false} legível, sem lançar', async () => {
  // Porta fechada (nada escutando) — connection refused.
  const svc = new ProjectGraphService(makePrisma(readyRow), makeConfig('http://127.0.0.1:1'), realtime);
  const res = await svc.projection('p1');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.graphState, 'ready');
    assert.match(res.error, /graphify inacessível/);
  }
});

test('wrapper em erro (grafo sumiu do volume): {ok:false} com o erro do wrapper', async () => {
  const wrapper = await fakeWrapper(() => ({
    status: 404,
    body: { ok: false, error: 'grafo nao construido: /x/graph.json' },
  }));
  try {
    const svc = new ProjectGraphService(makePrisma(readyRow), makeConfig(wrapper.url), realtime);
    const res = await svc.projection('p1');
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /grafo nao construido/);
  } finally {
    await wrapper.close();
  }
});

test('integração desligada (sem GRAPHIFY_API_KEY): {ok:false}, sem rede', async () => {
  const wrapper = await fakeWrapper(() => ({ status: 200, body: sampleProjection() }));
  try {
    const svc = new ProjectGraphService(
      makePrisma(readyRow),
      makeConfig(wrapper.url, ''),
      realtime,
    );
    const res = await svc.projection('p1');
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /desligado/);
    assert.equal(wrapper.requests.length, 0);
  } finally {
    await wrapper.close();
  }
});

test('Project inexistente: {ok:false} defensivo (o controller 404-a antes)', async () => {
  const svc = new ProjectGraphService(makePrisma(null), makeConfig('http://127.0.0.1:1'), realtime);
  const res = await svc.projection('ghost');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /não encontrado/);
});
