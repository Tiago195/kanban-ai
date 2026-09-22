import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * US-F3.2 — Characterization do contrato de resultado (ORÁCULO DE PARIDADE).
 *
 * Estas specs NÃO testam comportamento desejado: elas FIXAM o comportamento
 * ATUAL do protocolo de marcadores `<<<KANBAN_RESULT>>>`/`<<<KANBAN_QUESTION>>>`
 * implementado em `docker/copilot-cli-adapter.mjs` (a ponte entre o Copilot CLI
 * em texto cru e o protocolo JSONL do `CopilotCliRunner`). O EP-F3 vai trocar
 * esse protocolo por `outputSchema` validado — e vai comparar o novo parsing
 * contra ESTE oráculo, caso a caso, inclusive nos degenerados.
 *
 * Método: spawna o adapter real (`node copilot-cli-adapter.mjs <prompt>`) com
 * `COPILOT_BIN` apontando para um copilot FAKE que imprime um roteiro fixo
 * (env FAKE_OUT/FAKE_ERR/FAKE_CODE) e captura os eventos JSONL emitidos.
 *
 * Vários casos documentam comportamento possivelmente indesejado — marcados
 * com `// CARACTERIZAÇÃO:`. NÃO conserte aqui: consertar destruiria o oráculo.
 *
 * US-F5.0 (BUG-BRIDGE1): dois defeitos que o oráculo fixava foram CONSERTADOS
 * no bridge e os casos correspondentes atualizados para o comportamento novo
 * (marcados com `// US-F5.0:`): (1) `evidence`/`learnings` agora são
 * repassados; (2) o fallback sem bloco KANBAN_RESULT válido virou `done:false`.
 */

const ADAPTER = resolve(
  __dirname,
  '../../../../../../docker/copilot-cli-adapter.mjs',
);

// Copilot fake: imprime FAKE_OUT no stdout, FAKE_ERR no stderr e sai com
// FAKE_CODE. Termina em `.mjs` de propósito: o adapter detecta a extensão e o
// invoca via `node` (mesmo caminho do index.js montado read-only em produção).
const fixtureDir = mkdtempSync(join(tmpdir(), 'us-f3-2-bridge-'));
const FAKE_BIN = join(fixtureDir, 'fake-copilot.mjs');
writeFileSync(
  FAKE_BIN,
  [
    "process.stdout.write(process.env.FAKE_OUT ?? '');",
    "process.stderr.write(process.env.FAKE_ERR ?? '');",
    "process.exit(Number(process.env.FAKE_CODE ?? 0));",
    '',
  ].join('\n'),
);
after(() => rmSync(fixtureDir, { recursive: true, force: true }));

interface BridgeEvent {
  kind: string;
  [k: string]: unknown;
}

/** Roda o adapter real ponta-a-ponta e coleta os eventos JSONL do stdout. */
function runBridge(opts: {
  out?: string;
  err?: string;
  code?: number;
  bin?: string;
}): Promise<BridgeEvent[]> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      process.execPath,
      [ADAPTER, 'prompt de caracterização US-F3.2'],
      {
        env: {
          ...process.env,
          COPILOT_BIN: opts.bin ?? FAKE_BIN,
          FAKE_OUT: opts.out ?? '',
          FAKE_ERR: opts.err ?? '',
          FAKE_CODE: String(opts.code ?? 0),
          // 'copilot' mapeia para '' no MODEL_MAP → sem flag --model (limpo).
          COPILOT_MODEL: 'copilot',
          COPILOT_SESSION_ID: '',
          COPILOT_POLICY_FLAGS: '',
        },
      },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.on('error', rejectP);
    child.on('close', () => {
      try {
        const events = stdout
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as BridgeEvent);
        resolveP(events);
      } catch (e) {
        rejectP(new Error(`stdout do adapter não é JSONL puro: ${String(e)}\n${stdout}`));
      }
    });
  });
}

