import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { TanStackRunner } from './tanstack.runner';
import { Orchestrator } from '../orchestrator';
import type {
  AgentChunk,
  AgentQuestion,
  AgentRunInput,
  AgentRunResult,
} from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';

/**
 * US-F3.5 — `outputSchema` fim-a-fim no `TanStackRunner`, contra o mesmo
 * servidor FAKE OpenAI-compatível da US-F3.4.
 *
 * Três blocos:
 *  1. o transporte: o request LEVA o JSON Schema (response_format) e o
 *     resultado estruturado vira `AgentRunResult` — incluindo a RESSURREIÇÃO
 *     de `evidence`/`learnings` (mudança de comportamento anunciada, §5 Passo 3
 *     da US-F3.3: o bridge os descartava — BUG-BRIDGE1);
 *  2. os degenerados do mundo novo: payload que não casa o schema ⇒ iteração
 *     inconclusa (`done:false`), NUNCA o done-fantasma do marcador;
 *  3. o `buildPrompt` compartilhado: com `structuredOutput` as seções de
 *     FORMATO somem; sem o flag (caminho Copilot) o prompt fica IDÊNTICO.
 *
 * As paridades do caminho de FALLBACK (resposta não-JSON → protocolo de
 * marcadores) continuam fixadas na spec pré-existente `tanstack.runner.spec.ts`
 * — que roda inalterada contra este mesmo runner.
 */

