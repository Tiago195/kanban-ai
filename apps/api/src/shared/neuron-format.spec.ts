import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIVE_MEMORY_SUBDIR,
  MAX_SOURCE_NODES,
  OUTCOMES,
  fileNodeId,
  makeNodeId,
  memoryDocFilename,
  moduleFromNeuronPath,
  normalizeId,
  parseMemoryDoc,
  serializeMemoryDoc,
  stripFrontmatter,
  type MemoryOutcome,
} from './neuron-format';

/**
 * US-F5.1 (EP-F5) — specs do formato CANÔNICO de memory doc do graphify.
 *
 * O formato v2 anterior (schema/module/tags/files) foi APAGADO: o graphify
 * nunca o leu. Estes specs fixam a paridade com a especificação executável do
 * pacote: `save_query_result` (ingest.py) na serialização, `parse_memory_doc`
 * (reflect.py) no parse, e `make_id`/`_file_stem` (ids.py/extractors/base.py)
 * na receita de id de nó. A compatibilidade foi verificada também contra o
 * Python REAL (`parse_memory_doc` de ~/dev/fontes/graphify lê byte a byte o
 * que `serializeMemoryDoc` emite).
 */

// ---------------------------------------------------------------------------
// serializeMemoryDoc — o shape do save_query_result, com escalares em aspas.
// ---------------------------------------------------------------------------