function lastResult(events: BridgeEvent[]): BridgeEvent {
  const results = events.filter((e) => e.kind === 'result');
  assert.equal(results.length, 1, 'esperado exatamente 1 evento result');
  return results[0];
}

const RESULT_BLOCK = (json: string) =>
  `<<<KANBAN_RESULT>>>\n${json}\n<<<END_KANBAN_RESULT>>>`;

// ───────────────────────── Caminho feliz e variações ─────────────────────────

test('bridge: bloco KANBAN_RESULT completo — campos mapeados, INCLUINDO evidence e learnings', async () => {
  const out = [
    'Fiz o trabalho da iteração.',
    RESULT_BLOCK(
      JSON.stringify({
        summary: 'implementei o parser',
        dodTouched: ['d1', 'd2'],
        affectedFlows: [{ name: 'loop', files: ['a.ts'], note: 'parser novo' }],
        nextStep: 'validar com specs',
        done: true,
        evidence: { checks: [{ name: 'test', passed: true }] },
        learnings: [{ path: 'modules/x.md', summary: 'aprendizado' }],
      }),
    ),
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.summary, 'implementei o parser');
  // O bridge NÃO limita a 1 id (a regra nano é aplicada no orchestrator).
  assert.deepEqual(r.dodTouched, ['d1', 'd2']);
  assert.deepEqual(r.affectedFlows, [
    { name: 'loop', files: ['a.ts'], note: 'parser novo' },
  ]);
  assert.equal(r.nextStep, 'validar com specs');
  assert.equal(r.done, true);
  // `detail` é o stdout INTEIRO (trim), incluindo os próprios marcadores.
  assert.ok(String(r.detail).includes('<<<KANBAN_RESULT>>>'));
  assert.ok(String(r.detail).startsWith('Fiz o trabalho da iteração.'));
  // US-F5.0 (BUG-BRIDGE1): o comportamento ANTERIOR (fixado pelo oráculo da
  // US-F3.2) descartava `evidence` e `learnings` aqui — era o bug que impedia
  // qualquer aprendizado de ser persistido pelo caminho de produção. Agora o
  // bridge repassa os dois campos crus (a normalização vive no
  // CliAdapter.parseLine).
  assert.deepEqual(r.evidence, { checks: [{ name: 'test', passed: true }] });
  assert.deepEqual(r.learnings, [{ path: 'modules/x.md', summary: 'aprendizado' }]);
});

test('bridge: bloco mínimo — defaults; summary ausente cai na ÚLTIMA linha (o marcador de fechamento)', async () => {
  const out = `Prosa.\n${RESULT_BLOCK('{ "done": false }')}`;
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.deepEqual(r.dodTouched, []);
  assert.deepEqual(r.affectedFlows, []);
  assert.equal(r.nextStep, '');
  assert.equal(r.done, false);
  assert.ok(!('proposedDod' in r));
  // CARACTERIZAÇÃO: comportamento atual, possivelmente indesejado — ver reporte.
  // Sem `summary` no bloco, o fallback é lastLine(texto completo) — que é o
  // próprio marcador `<<<END_KANBAN_RESULT>>>` quando o bloco fecha a resposta.
  assert.equal(r.summary, '<<<END_KANBAN_RESULT>>>');
});

test('bridge: proposedDod presente (fase de análise) — strings vazias filtradas, não-strings coagidas', async () => {
  const out = RESULT_BLOCK(
    JSON.stringify({
      summary: 'análise',
      proposedDod: ['critério 1', '   ', 42, 'critério 2'],
      done: false,
    }),
  );
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.deepEqual(r.proposedDod, ['critério 1', '42', 'critério 2']);
});

