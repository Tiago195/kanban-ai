import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerEvent } from '@kanban-ai/shared';
import { ProjectGraphService } from './project-graph.service';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * US-F1.3 — ProjectGraphService (build do grafo de conhecimento por Project).
 *
 * Testes DETERMINÍSTICOS e OFFLINE: um `http.createServer` local faz o papel do
 * wrapper de build do sidecar (`docker/graphify_build_server.py`), respondendo
 * o MESMO contrato (`200 {ok:true,...}` / `4xx-5xx {ok:false,error}`). Cobrem
 * os pontos frágeis da story:
 *   (a) mapeamento de estado: build ok → building → ready + graphBuiltAt;
 *   (b) caminho de falha: build falhou → failed + graphLastError, SEM lançar e
 *       com o restante do Project intacto;
 *   (c) CORRIDA: Project deletado durante o build (~18s no mundo real) → nada é
 *       gravado/emitido e o grafo órfão é removido (POST /remove);
 *   (d) integração desligada (sem GRAPHIFY_API_KEY) → no-op absoluto.
 */

interface GraphRow {
  id: string;
  graphState: 'pending' | 'building' | 'ready' | 'failed';
  graphBuiltAt: Date | null;
  graphLastError: string | null;
  name: string;
}

function makeRow(over: Partial<GraphRow> = {}): GraphRow {
  return {
    id: 'p1',
    graphState: 'pending',
    graphBuiltAt: null,
    graphLastError: null,
    name: 'demo',
    ...over,
  };
}

/**
 * Prisma fake in-memory com suporte a DELETAR a linha no meio do fluxo
 * (simula a corrida do DELETE /projects/:id durante o build).
 */
function makePrisma(initial: GraphRow): {
  prisma: PrismaService;
  row: () => GraphRow | null;
  del: () => void;
} {
  let current: GraphRow | null = { ...initial };
  const prisma = {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        current && where.id === current.id ? { ...current } : null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<GraphRow> }) => {
        if (!current || where.id !== current.id) {
          // Mesma forma de erro do Prisma real (P2025): linha inexistente.
          throw new Error('Record to update not found.');
        }
        current = { ...current, ...data };
        return { ...current };
      },
    },
  } as unknown as PrismaService;
  return {
    prisma,
    row: () => (current ? { ...current } : null),
    del: () => {
      current = null;
    },
  };
}

function makeRealtime(): { realtime: RealtimeService; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const realtime = {
    broadcast: (e: ServerEvent) => {
      events.push(e);
    },
  } as unknown as RealtimeService;
  return { realtime, events };
}

function makeConfig(buildUrl: string, apiKey = 'test-key'): AppConfig {
  return {
    // queryTimeoutMs: teto curto usado por /affected, /projection e /reflect
    // (US-F5.2) — nunca o timeout de build.
    graphify: { buildUrl, apiKey, buildTimeoutMs: 5_000, queryTimeoutMs: 5_000 },
  } as unknown as AppConfig;
}

function graphStatesFrom(events: ServerEvent[]): string[] {
  return events
    .filter((e) => e.type === 'project.graph_state')
    .map((e) => (e as { state: string }).state);
}

/** Sobe um wrapper fake; `onBuild` decide a resposta do POST /build. */
async function fakeWrapper(
  onBuild: (req: { auth: string | undefined }) => { status: number; body: unknown },
): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: { path: string; auth: string | undefined }[];
}> {
  const requests: { path: string; auth: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      requests.push({ path: req.url ?? '', auth });
      const out =
        req.url === '/build'
          ? onBuild({ auth })
          : { status: 200, body: { ok: true, projectId: 'p1' } }; // /remove idempotente
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

test('build ok: building → ready, graphBuiltAt gravado e eventos emitidos', async () => {
  const wrapper = await fakeWrapper(() => ({
    status: 200,
    body: { ok: true, projectId: 'p1', graphPath: '/x/graph.json', nodes: 42, edges: 7, durationMs: 18_000, incremental: false },
  }));
  try {
    const { prisma, row } = makePrisma(makeRow());
    const { realtime, events } = makeRealtime();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);

    await svc.build('p1');

    const after = row();
    assert.equal(after?.graphState, 'ready');
    assert.ok(after?.graphBuiltAt instanceof Date, 'graphBuiltAt deve ser gravado');
    assert.equal(after?.graphLastError, null);
    assert.deepEqual(graphStatesFrom(events), ['building', 'ready']);
    // Autenticação: Bearer com a chave configurada (contrato do wrapper).
    assert.equal(wrapper.requests[0]?.auth, 'Bearer test-key');
  } finally {
    await wrapper.close();
  }
});

test('build falhou (500 do wrapper): failed + graphLastError, sem lançar, Project intacto', async () => {
  const wrapper = await fakeWrapper(() => ({
    status: 500,
    body: { ok: false, error: 'build falhou', exitCode: 1, log: ['boom'] },
  }));
  try {
    const { prisma, row } = makePrisma(makeRow({ name: 'intacto' }));
    const { realtime, events } = makeRealtime();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);

    // NUNCA lança — falha de build não pode derrubar o fluxo de Project.
    await svc.build('p1');

    const after = row();
    assert.equal(after?.graphState, 'failed');
    assert.match(after?.graphLastError ?? '', /build falhou/);
    assert.equal(after?.name, 'intacto', 'o restante do Project permanece intacto');
    assert.deepEqual(graphStatesFrom(events), ['building', 'failed']);
    const failedEvent = events.find(
      (e) => e.type === 'project.graph_state' && (e as { state: string }).state === 'failed',
    ) as { error?: string } | undefined;
    assert.match(failedEvent?.error ?? '', /build falhou/);
  } finally {
    await wrapper.close();
  }
});

