import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProjectGraphService } from './project-graph.service';
import { projectWikiArticleQuerySchema } from './projects.schema';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';

/**
 * US-F5.4 — Wiki do graphify: listagem, leitura de artigo e geração.
 *
 * Testes DETERMINÍSTICOS e OFFLINE (mesmo padrão da US-F1.3): um
 * `http.createServer` local faz o papel do wrapper do sidecar
 * (`docker/graphify_build_server.py`), respondendo o contrato das rotas
 * `/wiki`, `/wiki-list` e `/wiki-article`. Cobrem os pontos frágeis:
 *   (a) listagem: passthrough do índice e do estado vazio (`generated:false`);
 *   (b) leitura: artigo ok e artigo inexistente → `{ok:false}` legível;
 *   (c) TRUST BOUNDARY: slug com traversal morre no zod (nunca chega ao
 *       sidecar) e, em profundidade, um 400 do wrapper vira `{ok:false}`;
 *   (d) falha de sidecar/integração desligada → `{ok:false}`, nunca lança;
 *   (e) `build()` dispara a geração da wiki (`POST /wiki`) após o `ready`,
 *       e falha na wiki NÃO regride o estado do grafo (best-effort).
 */

function makeConfig(buildUrl: string, apiKey = 'test-key'): AppConfig {
  return {
    graphify: { buildUrl, apiKey, buildTimeoutMs: 5_000, queryTimeoutMs: 5_000 },
  } as unknown as AppConfig;
}

function makeService(
  buildUrl: string,
  apiKey = 'test-key',
): { svc: ProjectGraphService } {
  // wikiList/wikiArticle não tocam Prisma nem Realtime; fakes mínimos.
  const prisma = {
    project: {
      findUnique: async () => ({ id: 'p1', graphState: 'ready' }),
      update: async () => ({ id: 'p1' }),
    },
  } as unknown as PrismaService;
  const realtime = { broadcast: () => undefined } as unknown as RealtimeService;
  return { svc: new ProjectGraphService(prisma, makeConfig(buildUrl, apiKey), realtime) };
}

/** Wrapper fake: responde por rota; registra cada request para asserção. */
async function fakeWrapper(
  routes: Record<string, { status: number; body: unknown }>,
): Promise<{
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
      const out = routes[req.url ?? ''] ?? { status: 404, body: { ok: false, error: 'not found' } };
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

test('wikiList: passthrough do índice gerado (artigos + generatedAt)', async () => {
  const wrapper = await fakeWrapper({
    '/wiki-list': {
      status: 200,
      body: {
        ok: true,
        generated: true,
        generatedAt: '2026-08-30T12:00:00+00:00',
        articles: [{ slug: 'Core_Slugification', title: 'Core Slugification' }],
      },
    },
  });
  try {
    const { svc } = makeService(wrapper.url);
    const res = await svc.wikiList('p1');
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.generated, true);
      assert.deepEqual(res.articles, [
        { slug: 'Core_Slugification', title: 'Core Slugification' },
      ]);
    }
  } finally {
    await wrapper.close();
  }
});

test('wikiList: wiki ainda não gerada → generated:false (estado vazio, NÃO erro)', async () => {
  const wrapper = await fakeWrapper({
    '/wiki-list': {
      status: 200,
      body: { ok: true, generated: false, generatedAt: null, articles: [] },
    },
  });
  try {
    const { svc } = makeService(wrapper.url);
    const res = await svc.wikiList('p1');
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.generated, false);
      assert.deepEqual(res.articles, []);
    }
  } finally {
    await wrapper.close();
  }
});

test('wikiList: sidecar fora do ar → {ok:false} com erro legível, sem lançar', async () => {
  const { svc } = makeService('http://127.0.0.1:1'); // porta que nunca responde
  const res = await svc.wikiList('p1');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /graphify inacess/);
});