interface FakeScript {
  deltas?: string[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const scripts: FakeScript[] = [];
const requests: Array<Record<string, unknown>> = [];
let server: Server;
let baseUrl = '';

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        requests.push({});
      }
      const script = scripts.shift() ?? {};
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-1' };
      const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      for (const delta of script.deltas ?? []) {
        res.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: delta } }] }));
      }
      res.write(
        sse({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          ...(script.usage ? { usage: { ...script.usage, total_tokens: 0 } } : {}),
        }),
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server sem porta');
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

function makeConfig(requireStructuredEvidence = false): AppConfig {
  return {
    agent: {
      streamIdleTimeoutMs: 5_000,
      requireStructuredEvidence,
      tanstack: { baseUrl, model: 'fake-1' },
    },
  } as unknown as AppConfig;
}

function runWith(
  script: FakeScript,
  inputOverrides?: Partial<AgentRunInput>,
  requireStructuredEvidence = false,
): Promise<AgentRunResult> {
  scripts.push(script);
  const runner = new TanStackRunner(makeConfig(requireStructuredEvidence));
  return runner.run({
    cwd: process.cwd(),
    model: '',
    phase: 'implementation',
    prompt: 'faca algo',
    ...inputOverrides,
  } as AgentRunInput);
}

/** Resposta estruturada do "modelo": o objeto raiz {response: ...} como JSON. */
const STRUCTURED = (response: Record<string, unknown>) => JSON.stringify({ response });

// ───────────── 1. transporte: schema no request, objeto no result ─────────────

test('schema e2e: request leva response_format json_schema com os campos da iteração', async () => {
  requests.length = 0;
  await runWith({ deltas: [STRUCTURED({ kind: 'result', summary: 'ok', dodTouched: [], nextStep: '', done: false })] });
  const req = requests[0];
  const rf = req.response_format as {
    type?: string;
    json_schema?: { schema?: Record<string, unknown>; strict?: boolean };
  };
  assert.ok(rf, 'request deve carregar response_format');
  assert.equal(rf.type, 'json_schema');
  const schemaJson = JSON.stringify(rf.json_schema?.schema ?? {});
  assert.ok(schemaJson.includes('dodTouched'));
  assert.ok(schemaJson.includes('regra nano'), 'describes chegam ao provider');
});

test('schema e2e: resultado bem formado vira AgentRunResult COMPLETO — evidence e learnings PRESENTES (ressurreição, BUG-BRIDGE1)', async () => {
  // ⚠️ MUDANÇA DE COMPORTAMENTO (isolada e anunciada — §5 Passo 3 da F3.3):
  // no protocolo de marcadores estes dois campos NUNCA chegavam ao servidor
  // (o bridge os descartava; o TanStackRunner da F3.4 preservou o descarte de
  // propósito). Com o schema, a memória viva passa a receber o que a AI
  // escrever — o `.describe()` anti-invenção de `learnings` entra JUNTO.
  const raw = STRUCTURED({
    kind: 'result',
    summary: 'implementei o parser',
    dodTouched: ['d1'],
    affectedFlows: [{ name: 'loop', files: ['a.ts'], note: 'parser novo' }],
    nextStep: 'validar com specs',
    done: true,
    evidence: 'npm test: 12 passed; build ok',
    learnings: [{ path: 'modules/x.md', summary: 'aprendizado durável' }],
  });
  const r = await runWith({ deltas: [raw], usage: { prompt_tokens: 1500, completion_tokens: 42 } });
  assert.equal(r.summary, 'implementei o parser');
  assert.deepEqual(r.dodTouched, ['d1']);
  assert.deepEqual(r.affectedFlows, [{ name: 'loop', files: ['a.ts'], note: 'parser novo' }]);
  assert.equal(r.nextStep, 'validar com specs');
  assert.equal(r.done, true);
  // A diferença mais visível vs. o oráculo (que fixa o DESCARTE no marcador):
  assert.equal(r.evidence, 'npm test: 12 passed; build ok');
  assert.deepEqual(r.learnings, [{ path: 'modules/x.md', summary: 'aprendizado durável' }]);
  // detail agora é o JSON cru do turno (não há mais prosa em volta).
  assert.equal(r.detail, raw);
  assert.equal(r.provider, 'tanstack');
  assert.equal(r.inputTokens, 1500);
  assert.equal(r.outputTokens, 42);
});

test('schema e2e: variante question dispara HITL com options (paridade de shape com o marcador)', async () => {
  const questions: AgentQuestion[] = [];
  const r = await runWith(
    { deltas: [STRUCTURED({ kind: 'question', prompt: 'Continuo?', options: ['sim', 'não'] })] },
    { onQuestion: (q) => (questions.push(q), Promise.resolve('sim')) },
  );
  assert.equal(questions.length, 1);
  assert.equal(questions[0].prompt, 'Continuo?');
  assert.deepEqual(questions[0].options, ['sim', 'não']);
  assert.equal(r.done, false);
  assert.equal(r.summary, 'AI aguardando decisão humana: Continuo?');
});

// ───────── 2. degenerados do mundo novo: payload que não casa o schema ─────────

test('schema e2e: regra nano IMPOSTA — 2 ids em dodTouched rejeitam a iteração (done:false, ids não passam)', async () => {
  // Validação empírica #3 da história: o que acontece com 2+ ids.
  const r = await runWith({
    deltas: [STRUCTURED({ kind: 'result', summary: 'adiantei', dodTouched: ['d1', 'd2'], nextStep: '', done: false })],
  });
  assert.equal(r.done, false);
  assert.deepEqual(r.dodTouched, []);
  assert.match(r.summary, /rejeitado pelo schema/);
  assert.match(r.detail, /dodTouched/);
  assert.ok(!('fatalError' in r), 'não é falha de infra — é iteração inconclusa');
});

test('schema e2e: done:true SEM evidence é rejeitado pelo schema (R5)', async () => {
  const r = await runWith({
    deltas: [STRUCTURED({ kind: 'result', summary: 'acabei', dodTouched: [], nextStep: '', done: true })],
  });
  assert.equal(r.done, false);
  assert.match(r.detail, /evidence/);
});

test('schema e2e: JSON válido que NÃO casa o schema → iteração inconclusa com as issues no detail (substitui o "bloco malformado")', async () => {
  // Validação empírica #6: o orquestrador recebe done:false + issues legíveis
  // (sem fatalError) e segue o fluxo normal de iteração improdutiva
  // (classifyRunLiveness/continuation) — nunca o done-fantasma do mundo antigo.
  const r = await runWith({ deltas: ['{"foo": 1}'] });
  assert.equal(r.done, false);
  assert.match(r.summary, /rejeitado pelo schema/);
  assert.match(r.detail, /Issues:/);
  assert.ok(!('fatalError' in r));
});

test('schema e2e: streaming — deltas de JSON NÃO vazam como output; o summary vira a linha de output do turno', async () => {
  const chunks: AgentChunk[] = [];
  const raw = STRUCTURED({ kind: 'result', summary: 'ok estruturado', dodTouched: [], nextStep: '', done: false });
  await runWith(
    // partido no meio para exercitar o sniffer com deltas parciais
    { deltas: [raw.slice(0, 7), raw.slice(7)] },
    { onChunk: (c) => chunks.push(c) },
  );
  const outputs = chunks.filter((c) => c.kind === 'output').map((c) => c.delta);
  assert.ok(outputs.every((t) => !t.includes('{')), 'JSON cru não vaza no transcript');
  assert.deepEqual(outputs, ['ok estruturado']);
});

// ───────── 3. buildPrompt compartilhado: schema tira o FORMATO, Copilot intacto ─────────

/**
 * Chamamos o buildPrompt direto no prototype com um `this` mínimo (ele só usa
 * `config.agent.requireStructuredEvidence`) — mesma estratégia white-box das
 * specs ctx-enrichment, sem montar o Orchestrator inteiro.
 */
function buildPrompt(structuredOutput: boolean, opts?: { analysisSemDod?: boolean; requireStructuredEvidence?: boolean }) {
  const ctx = {
    taskTitle: 'T',
    project: '',
    notes: '',
    flowNames: [],
    files: [],
    storyId: 's1',
    affectedFlows: [],
    dodItems: [],
    iterationHistory: [],
    siblingHandoffs: [],
    epicNotes: [],
    lastDiff: '',
    taskDescription: '',
    storyContext: null,
    epicContext: null,
    priorAttempt: null,
    parentHandoffs: [],
    continuationReason: null,
    startInPlanMode: false,
  };
  const profile = {
    id: 'p',
    name: 'P',
    description: 'd',
    firstStep: 'go',
    phases: ['analysis', 'implementation'],
    validation: 'v',
    toolset: 'full',
  };
  const fakeThis = {
    config: { agent: { requireStructuredEvidence: opts?.requireStructuredEvidence === true } },
  };
  const phase = opts?.analysisSemDod ? 'analysis' : 'implementation';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Orchestrator.prototype as any).buildPrompt.call(
    fakeThis,
    phase,
    profile,
    ctx,
    '',
    '/repo',
    false,
    structuredOutput,
  ) as string;
}

