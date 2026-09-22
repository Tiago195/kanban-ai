import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIterationJsonSchema,
  buildIterationSchema,
  finalizeSchemaTurn,
} from './tanstack-output-schema';

/**
 * US-F3.5 — Specs do schema Zod que substitui o protocolo de marcadores no
 * `TanStackRunner`. Cada caso referencia a regra R# do mapa da US-F3.3
 * (docs/specs/ep-f3-regras-do-prompt.md) e, quando diverge do ORÁCULO da
 * US-F3.2 (`cli-bridge.characterization.spec.ts`), a divergência é DELIBERADA
 * e anotada no próprio teste. O oráculo continua descrevendo o caminho do
 * MARCADOR (Copilot + fallback do TanStack), que NÃO muda.
 */

const OPTS = { proposeDod: false, structuredEvidence: false };

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    response: {
      kind: 'result',
      summary: 'implementei o parser',
      dodTouched: ['d1'],
      nextStep: 'validar com specs',
      done: false,
      ...overrides,
    },
  };
}

// ───────────────────────────── R1 — regra nano ─────────────────────────────

test('R1: dodTouched com 2+ ids é REJEITADO pelo schema (iteração inconclusa, nunca done)', () => {
  // Oráculo (marcador): dodTouched ['d1','d2'] passava inteiro e o SERVIDOR
  // fazia slice(0,1). Com schema: o payload é rejeitado ANTES — feedback
  // imediato à AI; a guarda do servidor permanece como cinto (§4 da F3.3).
  const f = finalizeSchemaTurn(validResult({ dodTouched: ['d1', 'd2'] }), '{}', OPTS);
  assert.ok(f.schemaIssues?.some((i) => i.includes('dodTouched')));
  assert.equal(f.result.done, false);
  assert.deepEqual(f.result.dodTouched, []);
  assert.match(f.result.summary, /rejeitado pelo schema/);
  assert.equal(f.question, undefined);
});

test('R1: dodTouched com exatamente 1 id passa', () => {
  const f = finalizeSchemaTurn(validResult(), '{"x":1}', OPTS);
  assert.equal(f.schemaIssues, undefined);
  assert.deepEqual(f.result.dodTouched, ['d1']);
});

// ───────────────────── R3 — proposedDod condicional ─────────────────────

test('R3: fora da análise-sem-DOD o campo proposedDod nem existe no schema (é descartado em silêncio)', () => {
  // Paridade com a idempotência do servidor (ensureDodExists ignora proposta
  // quando a task já tem DOD): o campo extra é STRIPADO, não rejeitado.
  const f = finalizeSchemaTurn(
    validResult({ proposedDod: ['a', 'b', 'c'] }),
    '{}',
    { ...OPTS, proposeDod: false },
  );
  assert.equal(f.schemaIssues, undefined);
  assert.ok(!('proposedDod' in f.result));
});

test('R3: na análise-sem-DOD, proposedDod exige 3 a 7 itens', () => {
  const opts = { ...OPTS, proposeDod: true };
  const poucos = finalizeSchemaTurn(validResult({ proposedDod: ['a', 'b'] }), '{}', opts);
  assert.ok(poucos.schemaIssues?.some((i) => i.includes('proposedDod')));
  const demais = finalizeSchemaTurn(
    validResult({ proposedDod: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }),
    '{}',
    opts,
  );
  assert.ok(demais.schemaIssues?.some((i) => i.includes('proposedDod')));
  const ok = finalizeSchemaTurn(validResult({ proposedDod: ['a', 'b', 'c'] }), '{}', opts);
  assert.equal(ok.schemaIssues, undefined);
  assert.deepEqual(ok.result.proposedDod, ['a', 'b', 'c']);
  // O JSON Schema publicado só carrega o campo quando a condição vale.
  const json = JSON.stringify(buildIterationJsonSchema(opts));
  assert.ok(json.includes('proposedDod'));
  assert.ok(!JSON.stringify(buildIterationJsonSchema(OPTS)).includes('proposedDod'));
});

// ──────────────────── R5 — done:true ⇒ evidence (superRefine) ────────────────────

