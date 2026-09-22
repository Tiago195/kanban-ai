import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CliAdapter, type CliEvent } from './cli-adapter';
import { CopilotCliRunner } from './copilot-cli.runner';
import type {
  AgentChunk,
  AgentRunInput,
  AgentRunResult,
} from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';

/**
 * US-F3.2 — Characterization do contrato de resultado (camada JSONL/runner).
 *
 * Complementa o oráculo do bridge (`cli-bridge.characterization.spec.ts`):
 * aqui fixamos o comportamento ATUAL do `CliAdapter.parseLine` (JSONL →
 * CliEvent) nos casos degenerados que os specs existentes não cobrem, e do
 * `CopilotCliRunner.consume` (fallback sem result, rejeição por exit != 0,
 * "última leitura de tokens vence", propagação de fatalError e provider).
 *
 * NÃO testa comportamento desejado — fixa o que acontece HOJE. Casos suspeitos
 * estão marcados com `// CARACTERIZAÇÃO:`. Não conserte aqui.
 */

function makeConfig(): AppConfig {
  return {
    agent: {
      cliCommand: 'copilot',
      cliArgs: [],
      promptMode: 'stdin',
      hitlTimeoutMs: 1000,
      streamIdleTimeoutMs: 5000,
    },
  } as unknown as AppConfig;
}

function makeAdapter(): CliAdapter {
  return new CliAdapter(makeConfig());
}

type ResultEvent = Extract<CliEvent, { kind: 'result' }>;

function parseResult(adapter: CliAdapter, obj: Record<string, unknown>): ResultEvent {
  const ev = adapter.parseLine(JSON.stringify({ kind: 'result', ...obj }));
  assert.equal(ev?.kind, 'result');
  return ev as ResultEvent;
}

// ───────────────────────── parseLine — linhas degeneradas ─────────────────────────

test('parseLine: linha vazia ou só whitespace → null (descartada)', () => {
  const a = makeAdapter();
  assert.equal(a.parseLine(''), null);
  assert.equal(a.parseLine('   \t  '), null);
});

test('parseLine: linha não-JSON → thought com o texto trimado (fallback tolerante)', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseLine('  apenas prosa da CLI  '), {
    kind: 'thought',
    text: 'apenas prosa da CLI',
  });
});

test('parseLine: JSON escalar (número, string, null) → thought com o texto cru', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseLine('42'), { kind: 'thought', text: '42' });
  assert.deepEqual(a.parseLine('"oi"'), { kind: 'thought', text: '"oi"' });
  // JSON.parse('null') é objeto-null → cai no mesmo fallback de thought.
  assert.deepEqual(a.parseLine('null'), { kind: 'thought', text: 'null' });
});

test('parseLine: JSON objeto sem kind ou com kind desconhecido → thought', () => {
  const a = makeAdapter();
  assert.deepEqual(a.parseLine('{"text":"sem kind"}'), {
    kind: 'thought',
    text: 'sem kind',
  });
  // kind desconhecido SEM text → o texto vira a linha JSON inteira.
  const line = '{"kind":"banana"}';
  assert.deepEqual(a.parseLine(line), { kind: 'thought', text: line });
});

// ───────────────────────── parseLine result — tipos errados ─────────────────────────

test('parseLine result: tipos errados são coagidos/rebaixados em silêncio', () => {
  const a = makeAdapter();
  const r = parseResult(a, {
    detail: 42, // número → coagido para "42"
    summary: null, // null → ""
    dodTouched: 'd1', // string → []
    done: 'true', // string → false (só booleano estrito conta)
    nextStep: { x: 1 }, // objeto → String(obj)
  });
  assert.equal(r.detail, '42');
  assert.equal(r.summary, '');
  assert.deepEqual(r.dodTouched, []);
  // CARACTERIZAÇÃO: comportamento atual, possivelmente indesejado — ver reporte.
  // `done: "true"` (string) é rebaixado para false sem qualquer aviso.
  assert.equal(r.done, false);
  // CARACTERIZAÇÃO: objeto em campo string vira "[object Object]" via String().
  assert.equal(r.nextStep, '[object Object]');
});

