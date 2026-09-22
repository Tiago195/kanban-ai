import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProjectGraphService } from './project-graph.service';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * US-UX.3 — painel da memória: cliente throwless de `POST /learning`.
 *
 * Testes DETERMINÍSTICOS e OFFLINE (mesmo padrão da US-F5.4): um
 * `http.createServer` local faz o papel do wrapper do sidecar. Cobrem:
 *   (a) passthrough do payload gerado (nós com veredito/stale + becos);
 *   (b) reflect nunca rodado → `generated:false` (estado vazio, NÃO erro);
 *   (c) sidecar fora do ar → `{ok:false}` legível, nunca lança;
 *   (d) integração desligada (sem GRAPHIFY_API_KEY) → `{ok:false}` sem rede.
 */

function makeService(buildUrl: string, apiKey = 'test-key'): ProjectGraphService {
  const config = {
    graphify: { buildUrl, apiKey, buildTimeoutMs: 5_000, queryTimeoutMs: 5_000 },
  } as unknown as AppConfig;
  const prisma = {
    project: { findUnique: async () => ({ id: 'p1', graphState: 'ready' }) },
  } as unknown as PrismaService;
  const realtime = { broadcast: () => undefined } as unknown as RealtimeService;
  return new ProjectGraphService(prisma, config, realtime);
}

async function fakeWrapper(status: number, body: unknown): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: { path: string; body: Record<string, unknown> }[];
}> {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
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

test('learning: passthrough do payload gerado (nós + becos + correções)', async () => {
  const payload = {
    ok: true,
    projectId: 'p1',
    generated: true,
    generatedAt: '2026-08-30T12:00:00+00:00',
    docs: 4,
    nodes: [
      {
        id: 'index_arraymoveimmutable',
        status: 'contested',
        verdict: 'useful',
        score: 0.7,
        uses: 2,
        neg: 1,
        last: '2026-08-29',
        label: 'arrayMoveImmutable()',
        sourceFile: 'index.js',
        stale: true,
        provenance: [{ q: 'como mover item?', date: '2026-08-29', outcome: 'useful' }],
      },
    ],
    deadEnds: [{ question: 'dá pra mutar in place?', nodes: ['index_x'], date: '2026-08-28' }],
    corrections: [{ question: 'qual export?', correction: 'é named export', date: '2026-08-27' }],
  };
  const wrapper = await fakeWrapper(200, payload);
  try {
    const svc = makeService(wrapper.url);
    const res = await svc.learning('p1');
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.generated, true);
      assert.equal(res.nodes[0].stale, true);
      assert.equal(res.nodes[0].verdict, 'useful');
      assert.equal(res.deadEnds.length, 1);
      assert.equal(res.corrections.length, 1);
    }
    // A rota certa, com o projectId no corpo (o wrapper valida o resto).
    assert.deepEqual(wrapper.requests, [{ path: '/learning', body: { projectId: 'p1' } }]);
  } finally {
    await wrapper.close();
  }
});

test('learning: reflect nunca rodado → generated:false (estado vazio, NÃO erro)', async () => {
  const wrapper = await fakeWrapper(200, {
    ok: true,
    projectId: 'p1',
    generated: false,
    generatedAt: null,
    docs: 0,
    nodes: [],
    deadEnds: [],
    corrections: [],
  });
  try {
    const res = await makeService(wrapper.url).learning('p1');
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.generated, false);
      assert.deepEqual(res.nodes, []);
    }
  } finally {
    await wrapper.close();
  }
});

test('learning: sidecar fora do ar → {ok:false} legível, nunca lança', async () => {
  // Porta de um servidor já fechado = conexão recusada.
  const wrapper = await fakeWrapper(200, {});
  await wrapper.close();
  const res = await makeService(wrapper.url).learning('p1');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /graphify inacess/);
});

test('learning: erro do wrapper (400) → {ok:false} com a mensagem do wrapper', async () => {
  const wrapper = await fakeWrapper(400, { ok: false, error: 'projectId invalido' });
  try {
    const res = await makeService(wrapper.url).learning('p1');
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /projectId invalido/);
  } finally {
    await wrapper.close();
  }
});

test('learning: integração desligada (sem chave) → {ok:false} sem tocar a rede', async () => {
  const wrapper = await fakeWrapper(200, { ok: true });
  try {
    const res = await makeService(wrapper.url, '').learning('p1');
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /desligado/);
    assert.equal(wrapper.requests.length, 0);
  } finally {
    await wrapper.close();
  }
});