test('wikiList/wikiArticle: integração desligada (sem GRAPHIFY_API_KEY) → {ok:false}', async () => {
  const { svc } = makeService('http://127.0.0.1:1', '');
  const list = await svc.wikiList('p1');
  const article = await svc.wikiArticle('p1', 'index');
  assert.equal(list.ok, false);
  assert.equal(article.ok, false);
});

test('wikiArticle: artigo ok → slug/título/markdown passam intactos', async () => {
  const wrapper = await fakeWrapper({
    '/wiki-article': {
      status: 200,
      body: { ok: true, slug: 'index', title: 'Knowledge Graph Index', content: '# Knowledge Graph Index\n\ncorpo' },
    },
  });
  try {
    const { svc } = makeService(wrapper.url);
    const res = await svc.wikiArticle('p1', 'index');
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.title, 'Knowledge Graph Index');
      assert.match(res.content, /^# Knowledge Graph Index/);
    }
    // O slug viaja no corpo do POST (o wrapper deriva o path — nunca o caller).
    assert.deepEqual(wrapper.requests[0]?.body, { projectId: 'p1', slug: 'index' });
  } finally {
    await wrapper.close();
  }
});

test('wikiArticle: artigo inexistente (404 do wrapper) → {ok:false} legível', async () => {
  const wrapper = await fakeWrapper({
    '/wiki-article': { status: 404, body: { ok: false, error: 'artigo nao encontrado: sumiu' } },
  });
  try {
    const { svc } = makeService(wrapper.url);
    const res = await svc.wikiArticle('p1', 'sumiu');
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /artigo nao encontrado/);
  } finally {
    await wrapper.close();
  }
});

test('TRUST BOUNDARY: slug com path traversal é rejeitado pelo schema (400 antes do sidecar)', () => {
  // O zod do controller mata o traversal ANTES de qualquer round-trip: um
  // `../` não vira nem request ao wrapper (que revalida em profundidade).
  for (const slug of ['../graph', '..', '.', 'a/b', 'a\\b', '', '../../etc/passwd']) {
    const parsed = projectWikiArticleQuerySchema.safeParse({ slug });
    assert.equal(parsed.success, false, `slug "${slug}" deveria ser rejeitado`);
  }
  // Slugs legítimos do to_wiki passam (inclusive com unicode e pontos internos).
  for (const slug of ['index', 'Core_Slugification', 'build.js', 'Configuração']) {
    const parsed = projectWikiArticleQuerySchema.safeParse({ slug });
    assert.equal(parsed.success, true, `slug "${slug}" deveria passar`);
  }
});

test('wikiGenerate: build ok dispara POST /wiki e falha na wiki NÃO regride o grafo', async () => {
  // /build ok, /wiki falha (500): o build continua `ready` — wiki é best-effort.
  const wrapper = await fakeWrapper({
    '/build': {
      status: 200,
      body: { ok: true, projectId: 'p1', graphPath: '/x/graph.json', nodes: 84, edges: 76, durationMs: 10, incremental: false },
    },
    '/wiki': { status: 500, body: { ok: false, error: 'geracao da wiki falhou: boom' } },
  });
  try {
    let state = 'pending';
    const prisma = {
      project: {
        findUnique: async () => ({ id: 'p1', graphState: state }),
        update: async ({ data }: { data: { graphState?: string } }) => {
          if (data.graphState) state = data.graphState;
          return { id: 'p1' };
        },
      },
    } as unknown as PrismaService;
    const realtime = { broadcast: () => undefined } as unknown as RealtimeService;
    const svc = new ProjectGraphService(prisma, makeConfig(wrapper.url), realtime);

    await svc.build('p1');

    assert.equal(state, 'ready', 'falha na wiki não pode regredir o graphState');
    const paths = wrapper.requests.map((r) => r.path);
    assert.ok(paths.includes('/wiki'), `POST /wiki deveria ser disparado após o build (${paths})`);
    assert.ok(paths.indexOf('/wiki') > paths.indexOf('/build'), 'wiki vem DEPOIS do build');
  } finally {
    await wrapper.close();
  }
});
