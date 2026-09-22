/**
 * US-F5.4 — specs dos helpers puros da aba Wiki (máquina de estados e
 * resolução de links internos entre artigos).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveWikiView,
  isSafeWikiSlug,
  localizeWikiMarkdown,
  parseWikiNav,
  wikiSlugFromHref,
} from './wikiView.ts';

describe('US-F5.4 wikiSlugFromHref', () => {
  it('resolve link interno `slug.md` para o slug', () => {
    assert.equal(wikiSlugFromHref('Core_Slugification.md'), 'Core_Slugification');
    assert.equal(wikiSlugFromHref('index.md'), 'index');
  });

  it('rejeita URLs absolutas e protocol-relative (link externo não navega)', () => {
    assert.equal(wikiSlugFromHref('https://github.com/x/y'), null);
    assert.equal(wikiSlugFromHref('//evil.example/a.md'), null);
    assert.equal(wikiSlugFromHref('mailto:a@b.md'), null);
  });

  it('rejeita paths (separador) e traversal — só segmento único navega', () => {
    assert.equal(wikiSlugFromHref('../secrets.md'), null);
    assert.equal(wikiSlugFromHref('sub/artigo.md'), null);
    assert.equal(wikiSlugFromHref('..\\artigo.md'), null);
    assert.equal(wikiSlugFromHref('..md'), null);
  });

  it('rejeita o que não é artigo markdown', () => {
    assert.equal(wikiSlugFromHref('artigo.txt'), null);
    assert.equal(wikiSlugFromHref(''), null);
    assert.equal(wikiSlugFromHref('.md'), null);
  });
});

describe('US-F5.4 deriveWikiView', () => {
  const generatedIndex = {
    ok: true as const,
    generated: true,
    generatedAt: '2026-08-30T12:00:00Z',
    articles: [{ slug: 'A', title: 'A' }],
  };

  it('carregando índice → loading', () => {
    assert.deepEqual(
      deriveWikiView({
        indexLoading: true,
        index: undefined,
        slug: 'index',
        articleLoading: false,
        article: undefined,
      }),
      { kind: 'loading' },
    );
  });

  it('índice {ok:false} → unavailable com o erro legível (nunca tela muda)', () => {
    const view = deriveWikiView({
      indexLoading: false,
      index: { ok: false, error: 'graphify inacessível' },
      slug: 'index',
      articleLoading: false,
      article: undefined,
    });
    assert.deepEqual(view, { kind: 'unavailable', error: 'graphify inacessível' });
  });

  it('wiki ainda não gerada → empty (estado vazio honesto)', () => {
    const view = deriveWikiView({
      indexLoading: false,
      index: { ok: true, generated: false, generatedAt: null, articles: [] },
      slug: 'index',
      articleLoading: false,
      article: undefined,
    });
    assert.deepEqual(view, { kind: 'empty' });
  });

  it('artigo em voo → article-loading do slug pedido', () => {
    const view = deriveWikiView({
      indexLoading: false,
      index: generatedIndex,
      slug: 'A',
      articleLoading: true,
      article: undefined,
    });
    assert.deepEqual(view, { kind: 'article-loading', slug: 'A' });
  });

  it('artigo {ok:false} (removido/slug inválido) → article-error', () => {
    const view = deriveWikiView({
      indexLoading: false,
      index: generatedIndex,
      slug: 'sumiu',
      articleLoading: false,
      article: { ok: false, error: 'artigo nao encontrado: sumiu' },
    });
    assert.deepEqual(view, {
      kind: 'article-error',
      slug: 'sumiu',
      error: 'artigo nao encontrado: sumiu',
    });
  });

  it('artigo ok → article com título e markdown', () => {
    const view = deriveWikiView({
      indexLoading: false,
      index: generatedIndex,
      slug: 'A',
      articleLoading: false,
      article: { ok: true, slug: 'A', title: 'Artigo A', content: '# Artigo A\ncorpo' },
    });
    assert.deepEqual(view, {
      kind: 'article',
      slug: 'A',
      title: 'Artigo A',
      content: '# Artigo A\ncorpo',
    });
  });
});

describe('US-UX.5 isSafeWikiSlug', () => {
  it('aceita os slugs reais do graphify (inclui pontos no meio)', () => {
    for (const s of ['Change_Log', 'package.json', 'slugify.d.ts', 'test-slugify.js']) {
      assert.equal(isSafeWikiSlug(s), true, s);
    }
  });

  it('rejeita o que o controller rejeita: path, espaço, `.`/`..`', () => {
    for (const s of ['../graph', '..\\graph', 'a/b', 'a b', '.', '..', '']) {
      assert.equal(isSafeWikiSlug(s), false, JSON.stringify(s));
    }
  });
});

describe('US-UX.5 localizeWikiMarkdown — cabeçalhos estruturais em pt-BR', () => {
  it('traduz os cabeçalhos do conjunto fechado do graphify', () => {
    const md = [
      '# Knowledge Graph Index',
      '## Communities',
      '## God Nodes',
      '## Key Concepts',
      '## Relationships',
      '## Source Files',
      '## Audit Trail',
      '## Connections by Relation',
      '### contains',
    ].join('\n');
    assert.equal(
      localizeWikiMarkdown(md),
      [
        '# Índice do grafo de conhecimento',
        '## Comunidades',
        '## Nós centrais (god nodes)',
        '## Conceitos-chave',
        '## Relações',
        '## Arquivos-fonte',
        '## Trilha de auditoria',
        '## Conexões por relação',
        '### contém',
      ].join('\n'),
    );
  });

  it('cabeçalho DESCONHECIDO passa intacto (nunca some conteúdo)', () => {
    assert.equal(localizeWikiMarkdown('## Novo Título Qualquer'), '## Novo Título Qualquer');
    assert.equal(localizeWikiMarkdown('# arrayMoveMutable()'), '# arrayMoveMutable()');
  });

  it('prosa e linhas não-heading não são tocadas', () => {
    const md = 'Communities are cool\n- Key Concepts na lista';
    assert.equal(localizeWikiMarkdown(md), md);
  });

  it('heading DENTRO de code fence não é traduzido', () => {
    const md = '```\n## Communities\n```\n## Communities';
    assert.equal(localizeWikiMarkdown(md), '```\n## Communities\n```\n## Comunidades');
  });
});

describe('US-UX.5 parseWikiNav — navegação derivada do index.md', () => {
  const index = [
    '# Knowledge Graph Index',
    '',
    '> Auto-generated by graphify.',
    '',
    '**84 nodes · 76 edges · 12 communities**',
    '',
    '---',
    '',
    '## Communities',
    '(sorted by size, largest first)',
    '',
    '- [Change Log](Change_Log.md) — 30 nodes',
    '- [package.json](package.json.md) — 14 nodes',
    '',
    '## God Nodes',
    '(most connected concepts — the load-bearing abstractions)',
    '',
    '- [Change Log](Change_Log.md) — 29 connections',
    '- [mocha](mocha.md) — 2 connections',
    '',
    '---',
    '',
    '*Generated by [graphify](https://github.com/safishamsi/graphify)*',
  ].join('\n');

  it('extrai comunidades e god nodes com slug, título e contagem', () => {
    const nav = parseWikiNav(index);
    assert.deepEqual(nav.communities, [
      { slug: 'Change_Log', title: 'Change Log', count: 30 },
      { slug: 'package.json', title: 'package.json', count: 14 },
    ]);
    assert.deepEqual(nav.godNodes, [
      { slug: 'Change_Log', title: 'Change Log', count: 29 },
      { slug: 'mocha', title: 'mocha', count: 2 },
    ]);
  });

  it('extrai o resumo de nós/arestas/comunidades', () => {
    assert.deepEqual(parseWikiNav(index).stats, { nodes: 84, edges: 76, communities: 12 });
  });

  it('link externo no rodapé NÃO vira entrada (fora das seções)', () => {
    const nav = parseWikiNav(index);
    const all = [...nav.communities, ...nav.godNodes].map((e) => e.slug);
    assert.equal(all.includes('graphify'), false);
  });

  it('formato fora do esperado → listas vazias (a UI cai para a lista plana)', () => {
    assert.deepEqual(parseWikiNav('# outra coisa\n- sem secao'), {
      stats: null,
      communities: [],
      godNodes: [],
    });
    assert.deepEqual(parseWikiNav(''), { stats: null, communities: [], godNodes: [] });
  });
});