test('sidecar fora do ar: failed + graphLastError legível, sem lançar', async () => {
  const { prisma, row } = makePrisma(makeRow());
  const { realtime, events } = makeRealtime();
  // Porta fechada (nada escutando) — connection refused.
  const svc = new ProjectGraphService(prisma, makeConfig('http://127.0.0.1:1'), realtime);

  await svc.build('p1');

  assert.equal(row()?.graphState, 'failed');
  assert.match(row()?.graphLastError ?? '', /graphify inacessível/);
  assert.deepEqual(graphStatesFrom(events), ['building', 'failed']);
});

test('corrida: Project deletado DURANTE o build → nada gravado/emitido e grafo órfão removido', async () => {
  const { prisma, row, del } = makePrisma(makeRow());
  const wrapper = await fakeWrapper(() => {
    // O DELETE /projects/:id chega enquanto o subprocess de build roda (~18s):
    // a linha some ANTES de a resposta do wrapper voltar.
    del();
    return {
      status: 200,
      body: { ok: true, projectId: 'p1', graphPath: '/x/graph.json', nodes: 1, edges: 0, durationMs: 10, incremental: false },
    };
  });
  try {
    const { realtime, events } = makeRealtime();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);

    await svc.build('p1');

    assert.equal(row(), null, 'a linha continua deletada');
    // Só o evento de building saiu; NUNCA um ready/failed de um Project morto.
    assert.deepEqual(graphStatesFrom(events), ['building']);
    // Limpeza: o grafo recém-escrito do Project morto foi removido no sidecar.
    const paths = wrapper.requests.map((r) => r.path);
    assert.deepEqual(paths, ['/build', '/remove']);
  } finally {
    await wrapper.close();
  }
});

test('Project já deletado ANTES do build: no-op (nenhum HTTP, nenhum evento)', async () => {
  const { prisma, del } = makePrisma(makeRow());
  del();
  const wrapper = await fakeWrapper(() => ({ status: 200, body: { ok: true } }));
  try {
    const { realtime, events } = makeRealtime();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);

    await svc.build('p1');

    assert.equal(wrapper.requests.length, 0, 'não deve chamar o wrapper');
    assert.deepEqual(graphStatesFrom(events), []);
  } finally {
    await wrapper.close();
  }
});

test('sem GRAPHIFY_API_KEY: integração desligada — build e remove são no-op', async () => {
  const wrapper = await fakeWrapper(() => ({ status: 200, body: { ok: true } }));
  try {
    const { prisma, row } = makePrisma(makeRow());
    const { realtime, events } = makeRealtime();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url, ''), realtime);

    await svc.build('p1');
    await svc.remove('p1');

    assert.equal(row()?.graphState, 'pending', 'graphState permanece pending');
    assert.equal(wrapper.requests.length, 0);
    assert.deepEqual(graphStatesFrom(events), []);
  } finally {
    await wrapper.close();
  }
});

test('remove: best-effort — erro do wrapper não lança', async () => {
  const { prisma } = makePrisma(makeRow());
  const { realtime } = makeRealtime();
  const svc = new ProjectGraphService(prisma, makeConfig('http://127.0.0.1:1'), realtime);
  // Porta fechada: o POST /remove falha, mas remove() engole (best-effort).
  await svc.remove('p1');
});

// ═════════ US-F5.2 — reflect (POST /reflect do wrapper) ═════════════════════

test('US-F5.2 reflect ok: POST /reflect autenticado com o projectId, sem lançar', async () => {
  const wrapper = await fakeWrapper(() => ({ status: 200, body: { ok: true } }));
  try {
    const { prisma } = makePrisma(makeRow());
    const { realtime } = makeRealtime();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);

    await svc.reflect('p1');

    assert.equal(wrapper.requests.length, 1);
    assert.equal(wrapper.requests[0].path, '/reflect');
    assert.equal(wrapper.requests[0].auth, 'Bearer test-key');
  } finally {
    await wrapper.close();
  }
});

test('US-F5.2 reflect best-effort: sidecar fora do ar NÃO lança (memória jamais derruba o loop)', async () => {
  const { prisma } = makePrisma(makeRow());
  const { realtime } = makeRealtime();
  const svc = new ProjectGraphService(prisma, makeConfig('http://127.0.0.1:1'), realtime);
  await svc.reflect('p1'); // porta fechada → warn engolido, sem exceção
});

test('US-F5.2 reflect desligado (sem GRAPHIFY_API_KEY): no-op sem rede', async () => {
  const wrapper = await fakeWrapper(() => ({ status: 200, body: { ok: true } }));
  try {
    const { prisma } = makePrisma(makeRow());
    const { realtime } = makeRealtime();
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url, ''), realtime);

    await svc.reflect('p1');

    assert.equal(wrapper.requests.length, 0);
  } finally {
    await wrapper.close();
  }
});