test('R5: done:true SEM evidence é rejeitado (a órfã mais importante vira constraint)', () => {
  // Oráculo: NADA impunha evidence (flag default off) e o bridge a descartava
  // sempre (BUG-BRIDGE1). Divergência deliberada: agora é cross-field no Zod.
  const f = finalizeSchemaTurn(validResult({ done: true }), '{}', OPTS);
  assert.ok(f.schemaIssues?.some((i) => i.includes('evidence')));
  assert.equal(f.result.done, false);
});

test('R5: done:true com evidence vazia ("") também é rejeitado', () => {
  const f = finalizeSchemaTurn(validResult({ done: true, evidence: '   ' }), '{}', OPTS);
  assert.ok(f.schemaIssues?.some((i) => i.includes('evidence')));
});

test('R5: done:true com evidence string não-vazia passa e a evidence CHEGA no result', () => {
  const f = finalizeSchemaTurn(
    validResult({ done: true, evidence: 'npm test: 12 passed' }),
    '{}',
    OPTS,
  );
  assert.equal(f.schemaIssues, undefined);
  assert.equal(f.result.done, true);
  assert.equal(f.result.evidence, 'npm test: 12 passed');
});

// ──────────── R6 (shape) — evidência estruturada sob a flag ────────────

test('R6: com AGENT_REQUIRE_STRUCTURED_EVIDENCE o shape exige objeto com checks', () => {
  const opts = { ...OPTS, structuredEvidence: true };
  // String livre não casa o shape — divergência do bridge (que degradava em
  // silêncio); o gate "ao menos um passed:true" CONTINUA no servidor (§4).
  const str = finalizeSchemaTurn(validResult({ evidence: 'texto livre' }), '{}', opts);
  assert.ok(str.schemaIssues?.some((i) => i.includes('evidence')));
  const ok = finalizeSchemaTurn(
    validResult({
      done: true,
      evidence: { checks: [{ name: 'test', passed: true, output: '12 passed' }] },
    }),
    '{}',
    opts,
  );
  assert.equal(ok.schemaIssues, undefined);
  assert.deepEqual(ok.result.evidence, {
    checks: [{ name: 'test', passed: true, output: '12 passed' }],
  });
});

// ─────────── R12/R13 — união discriminada result | question ───────────

test('R12: a variante question NÃO carrega result — emitir os dois é impossível por construção', () => {
  // Oráculo: os dois blocos juntos → QUESTION vencia por acidente de ordem e o
  // RESULT era descartado sem aviso. Com a união, campos de result dentro da
  // variante question são STRIPADOS — não há mais precedência a preservar.
  const f = finalizeSchemaTurn(
    {
      response: {
        kind: 'question',
        prompt: 'Continuo?',
        options: ['sim', 'não'],
        // lixo de result que a AI tentou contrabandear:
        done: true,
        dodTouched: ['d1'],
      },
    },
    '{}',
    OPTS,
  );
  assert.equal(f.schemaIssues, undefined);
  assert.ok(f.question);
  assert.equal(f.question?.prompt, 'Continuo?');
  // O result de espera tem o MESMO shape do caminho de marcador (paridade):
  assert.equal(f.result.done, false);
  assert.deepEqual(f.result.dodTouched, []);
  assert.equal(f.result.summary, 'AI aguardando decisão humana: Continuo?');
  assert.match(f.result.nextStep, /^Pergunta ao humano: Continuo\? \(opções: sim \| não\)/);
});

test('R12: payload sem kind válido é rejeitado (sem done fantasma)', () => {
  const f = finalizeSchemaTurn({ response: { summary: 'x' } }, '{}', OPTS);
  assert.ok(f.schemaIssues && f.schemaIssues.length > 0);
  assert.equal(f.result.done, false);
});

// ───────────────────── R14 — options 2 a 4 ─────────────────────