test('parseLine result: dodTouched com itens não-string coage cada item via String()', () => {
  const a = makeAdapter();
  const r = parseResult(a, { dodTouched: [1, true, null, 'd2'] });
  // CARACTERIZAÇÃO: null vira a string "null" — nenhum filtro de lixo aqui.
  assert.deepEqual(r.dodTouched, ['1', 'true', 'null', 'd2']);
});

test('parseLine result: proposedDod [] é preservado como array VAZIO (≠ undefined)', () => {
  const a = makeAdapter();
  assert.deepEqual(parseResult(a, { proposedDod: [] }).proposedDod, []);
  assert.equal(parseResult(a, {}).proposedDod, undefined);
  assert.equal(parseResult(a, { proposedDod: 'x' }).proposedDod, undefined);
});

test('parseLine result: tokens só entram se forem number finito; fatalError só se string não-vazia', () => {
  const a = makeAdapter();
  const r1 = parseResult(a, { inputTokens: '1234', outputTokens: null });
  assert.equal(r1.inputTokens, undefined);
  assert.equal(r1.outputTokens, undefined);
  // CARACTERIZAÇÃO: número fracionário é aceito SEM arredondar (12.7 fica 12.7).
  const r2 = parseResult(a, { inputTokens: 12.7, outputTokens: 0 });
  assert.equal(r2.inputTokens, 12.7);
  assert.equal(r2.outputTokens, 0);
  assert.equal(parseResult(a, { fatalError: '' }).fatalError, undefined);
  assert.equal(parseResult(a, { fatalError: '   ' }).fatalError, undefined);
  assert.equal(parseResult(a, { fatalError: 'boom' }).fatalError, 'boom');
});

test('parseLine result: campo desconhecido a mais não vaza para o CliEvent', () => {
  const a = makeAdapter();
  const r = parseResult(a, { summary: 'ok', banana: 'nanica' });
  assert.ok(!('banana' in r));
});

test('parseLine result: unicode/acentos/quebras de linha preservados nos valores', () => {
  const a = makeAdapter();
  const r = parseResult(a, {
    summary: 'ação — café ☕',
    detail: 'linha 1\nlinha 2 com ç',
  });
  assert.equal(r.summary, 'ação — café ☕');
  assert.equal(r.detail, 'linha 1\nlinha 2 com ç');
});

// ───────────────────────── parseLine result — evidence ─────────────────────────

test('parseLine result: evidence string livre (legado) é trimada; vazia vira undefined', () => {
  const a = makeAdapter();
  assert.equal(parseResult(a, { evidence: '  npm test: 12 passed  ' }).evidence, 'npm test: 12 passed');
  assert.equal(parseResult(a, { evidence: '   ' }).evidence, undefined);
  assert.equal(parseResult(a, {}).evidence, undefined);
});

test('parseLine result: evidence estruturada — checks inválidos filtrados, passed exige booleano estrito', () => {
  const a = makeAdapter();
  const r = parseResult(a, {
    evidence: {
      checks: [
        { name: 'test', passed: true, output: ' 12 passed ' },
        { name: 'lint', passed: 'true' }, // passed string → false
        { name: '', passed: true }, // sem name → descartado
        'lixo', // não-objeto → descartado
      ],
      filesChanged: ['a.ts', '  ', 'b.ts'],
      note: ' obs ',
    },
  });
  assert.deepEqual(r.evidence, {
    checks: [
      { name: 'test', passed: true, output: '12 passed' },
      // CARACTERIZAÇÃO: `passed: "true"` vira false — o check aparece como
      // reprovado, sem aviso.
      { name: 'lint', passed: false },
    ],
    filesChanged: ['a.ts', 'b.ts'],
    note: 'obs',
  });
});