test('bridge: unicode, acentos e quebras de linha dentro dos valores são preservados', async () => {
  const out = RESULT_BLOCK(
    JSON.stringify({
      summary: 'ação concluída — café ☕ e emoção',
      nextStep: 'linha 1\nlinha 2 com ç',
      done: false,
    }),
  );
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.summary, 'ação concluída — café ☕ e emoção');
  assert.equal(r.nextStep, 'linha 1\nlinha 2 com ç');
});

// ───────────────────────────────── Degenerados ────────────────────────────────

test('bridge: resposta SÓ prosa (sem bloco), exit 0 → done:false (não fecha task sem evidência)', async () => {
  const out = 'Refatorei o módulo.\nTudo certo por aqui.';
  const events = await runBridge({ out });
  const r = lastResult(events);
  // US-F5.0: o comportamento ANTERIOR era `done: true` — a task era fechada
  // só porque a AI respondeu prosa e a CLI saiu limpa (o "done fantasma" do
  // BUG-BRIDGE1). Fechar task exige um bloco KANBAN_RESULT válido; sem ele a
  // iteração é sempre inconclusa.
  assert.equal(r.done, false);
  assert.equal(r.summary, 'Tudo certo por aqui.');
  assert.equal(r.detail, out);
  assert.deepEqual(r.dodTouched, []);
  assert.ok(!('fatalError' in r));
});

test('bridge: prosa sem bloco, exit != 0 COM texto → done:false, sem fatalError', async () => {
  const events = await runBridge({ out: 'trabalhei mas falhou algo', code: 1 });
  const r = lastResult(events);
  assert.equal(r.done, false);
  assert.ok(!('fatalError' in r));
});

test('bridge: marcador de ABERTURA sem fechamento → bloco ignorado, fallback done:false', async () => {
  const out = '<<<KANBAN_RESULT>>>\n{ "summary": "x", "done": false }';
  const events = await runBridge({ out });
  const r = lastResult(events);
  // O regex exige o par abre/fecha; sem o fechamento o bloco inteiro é tratado
  // como prosa. US-F5.0: antes o fallback era `done: true` (exit 0) — agora é
  // `done: false`, pois não houve bloco KANBAN_RESULT válido.
  assert.equal(r.done, false);
  assert.deepEqual(r.dodTouched, []);
});

test('bridge: marcador de FECHAMENTO sem abertura → fallback done:false', async () => {
  const out = '{ "summary": "x", "done": false }\n<<<END_KANBAN_RESULT>>>';
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.done, false); // US-F5.0: mesmo caso do teste acima (antes: true).
});

test('bridge: JSON inválido dentro do bloco → fallback silencioso, mas done:false', async () => {
  const out = RESULT_BLOCK('{ summary: sem aspas, isto não é JSON }');
  const events = await runBridge({ out });
  const r = lastResult(events);
  // JSON quebrado dentro do bloco NÃO gera erro nem question: o parse falha em
  // silêncio. US-F5.0: o comportamento ANTERIOR marcava `done: true` (exit 0)
  // — o degenerado mais perigoso do protocolo, pois fechava a task sem nenhum
  // resultado estruturado. Agora cai em `done: false` e o loop segue.
  assert.equal(r.done, false);
  assert.deepEqual(r.dodTouched, []);
  assert.equal(r.summary, '<<<END_KANBAN_RESULT>>>');
});

test('bridge: tipos errados nos campos — dodTouched string vira [], done "true" vira false, nextStep numérico vira ""', async () => {
  const out = RESULT_BLOCK(
    JSON.stringify({
      summary: 'tipos errados',
      dodTouched: 'd1',
      done: 'true',
      nextStep: 123,
    }),
  );
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.deepEqual(r.dodTouched, []);
  // CARACTERIZAÇÃO: `done` só é true com booleano estrito; a string "true" é
  // silenciosamente rebaixada para false (sem aviso à AI nem ao humano).
  assert.equal(r.done, false);
  assert.equal(r.nextStep, '');
});