test('R14: options com 1 ou 5+ itens é rejeitado; 2–4 ou omitido passa', () => {
  // Oráculo: o adapter só coagia tipos — NENHUMA contagem era validada (órfã).
  const uma = finalizeSchemaTurn(
    { response: { kind: 'question', prompt: 'P?', options: ['só'] } },
    '{}',
    OPTS,
  );
  assert.ok(uma.schemaIssues?.some((i) => i.includes('options')));
  const cinco = finalizeSchemaTurn(
    { response: { kind: 'question', prompt: 'P?', options: ['a', 'b', 'c', 'd', 'e'] } },
    '{}',
    OPTS,
  );
  assert.ok(cinco.schemaIssues?.some((i) => i.includes('options')));
  const aberta = finalizeSchemaTurn({ response: { kind: 'question', prompt: 'P?' } }, '{}', OPTS);
  assert.equal(aberta.schemaIssues, undefined);
  assert.equal(aberta.question?.options, undefined);
});

// ─────────────── R10 — summary required (mata o fallback lastLine) ───────────────

test('R10: summary ausente/vazio é rejeitado — o bug "summary = <<<END_KANBAN_RESULT>>>" morre por construção', () => {
  const f = finalizeSchemaTurn(validResult({ summary: '' }), '{}', OPTS);
  assert.ok(f.schemaIssues?.some((i) => i.includes('summary')));
});

// ─────────────── Ressurreição de learnings (R11) e omissões ───────────────

test('R11: learnings válidos CHEGAM no AgentRunResult (canal morto no bridge — BUG-BRIDGE1)', () => {
  const f = finalizeSchemaTurn(
    validResult({
      learnings: [{ path: 'modules/x.md', summary: 'aprendizado', scope: 'x' }],
      affectedFlows: [{ name: 'loop', files: ['a.ts'], note: 'parser' }],
    }),
    '{}',
    OPTS,
  );
  assert.deepEqual(f.result.learnings, [{ path: 'modules/x.md', summary: 'aprendizado', scope: 'x' }]);
  // Paridade de shape com o normalizeFlows do marcador (note default ''):
  assert.deepEqual(f.result.affectedFlows, [{ name: 'loop', files: ['a.ts'], note: 'parser' }]);
});

test('omissões: affectedFlows/learnings vazios chegam como campo AUSENTE (paridade CliAdapter)', () => {
  const f = finalizeSchemaTurn(
    validResult({ affectedFlows: [], learnings: [] }),
    '{}',
    OPTS,
  );
  assert.ok(!('affectedFlows' in f.result));
  assert.ok(!('learnings' in f.result));
});

// ─────────────── null-widening do modo strict dos providers ───────────────

test('nulls em campos opcionais (alargamento strict do provider) são tratados como ausência', () => {
  const f = finalizeSchemaTurn(
    validResult({ evidence: null, learnings: null, affectedFlows: null }),
    '{}',
    OPTS,
  );
  assert.equal(f.schemaIssues, undefined);
  assert.ok(!('evidence' in f.result));
  assert.ok(!('learnings' in f.result));
});

// ─────────────── describes — as 8 regras `descrição` chegam pelo schema ───────────────

test('describes: as orientações semânticas (R8/R9/R10/R11/R14/R22) estão no JSON Schema publicado', () => {
  const json = JSON.stringify(
    buildIterationJsonSchema({ proposeDod: true, structuredEvidence: false }),
  );
  assert.ok(json.includes('regra nano'), 'R1 — dodTouched');
  assert.ok(json.includes('acumula por nome'), 'R8 — affectedFlows');
  assert.ok(json.includes('ESPECÍFICO'), 'R9 — nextStep');
  assert.ok(json.includes('UMA linha objetiva'), 'R10 — summary');
  assert.ok(json.includes('NÃO invente'), 'R11 — learnings');
  assert.ok(json.includes('opções CURTAS'), 'R14 — options');
  assert.ok(json.includes('Rode os checks do projeto ANTES'), 'R22 — evidence');
  assert.ok(json.includes('EXATAMENTE UMA variante'), 'R12 — união');
});

test('sanidade: o schema Zod e o JSON Schema publicado concordam no shape básico', () => {
  const schema = buildIterationSchema(OPTS);
  assert.equal(schema.safeParse(validResult()).success, true);
  const json = buildIterationJsonSchema(OPTS) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  // Raiz é OBJETO (endpoints strict rejeitam anyOf na raiz) com a união dentro.
  assert.equal(json.type, 'object');
  assert.ok(json.properties && 'response' in json.properties);
  assert.deepEqual(json.required, ['response']);
});