test('parseLine result: evidence objeto SEM checks → degrada para a string do note (ou undefined)', () => {
  const a = makeAdapter();
  assert.equal(
    parseResult(a, { evidence: { note: 'verifiquei manualmente' } }).evidence,
    'verifiquei manualmente',
  );
  // CARACTERIZAÇÃO: objeto sem checks nem note é descartado por completo.
  assert.equal(parseResult(a, { evidence: { foo: 1 } }).evidence, undefined);
});

test('parseLine result: evidence com checks:[] é um StructuredEvidence VAZIO (não é string)', () => {
  const a = makeAdapter();
  const r = parseResult(a, { evidence: { checks: [] } });
  assert.deepEqual(r.evidence, { checks: [] });
});

// ───────────────────────── parseLine result — affectedFlows ─────────────────────────

test('parseLine result: affectedFlows filtra entradas sem name; lista vazia/toda inválida vira undefined', () => {
  const a = makeAdapter();
  const r = parseResult(a, {
    affectedFlows: [
      { name: ' loop ', files: ['a.ts', 1], note: '' },
      { files: ['x.ts'] }, // sem name → descartado
      'lixo',
    ],
  });
  // note vazio omite a chave; files não-string coagidos.
  assert.deepEqual(r.affectedFlows, [{ name: 'loop', files: ['a.ts', '1'] }]);
  assert.equal(parseResult(a, { affectedFlows: [] }).affectedFlows, undefined);
  assert.equal(parseResult(a, { affectedFlows: ['só', 'lixo'] }).affectedFlows, undefined);
});

// ───────────────────────── parseLine question ─────────────────────────

test('parseLine question: sem id gera id sintético; options não-array vira undefined', () => {
  const a = makeAdapter();
  const ev = a.parseLine(JSON.stringify({ kind: 'question', prompt: 'qual?', options: 'a' }));
  assert.equal(ev?.kind, 'question');
  const q = ev as Extract<CliEvent, { kind: 'question' }>;
  assert.match(q.id, /^q-\d+$/);
  assert.equal(q.prompt, 'qual?');
  assert.equal(q.options, undefined);
  const ev2 = a.parseLine(JSON.stringify({ kind: 'question', id: 'q1', prompt: 'x', options: [1, 'b'] }));
  assert.deepEqual((ev2 as Extract<CliEvent, { kind: 'question' }>).options, ['1', 'b']);
});

// ───────────────────────── runner (consume) — lacunas do contrato ─────────────────────────

/** Child process fake, mesmo padrão do copilot-cli.runner.spec.ts. */
function makeFakeChild() {
  const child = new EventEmitter() as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: (sig?: string) => boolean;
    emit: (event: string, ...args: unknown[]) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  return child;
}

function runConsume(opts: {
  lines: string[];
  stderr?: string;
  code?: number;
  onChunk?: (c: AgentChunk) => void;
}): Promise<AgentRunResult> {
  const runner = new CopilotCliRunner(makeConfig());
  const child = makeFakeChild();
  const input = {
    prompt: 'faca algo',
    cwd: process.cwd(),
    phase: 'implementation',
    onChunk: opts.onChunk,
  } as unknown as AgentRunInput;
  const priv = runner as unknown as {
    consume: (
      c: unknown,
      input: AgentRunInput,
      stdinPrompt: string | null,
    ) => Promise<AgentRunResult>;
  };
  const promise = priv.consume(child, input, null);
  setImmediate(() => {
    if (opts.stderr) child.stderr.write(opts.stderr);
    for (const l of opts.lines) child.stdout.write(`${l}\n`);
    child.stdout.end();
    setImmediate(() => child.emit('close', opts.code ?? 0));
  });
  return promise;
}