test('bridge: campo desconhecido a mais no bloco é ignorado sem vazar para o evento', async () => {
  const out = RESULT_BLOCK(
    JSON.stringify({ summary: 'ok', done: false, banana: 'nanica', foo: { a: 1 } }),
  );
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.summary, 'ok');
  assert.ok(!('banana' in r));
  assert.ok(!('foo' in r));
});

test('bridge: DOIS blocos KANBAN_RESULT na mesma resposta → o PRIMEIRO vence', async () => {
  const out = [
    RESULT_BLOCK(JSON.stringify({ summary: 'primeiro', done: false })),
    'texto entre blocos',
    RESULT_BLOCK(JSON.stringify({ summary: 'segundo', done: true })),
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  // CARACTERIZAÇÃO: regex não-guloso casa o PRIMEIRO par de marcadores; o
  // segundo bloco (que poderia ser uma correção da AI) é ignorado.
  assert.equal(r.summary, 'primeiro');
  assert.equal(r.done, false);
});

test('bridge: bloco no MEIO da resposta (texto antes e depois) é aceito', async () => {
  const out = [
    'preâmbulo humano',
    RESULT_BLOCK(JSON.stringify({ summary: 'no meio', done: false })),
    'epílogo depois do bloco',
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.summary, 'no meio');
  // detail preserva o texto inteiro, inclusive o epílogo.
  assert.ok(String(r.detail).includes('epílogo depois do bloco'));
});

test('bridge: cerca markdown ```json DENTRO dos marcadores é removida antes do parse', async () => {
  const out = [
    '<<<KANBAN_RESULT>>>',
    '```json',
    JSON.stringify({ summary: 'com cerca', done: false }),
    '```',
    '<<<END_KANBAN_RESULT>>>',
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.summary, 'com cerca');
});

test('bridge: marcadores DENTRO de uma cerca markdown também são aceitos', async () => {
  const out = [
    '```',
    RESULT_BLOCK(JSON.stringify({ summary: 'dentro de cerca', done: false })),
    '```',
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.summary, 'dentro de cerca');
});

test('bridge: resposta vazia com exit 0 → done:false com detail sintético', async () => {
  const events = await runBridge({ out: '' });
  const r = lastResult(events);
  // US-F5.0: antes uma resposta VAZIA com exit 0 contava como iteração
  // concluída (`done: true`) — o extremo do "done fantasma". Sem bloco
  // KANBAN_RESULT válido, a iteração é inconclusa.
  assert.equal(r.done, false);
  assert.equal(r.detail, 'Copilot CLI encerrou com código 0.');
});

test('bridge: resposta só com whitespace → mesmo caminho da vazia', async () => {
  const events = await runBridge({ out: '   \n\n  \t\n' });
  const r = lastResult(events);
  assert.equal(r.done, false); // US-F5.0: mesmo caso da resposta vazia (antes: true).
  assert.equal(r.detail, 'Copilot CLI encerrou com código 0.');
});

// ─────────────────────── KANBAN_QUESTION e coexistência ───────────────────────

test('bridge: KANBAN_QUESTION sozinho → evento question + result done:false com a pergunta no nextStep', async () => {
  const out = [
    'Preciso de uma decisão.',
    '<<<KANBAN_QUESTION>>>',
    JSON.stringify({ prompt: 'Qual banco usar?', options: ['postgres', 'sqlite'] }),
    '<<<END_KANBAN_QUESTION>>>',
  ].join('\n');
  const events = await runBridge({ out });
  const q = events.find((e) => e.kind === 'question');
  assert.ok(q, 'esperado evento question');
  assert.equal(q?.prompt, 'Qual banco usar?');
  assert.deepEqual(q?.options, ['postgres', 'sqlite']);
  assert.match(String(q?.id), /^q-\d+$/);
  const r = lastResult(events);
  assert.equal(r.done, false);
  assert.equal(r.summary, 'AI aguardando decisão humana: Qual banco usar?');
  assert.ok(
    String(r.nextStep).startsWith('Pergunta ao humano: Qual banco usar?'),
  );
  assert.ok(String(r.nextStep).includes('(opções: postgres | sqlite)'));
});

test('bridge: KANBAN_RESULT E KANBAN_QUESTION na mesma resposta → a QUESTION vence, o result do bloco é ignorado', async () => {
  const out = [
    RESULT_BLOCK(JSON.stringify({ summary: 'resultado', done: true, dodTouched: ['d1'] })),
    '<<<KANBAN_QUESTION>>>',
    JSON.stringify({ prompt: 'Continuo?' }),
    '<<<END_KANBAN_QUESTION>>>',
  ].join('\n');
  const events = await runBridge({ out });
  // CARACTERIZAÇÃO: o prompt PROÍBE emitir os dois, mas quando a AI o faz, a
  // ordem de extração do bridge dá precedência à QUESTION: o bloco RESULT
  // inteiro (done:true, dodTouched) é descartado sem aviso.
  assert.ok(events.some((e) => e.kind === 'question'));
  const r = lastResult(events);
  assert.equal(r.done, false);
  assert.deepEqual(r.dodTouched, []);
  assert.equal(r.summary, 'AI aguardando decisão humana: Continuo?');
});

test('bridge: KANBAN_QUESTION com JSON inválido → sem evento question; fallback done:false', async () => {
  const out = [
    '<<<KANBAN_QUESTION>>>',
    '{ prompt sem aspas }',
    '<<<END_KANBAN_QUESTION>>>',
  ].join('\n');
  const events = await runBridge({ out });
  // CARACTERIZAÇÃO: uma pergunta malformada segue não virando question NEM
  // erro (defeito separado, fora da US-F5.0). US-F5.0: mas o fallback deixou
  // de fechar a iteração — antes era `done: true` em exit 0, engolindo o
  // pedido de HITL E concluindo a task; agora é `done: false`.
  assert.ok(!events.some((e) => e.kind === 'question'));
  const r = lastResult(events);
  assert.equal(r.done, false);
});

// ──────────────────────── Telemetria (rodapé de stats) ────────────────────────

test('bridge: rodapé de tokens presente → inputTokens/outputTokens anexados ao result', async () => {
  const out = [
    RESULT_BLOCK(JSON.stringify({ summary: 'ok', done: false })),
    'Tokens     ↑ 1.5k (1.2k written) • ↓ 42',
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.inputTokens, 1500);
  assert.equal(r.outputTokens, 42);
});

test('bridge: rodapé ausente → campos de tokens ausentes do result', async () => {
  const out = RESULT_BLOCK(JSON.stringify({ summary: 'ok', done: false }));
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.ok(!('inputTokens' in r));
  assert.ok(!('outputTokens' in r));
});

test('bridge: DOIS rodapés de tokens → a ÚLTIMA leitura vence', async () => {
  const out = [
    'Tokens     ↑ 9k • ↓ 900',
    RESULT_BLOCK(JSON.stringify({ summary: 'ok', done: false })),
    'Tokens     ↑ 2k • ↓ 200',
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.equal(r.inputTokens, 2000);
  assert.equal(r.outputTokens, 200);
});

test('bridge: último rodapé MALFORMADO descarta a leitura válida anterior → tokens ausentes', async () => {
  const out = [
    'Tokens     ↑ 9k • ↓ 900',
    RESULT_BLOCK(JSON.stringify({ summary: 'ok', done: false })),
    'Tokens     ↑ ??? • ↓ ???',
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  // CARACTERIZAÇÃO: comportamento atual, possivelmente indesejado — ver reporte.
  // O parser pega a ÚLTIMA linha "Tokens …↑↓" e para ali; se ela for
  // malformada, a leitura VÁLIDA anterior é ignorada e a iteração fica sem
  // telemetria alguma.
  assert.ok(!('inputTokens' in r));
  assert.ok(!('outputTokens' in r));
});

// ────────────────────────────── fatalError ──────────────────────────────

test('bridge: exit != 0 SEM texto de trabalho → fatalError (infra, não iteração)', async () => {
  const events = await runBridge({ out: '', err: 'boom da CLI', code: 2 });
  const r = lastResult(events);
  assert.equal(r.done, false);
  assert.match(String(r.fatalError), /^fatal: CLI saiu com código 2/);
  assert.ok(String(r.fatalError).includes('boom da CLI'));
  // O detail cai para o stderr quando não há stdout.
  assert.equal(r.detail, 'boom da CLI');
});

test('bridge: padrão fatal conhecido no texto (não autenticado) → fatalError mesmo com exit 0', async () => {
  const events = await runBridge({
    out: 'Error: not authenticated. Please login.',
  });
  const r = lastResult(events);
  assert.equal(r.done, false);
  assert.match(String(r.fatalError), /^fatal:/);
});

test('bridge: prosa inocente contendo "is not available" dispara fatalError (falso positivo)', async () => {
  const out =
    'Analisei o legado.\nA função antiga is not available nesta versão, então usei outra.';
  const events = await runBridge({ out });
  const r = lastResult(events);
  // CARACTERIZAÇÃO: comportamento atual, possivelmente indesejado — ver reporte.
  // O padrão fatal /is not available/ casa em prosa legítima da AI (sem bloco
  // estruturado): a iteração normal vira erro fatal e o loop PARA à toa.
  assert.match(String(r.fatalError), /^fatal:/);
  assert.equal(r.done, false);
});

test('bridge: padrão fatal no texto MAS com bloco KANBAN_RESULT → o bloco vence, sem fatalError', async () => {
  const out = [
    'A rota antiga is not available; migrei para a nova.',
    RESULT_BLOCK(JSON.stringify({ summary: 'migração ok', done: true })),
  ].join('\n');
  const events = await runBridge({ out });
  const r = lastResult(events);
  assert.ok(!('fatalError' in r));
  assert.equal(r.done, true);
});

test('bridge: falha de SPAWN do copilot → DOIS results com fatalError; o último (genérico) é o que o runner fica', async () => {
  const events = await runBridge({
    bin: '/caminho/inexistente/copilot-us-f3-2',
  });
  // CARACTERIZAÇÃO: comportamento atual, possivelmente indesejado — ver reporte.
  // No ENOENT o handler de `error` emite o result fatal informativo ("spawn:
  // …"), mas o `close` do child TAMBÉM dispara (code -2) e o finalize emite um
  // SEGUNDO result fatal genérico ("fatal: CLI saiu com código -2"). Como no
  // runner o último `result` sobrescreve o anterior, o motivo informativo do
  // spawn se perde — sobra só o genérico. Ambos são fatais (fail-fast mantido).
  const results = events.filter((e) => e.kind === 'result');
  assert.equal(results.length, 2);
  assert.equal(results[0].done, false);
  assert.match(String(results[0].fatalError), /^spawn: /);
  assert.ok(String(results[0].detail).includes('Falha ao invocar'));
  assert.equal(results[1].done, false);
  assert.match(String(results[1].fatalError), /^fatal: CLI saiu com código/);
});

// ───────────────────────── Filtro de streaming (output) ─────────────────────────

test('bridge: linhas do bloco de controle NÃO vazam como eventos output; a prosa vaza', async () => {
  const out = [
    'preâmbulo humano',
    RESULT_BLOCK(JSON.stringify({ summary: 'ok', done: false })),
  ].join('\n');
  const events = await runBridge({ out });
  const outputs = events
    .filter((e) => e.kind === 'output')
    .map((e) => String(e.text));
  assert.ok(outputs.includes('preâmbulo humano'));
  assert.ok(outputs.every((t) => !t.includes('KANBAN_RESULT')));
  assert.ok(outputs.every((t) => !t.includes('"summary"')));
});