test('buildPrompt: runner com schema NÃO recebe as instruções de marcador; o que não é formato permanece', () => {
  const prompt = buildPrompt(true);
  assert.ok(!prompt.includes('<<<KANBAN_RESULT>>>\n'), 'esqueleto do bloco sai');
  assert.ok(!prompt.includes('formato da sua resposta'));
  assert.ok(!prompt.includes('Regras do bloco'));
  assert.ok(!prompt.includes('<<<KANBAN_QUESTION>>>\n'));
  assert.match(prompt, /resultado estruturado da iteração/);
  // Tudo que NÃO é formato continua: verificação antes do done (R22),
  // granularidade nano (R15/R1-texto), git proibido (R20), escopo (R18/R19),
  // HITL comportamental.
  assert.match(prompt, /ANTES de marcar `done`/);
  assert.match(prompt, /Granularidade \(IMPORTANTE — sessões nano\)/);
  assert.match(prompt, /PROIBIDO — operações de git/);
  assert.match(prompt, /Escopo e diretório de trabalho/);
  assert.match(prompt, /Quando precisar de decisão humana/);
  assert.match(prompt, /variante\s+`question`/);
});

test('buildPrompt: caminho do Copilot (sem flag) segue IDÊNTICO, com as instruções de marcador', () => {
  const prompt = buildPrompt(false);
  assert.match(prompt, /## OBRIGATÓRIO — formato da sua resposta/);
  assert.ok(prompt.includes('<<<KANBAN_RESULT>>>'));
  assert.ok(prompt.includes('<<<END_KANBAN_RESULT>>>'));
  assert.ok(prompt.includes('<<<KANBAN_QUESTION>>>'));
  assert.match(prompt, /Regras do bloco/);
  assert.match(prompt, /NO MÁXIMO 1 id por iteração/);
});

test('buildPrompt: análise-sem-DOD adapta a instrução de proposedDod ao protocolo ativo', () => {
  const schemaPrompt = buildPrompt(true, { analysisSemDod: true });
  assert.match(schemaPrompt, /preencha no seu resultado estruturado o campo `proposedDod`/);
  const markerPrompt = buildPrompt(false, { analysisSemDod: true });
  assert.match(markerPrompt, /emita no `KANBAN_RESULT` o campo `proposedDod`/);
});