test('runner: processo encerra SEM evento result (exit 0) → fallback done:false com provider copilot', async () => {
  const chunks: AgentChunk[] = [];
  const result = await runConsume({
    lines: ['só prosa que vira thought'],
    onChunk: (c) => chunks.push(c),
  });
  assert.equal(result.done, false);
  assert.equal(result.detail, '(cli) processo encerrou sem evento result');
  assert.equal(result.summary, '(cli) iteração sem resultado estruturado');
  assert.equal(result.nextStep, 'Revisar saída da CLI (nenhum result emitido)');
  assert.deepEqual(result.dodTouched, []);
  assert.equal(result.provider, 'copilot');
  assert.ok(!('fatalError' in result));
  // A prosa foi streamada como thought (fallback tolerante do parseLine).
  assert.deepEqual(chunks, [{ kind: 'thought', delta: 'só prosa que vira thought' }]);
});

test('runner: exit != 0 sem result → rejeita com a cauda do stderr na mensagem', async () => {
  await assert.rejects(
    runConsume({ lines: [], stderr: 'context window exceeded\n', code: 3 }),
    (err: Error) => {
      assert.match(err.message, /^cli exited with code 3: context window exceeded/);
      return true;
    },
  );
});

test('runner: MÚLTIPLOS rodapés de tokens no stdout → a ÚLTIMA leitura vence no backfill', async () => {
  const resultLine = JSON.stringify({
    kind: 'result',
    summary: 'ok',
    detail: 'feito',
    dodTouched: [],
    nextStep: '-',
    done: false,
  });
  const result = await runConsume({
    lines: [
      'Tokens     ↑ 1k • ↓ 100',
      resultLine,
      'Tokens     ↑ 2k • ↓ 200',
    ],
  });
  assert.equal(result.inputTokens, 2000);
  assert.equal(result.outputTokens, 200);
});

test('runner: learnings e evidence do result JSONL são propagados no AgentRunResult (US-F5.0)', async () => {
  // US-F5.0 (BUG-BRIDGE1): o `setResult` do CopilotCliRunner mapeava `evidence`
  // mas DESCARTAVA `learnings` — a segunda metade do vazamento (a primeira era
  // o bridge). Sem este repasse, o `persistLearning` do orchestrator nunca
  // recebia aprendizado algum pelo caminho de produção.
  const resultLine = JSON.stringify({
    kind: 'result',
    summary: 'ok',
    detail: 'feito',
    dodTouched: [],
    nextStep: '-',
    done: false,
    evidence: 'npm test: 653 passed',
    learnings: [{ path: 'modules/x.md', summary: 'aprendizado', scope: 'x' }],
  });
  const result = await runConsume({ lines: [resultLine] });
  assert.equal(result.evidence, 'npm test: 653 passed');
  assert.deepEqual(result.learnings, [
    { path: 'modules/x.md', summary: 'aprendizado', scope: 'x' },
  ]);
});

test('runner: fatalError do result JSONL é propagado no AgentRunResult (com provider backfilled)', async () => {
  const resultLine = JSON.stringify({
    kind: 'result',
    summary: 'erro ao iniciar Copilot CLI',
    detail: 'Falha ao invocar copilot',
    done: false,
    fatalError: 'spawn: ENOENT',
  });
  const result = await runConsume({ lines: [resultLine] });
  assert.equal(result.fatalError, 'spawn: ENOENT');
  assert.equal(result.done, false);
  assert.equal(result.provider, 'copilot');
});

test('runner: DOIS eventos result no mesmo stdout → o ÚLTIMO vence (sobrescreve o primeiro)', async () => {
  const first = JSON.stringify({ kind: 'result', summary: 'primeiro', done: false });
  const second = JSON.stringify({ kind: 'result', summary: 'segundo', done: true });
  const result = await runConsume({ lines: [first, second] });
  // CARACTERIZAÇÃO: na camada JSONL o critério é o OPOSTO do bridge (que fica
  // com o PRIMEIRO bloco de marcadores): aqui cada `result` sobrescreve o
  // anterior e o último vence — ver reporte.
  assert.equal(result.summary, 'segundo');
  assert.equal(result.done, true);
});