test('US-F5.1 serializeMemoryDoc emite o frontmatter canônico (escalares em aspas duplas + flow list)', () => {
  const md = serializeMemoryDoc({
    type: 'learning',
    date: '2026-08-30T12:00:00.000Z',
    question: 'Corrigir gateway de billing',
    answer: 'gateway exige idempotency-key',
    contributor: 'kanban-ai',
    outcome: 'useful',
    sourceNodes: ['apps_api_src_billing_gateway'],
  });
  const lines = md.split('\n');
  assert.equal(lines[0], '---');
  // O regex do parse_memory_doc EXIGE `key: "value"` — as aspas são contrato.
  assert.match(md, /^type: "learning"$/m);
  assert.match(md, /^date: "2026-08-30T12:00:00\.000Z"$/m);
  assert.match(md, /^question: "Corrigir gateway de billing"$/m);
  assert.match(md, /^contributor: "kanban-ai"$/m);
  assert.match(md, /^outcome: "useful"$/m);
  assert.match(md, /^source_nodes: \["apps_api_src_billing_gateway"\]$/m);
  // Corpo no shape do save_query_result.
  assert.match(md, /^# Q: Corrigir gateway de billing$/m);
  assert.match(md, /^## Answer$/m);
  assert.match(md, /^- Signal: useful$/m);
  assert.match(md, /^## Source Nodes$/m);
});

test('US-F5.1 outcome inválido é REJEITADO na serialização (paridade com o ValueError do ingest.py)', () => {
  assert.throws(
    () =>
      serializeMemoryDoc({
        date: 'd',
        question: 'q',
        answer: 'a',
        outcome: 'maybe' as MemoryOutcome,
      }),
    /outcome deve ser um de useful\|dead_end\|corrected/,
  );
  // Os três valores válidos passam.
  for (const o of OUTCOMES) {
    assert.doesNotThrow(() => serializeMemoryDoc({ date: 'd', question: 'q', answer: 'a', outcome: o }));
  }
});

test('US-F5.1 source_nodes tem teto de 10 (mesmo corte `[:10]` do save_query_result)', () => {
  const nodes = Array.from({ length: 15 }, (_, i) => `node_${i}`);
  const md = serializeMemoryDoc({ date: 'd', question: 'q', answer: 'a', sourceNodes: nodes });
  const parsed = parseMemoryDoc(md)!;
  assert.equal(parsed.sourceNodes.length, MAX_SOURCE_NODES);
  assert.deepEqual(parsed.sourceNodes, nodes.slice(0, 10));
});

// ---------------------------------------------------------------------------
// Round-trip serialize → parse (o parse espelha os regexes do reflect.py).
// ---------------------------------------------------------------------------

test('US-F5.1 round-trip: todos os campos reconhecidos sobrevivem, inclusive escaping YAML', () => {
  const input = {
    type: 'learning',
    date: '2026-08-30T12:00:00.000Z',
    // Aspas, quebra de linha e tab — o escaping do _yaml_str tem que segurar.
    question: 'Corrigir "gateway"\ncom\tquebra',
    answer: 'resposta',
    contributor: 'kanban-ai',
    outcome: 'corrected' as MemoryOutcome,
    correction: 'na verdade era o retry',
    sourceNodes: ['apps_api_src_billing_gateway', 'src_auth_session_validatetoken'],
  };
  const parsed = parseMemoryDoc(serializeMemoryDoc(input));
  assert.ok(parsed);
  assert.equal(parsed.type, 'learning');
  assert.equal(parsed.date, input.date);
  assert.equal(parsed.question, input.question);
  assert.equal(parsed.contributor, 'kanban-ai');
  assert.equal(parsed.outcome, 'corrected');
  assert.equal(parsed.correction, 'na verdade era o retry');
  assert.deepEqual(parsed.sourceNodes, input.sourceNodes);
});

test('US-F5.1 parseMemoryDoc lê um doc gerado pelo próprio graphify (fixture literal do save_query_result)', () => {
  // Shape byte a byte do que o `graphify save-result` grava.
  const doc = [
    '---',
    'type: "query"',
    'date: "2026-08-30T12:00:00+00:00"',
    'question: "what connects auth to billing?"',
    'contributor: "graphify"',
    'outcome: "dead_end"',
    'source_nodes: ["src_auth_session", "src_billing_gateway"]',
    '---',
    '',
    '# Q: what connects auth to billing?',
    '',
    '## Answer',
    '',
    'nothing direct',
  ].join('\n');
  const parsed = parseMemoryDoc(doc)!;
  assert.equal(parsed.type, 'query');
  assert.equal(parsed.outcome, 'dead_end');
  assert.deepEqual(parsed.sourceNodes, ['src_auth_session', 'src_billing_gateway']);
});

test('US-F5.1 parseMemoryDoc: sem frontmatter → null (markdown estrangeiro é pulado, como no reflect)', () => {
  assert.equal(parseMemoryDoc('# só um markdown\n'), null);
  assert.equal(parseMemoryDoc(''), null);
  // `---` que não é a primeira linha não é frontmatter.
  assert.equal(parseMemoryDoc('\n---\ntype: "x"\n---\n'), null);
  // Linha não reconhecida é ignorada (tolerância do parser do reflect).
  const parsed = parseMemoryDoc('---\nfoo: "bar"\nquestion: "q"\n---\n')!;
  assert.equal(parsed.question, 'q');
  assert.ok(!('foo' in parsed));
});

test('stripFrontmatter: sem frontmatter intacto; cerca não fechada não é frontmatter', () => {
  const plain = '# doc\n\ncorpo\n';
  assert.equal(stripFrontmatter(plain), plain);
  const unterminated = '---\ntype: "x"\n# sem fechamento\n';
  assert.equal(stripFrontmatter(unterminated), unterminated);
  assert.equal(stripFrontmatter('---\ntype: "x"\n---\n\n# doc\n'), '\n# doc\n');
});

// ---------------------------------------------------------------------------
// Receita de id de nó — paridade com make_id/_file_stem/_file_node_id.
// ---------------------------------------------------------------------------

test('US-F5.1 fileNodeId: caminho relativo, todos os segmentos, sem a última extensão, minúsculo', () => {
  // O exemplo canônico da história (arquivo + símbolo).
  assert.equal(fileNodeId('src/auth/session.py', 'ValidateToken'), 'src_auth_session_validatetoken');
  // Só arquivo (ancoragem em ARQUIVO quando não sabemos o símbolo).
  assert.equal(
    fileNodeId('apps/api/src/modules/cards/cards.service.ts'),
    'apps_api_src_modules_cards_cards_service',
  );
  // Top-level mantém stem puro (setup.py → setup, como no _file_stem).
  assert.equal(fileNodeId('setup.py'), 'setup');
  // `with_suffix("")` só tira a ÚLTIMA extensão; dotfile não tem extensão.
  assert.equal(fileNodeId('.env'), 'env');
  assert.equal(fileNodeId('docs/v1/api/README.md'), 'docs_v1_api_readme');
});

test('US-F5.1 makeNodeId/normalizeId: bordas `_`/`.` das partes, runs de não-word → `_`, idempotente', () => {
  assert.equal(makeNodeId('_pkg_.', 'Mod.Name'), 'pkg_mod_name');
  assert.equal(normalizeId('Foo--Bar  baz'), 'foo_bar_baz');
  assert.equal(normalizeId(normalizeId('Foo--Bar  baz')), 'foo_bar_baz');
  assert.equal(makeNodeId(''), '');
});

// ---------------------------------------------------------------------------
// Nome de arquivo e helpers.
// ---------------------------------------------------------------------------

test('US-F5.1 memoryDocFilename: receita de slug do save_query_result (lower, não-word → _, corte 50)', () => {
  const name = memoryDocFilename('Gateway exige idempotency-key!', new Date('2026-08-30T12:34:56Z'));
  assert.equal(name, 'learning_20260830_123456_gateway_exige_idempotency_key.md');
  // Corte em 50 chars de slug + bordas limpas.
  const long = memoryDocFilename('x'.repeat(80), new Date('2026-01-01T00:00:00Z'));
  assert.match(long, /^learning_20260101_000000_x{50}\.md$/);
});

test('US-F5.1 HIVE_MEMORY_SUBDIR: os docs vivem em .hive/memory (plano — glob não-recursivo do reflect)', () => {
  assert.equal(HIVE_MEMORY_SUBDIR, 'memory');
});

test('moduleFromNeuronPath deriva o título de fallback do path', () => {
  assert.equal(moduleFromNeuronPath('memory/learning_x.md'), 'learning_x');
  assert.equal(moduleFromNeuronPath('cards.md'), 'cards');
});
