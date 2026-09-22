/**
 * US-F4.2 — specs do markdown lite do Memory Viewer (débito da US-F2.8:
 * frontmatter cru na tela). Padrão node:test, como o backend.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseInline, parseMarkdownBlocks, splitFrontmatter } from './markdownLite.ts';

describe('US-F4.2 splitFrontmatter', () => {
  it('separa o frontmatter do corpo', () => {
    const md = '---\ntitle: X\ntags: [a, b]\n---\n# Corpo\ntexto';
    const { frontmatter, body } = splitFrontmatter(md);
    assert.equal(frontmatter, 'title: X\ntags: [a, b]');
    assert.equal(body, '# Corpo\ntexto');
  });

  it('sem frontmatter devolve o corpo intacto', () => {
    const { frontmatter, body } = splitFrontmatter('# Só corpo');
    assert.equal(frontmatter, null);
    assert.equal(body, '# Só corpo');
  });

  it('um `---` de linha horizontal no MEIO não é frontmatter', () => {
    const md = 'intro\n---\nmeio';
    const { frontmatter, body } = splitFrontmatter(md);
    assert.equal(frontmatter, null);
    assert.equal(body, md);
  });

  it('frontmatter sem fechamento não é tratado como frontmatter', () => {
    const md = '---\ntitle: aberto';
    assert.equal(splitFrontmatter(md).frontmatter, null);
  });
});

describe('US-F4.2 parseMarkdownBlocks', () => {
  it('parseia heading, lista, fence e parágrafo', () => {
    const blocks = parseMarkdownBlocks(
      '## Título\n\n- item 1\n- item 2\n\n```ts\nconst x = 1;\n```\n\nlinha a\nlinha b',
    );
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['heading', 'list', 'code', 'para'],
    );
    assert.equal(blocks[0].kind === 'heading' && blocks[0].level, 2);
    assert.equal(blocks[1].kind === 'list' && blocks[1].items.length, 2);
    assert.equal(blocks[2].kind === 'code' && blocks[2].text, 'const x = 1;');
    // linhas consecutivas do parágrafo são unidas com espaço
    assert.deepEqual(blocks[3].kind === 'para' && blocks[3].segments, [
      { kind: 'text', text: 'linha a linha b' },
    ]);
  });

  it('fence sem fechamento consome até o fim (não trava)', () => {
    const blocks = parseMarkdownBlocks('```\naberto');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind === 'code' && blocks[0].text, 'aberto');
  });
});

describe('US-F4.2 parseInline', () => {
  it('quebra texto em code/bold/link', () => {
    assert.deepEqual(parseInline('use `x` e **y** em [doc](http://a/b)'), [
      { kind: 'text', text: 'use ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: ' e ' },
      { kind: 'bold', text: 'y' },
      { kind: 'text', text: ' em ' },
      { kind: 'link', text: 'doc', href: 'http://a/b' },
    ]);
  });

  it('texto puro vira um único segmento', () => {
    assert.deepEqual(parseInline('nada especial'), [{ kind: 'text', text: 'nada especial' }]);
  });
});

describe('US-UX.5 parseMarkdownBlocks — citação e régua (débito da F4.2)', () => {
  it('`> texto` vira bloco quote (linhas consecutivas unidas)', () => {
    const blocks = parseMarkdownBlocks('> 30 nodes\n> segunda linha');
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], {
      kind: 'quote',
      segments: [{ kind: 'text', text: '30 nodes segunda linha' }],
    });
  });

  it('citação com inline (`code`, **bold**) parseia os segmentos', () => {
    const blocks = parseMarkdownBlocks('> use `x` e **y**');
    assert.equal(blocks[0].kind === 'quote' && blocks[0].segments.length, 4);
  });

  it('`---` (e ***/___ longos) vira régua, nunca texto literal', () => {
    for (const rule of ['---', '----', '***', '___']) {
      const blocks = parseMarkdownBlocks(`antes\n${rule}\ndepois`);
      assert.deepEqual(
        blocks.map((b) => b.kind),
        ['para', 'rule', 'para'],
        `régua: ${rule}`,
      );
    }
  });

  it('citação/régua ENCERRAM o parágrafo anterior (não são engolidas)', () => {
    const blocks = parseMarkdownBlocks('texto\n> quote\n---');
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['para', 'quote', 'rule'],
    );
  });

  it('`---` dentro de code fence continua literal (não vira régua)', () => {
    const blocks = parseMarkdownBlocks('```\n---\n```');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind === 'code' && blocks[0].text, '---');
  });

  it('regressão memória: heading/lista/para continuam iguais com quote no meio', () => {
    const blocks = parseMarkdownBlocks('# T\n> q\n- a\ncorpo');
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['heading', 'quote', 'list', 'para'],
    );
  });
});

describe('US-UX.5 parseInline — itálico (rodapé graphify de todos os artigos)', () => {
  it('`*x*` e `_x_` viram em', () => {
    assert.deepEqual(parseInline('*x*'), [
      { kind: 'em', segments: [{ kind: 'text', text: 'x' }] },
    ]);
    assert.deepEqual(parseInline('_x_'), [
      { kind: 'em', segments: [{ kind: 'text', text: 'x' }] },
    ]);
  });

  it('rodapé real: link DENTRO do itálico continua navegável', () => {
    const segs = parseInline('*Part of the wiki. See [index](index.md) to navigate.*');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].kind, 'em');
    assert.deepEqual(segs[0].kind === 'em' && segs[0].segments, [
      { kind: 'text', text: 'Part of the wiki. See ' },
      { kind: 'link', text: 'index', href: 'index.md' },
      { kind: 'text', text: ' to navigate.' },
    ]);
  });

  it('negativo: `**negrito**` segue bold, nunca <em>*a*</em>', () => {
    assert.deepEqual(parseInline('**a**'), [{ kind: 'bold', text: 'a' }]);
    assert.deepEqual(parseInline('x **a** y'), [
      { kind: 'text', text: 'x ' },
      { kind: 'bold', text: 'a' },
      { kind: 'text', text: ' y' },
    ]);
  });

  it('negativo: `_` no meio de identificador NÃO é itálico', () => {
    for (const id of [
      'index_arraymovemutable',
      'source_file',
      'code_fingerprint',
      'snake_case_name',
      'a_b e c_d',
    ]) {
      assert.deepEqual(parseInline(id), [{ kind: 'text', text: id }], id);
    }
  });

  it('negativo: asterisco solto e `* espaçado *` seguem texto', () => {
    assert.deepEqual(parseInline('2 * 3 = 6'), [{ kind: 'text', text: '2 * 3 = 6' }]);
    assert.deepEqual(parseInline('a * b'), [{ kind: 'text', text: 'a * b' }]);
  });

  it('negativo: dentro de code inline nada é tocado', () => {
    assert.deepEqual(parseInline('`a_b_c` e `*x*`'), [
      { kind: 'code', text: 'a_b_c' },
      { kind: 'text', text: ' e ' },
      { kind: 'code', text: '*x*' },
    ]);
  });

  it('negativo: code FENCE não passa por inline (segue cru)', () => {
    const blocks = parseMarkdownBlocks('```\n*x* _y_\n```');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind === 'code' && blocks[0].text, '*x* _y_');
  });
});
