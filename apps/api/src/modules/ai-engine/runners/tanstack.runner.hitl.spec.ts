import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { TanStackRunner } from './tanstack.runner';
import { Orchestrator } from '../orchestrator';
import type { AgentQuestion, AgentRunInput, AgentRunResult } from './agent-runner.interface';
import type { AppConfig } from '../../../shared/config/config';

/**
 * US-F3.6 (ADR-0042) — HITL do `TanStackRunner`: fica a variante `question` do
 * schema, NÃO o interrupt nativo do TanStack. A investigação (ver ADR-0042)
 * mostrou que o interrupt nativo (a) só nasce de middleware/`needsApproval` —
 * nunca da resposta do MODELO, que é de onde a pergunta HITL vem; e (b) só
 * atravessa restart se persistirmos o histórico AG-UI completo + descritores
 * de interrupt — estado novo que duplicaria o que `AgentMessage` + prompt
 * auto-suficiente já dão de graça.
 *
 * Estas specs fixam as obrigações que a US-F3.6 exige do caminho escolhido:
 *  1. e2e contra o fake: a IA pergunta → `onQuestion` bloqueia → a resposta
 *     volta → o turno ENCERRA (one-shot; a resposta reentra via handoff) sem
 *     uma segunda chamada ao modelo dentro do mesmo run.
 *  2. `hitlTimeoutMs`: a rejeição de `waitForAnswer` propaga do run().
 *  3. idle timeout SUSPENSO durante a espera humana (o timer morre com o
 *     stream; a espera é governada só pelo hitlTimeoutMs — paridade Copilot).
 *  4. abort durante a espera propaga `Error('aborted')`.
 *  5. RESTART (simulado pelo estado persistido): `loadHitlResume` acha o par
 *     pergunta+resposta órfão (respondido após a última Iteration — só existe
 *     no caminho de resiliência do ADR-0022) e `buildPrompt` o injeta, para a
 *     retomada não depender de sessão em disco (que o tanstack não tem).
 */

interface FakeScript {
  deltas?: string[];
}

const scripts: FakeScript[] = [];
let requestCount = 0;
let server: Server;
let baseUrl = '';

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      void body;
      requestCount += 1;
      const script = scripts.shift() ?? {};
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-1' };
      const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      for (const delta of script.deltas ?? []) {
        res.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: delta } }] }));
      }
      res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
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

function makeConfig(streamIdleTimeoutMs = 5_000): AppConfig {
  return {
    agent: {
      streamIdleTimeoutMs,
      requireStructuredEvidence: false,
      tanstack: { baseUrl, model: 'fake-1' },
    },
  } as unknown as AppConfig;
}

function runWith(
  script: FakeScript,
  inputOverrides?: Partial<AgentRunInput>,
  streamIdleTimeoutMs?: number,
): Promise<AgentRunResult> {
  scripts.push(script);
  const runner = new TanStackRunner(makeConfig(streamIdleTimeoutMs));
  return runner.run({
    cwd: process.cwd(),
    model: '',
    phase: 'implementation',
    prompt: 'faca algo',
    ...inputOverrides,
  } as AgentRunInput);
}

const QUESTION = JSON.stringify({
  response: { kind: 'question', prompt: 'Migrar o schema agora?', options: ['sim', 'não'] },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ───────────────────────── 1. e2e: pergunta → resposta → turno encerra ─────────────────────────

test('hitl e2e: variante question bloqueia em onQuestion, a resposta destrava e o turno encerra SEM segunda chamada ao modelo', async () => {
  const questions: AgentQuestion[] = [];
  const before0 = requestCount;
  let answered = false;
  const result = await runWith(
    { deltas: [QUESTION] },
    {
      onQuestion: async (q) => {
        questions.push(q);
        // Simula o humano demorando a responder (a promise fica pendente).
        await sleep(30);
        answered = true;
        return 'sim';
      },
    },
  );
  assert.equal(questions.length, 1, 'R13: exatamente UMA pergunta por turno');
  assert.equal(questions[0].prompt, 'Migrar o schema agora?');
  assert.deepEqual(questions[0].options, ['sim', 'não'], 'R14: opções preservadas');
  assert.equal(answered, true, 'run() só retornou depois da resposta humana');
  // Modelo one-shot: o turno encerra aguardando; a resposta reentra via
  // handoff da PRÓXIMA iteração — nunca uma segunda chamada no MESMO run.
  assert.equal(requestCount - before0, 1, 'uma única chamada ao provider');
  assert.equal(result.done, false);
  assert.match(result.summary, /aguardando decisão humana/);
  assert.match(result.nextStep, /Migrar o schema agora\?/);
});

// ───────────────────────── 2. hitlTimeoutMs propaga ─────────────────────────

test('hitl timeout: rejeição de waitForAnswer (hitlTimeoutMs) propaga do run() com a mesma mensagem', async () => {
  await assert.rejects(
    runWith(
      { deltas: [QUESTION] },
      { onQuestion: () => Promise.reject(new Error('HITL timeout (100ms)')) },
    ),
    /HITL timeout \(100ms\)/,
  );
});

// ───────────────────────── 3. idle timeout suspenso na espera humana ─────────────────────────

test('idle suspenso: espera humana MAIOR que streamIdleTimeoutMs NÃO mata o turno (timer morre com o stream)', async () => {
  // idle de 500ms; humano demora 1500ms. Se o idle governasse a espera, o run
  // rejeitaria com 'stream idle timeout (500ms)'. A espera é do hitlTimeoutMs.
  //
  // US-F3.11 — margens alargadas (era 80ms × 300ms): o timer de idle roda
  // DURANTE o streaming, e sob carga a máquina estoura 80ms entre chunks —
  // abort espúrio visto em 2 runs independentes. 500ms absorve o jitter do
  // scheduler; a espera de 1500ms mantém a prova (sleep ≫ idle: se o idle
  // governasse a espera humana, ele dispararia com 1s de folga).
  const result = await runWith(
    { deltas: [QUESTION] },
    {
      onQuestion: async () => {
        await sleep(1500);
        return 'sim';
      },
    },
    500,
  );
  assert.equal(result.done, false);
  assert.match(result.summary, /aguardando decisão humana/);
});

// ───────────────────────── 4. abort durante a espera ─────────────────────────

test('abort na espera: reject Error("aborted") da pergunta pendente propaga como no Copilot', async () => {
  await assert.rejects(
    runWith(
      { deltas: [QUESTION] },
      { onQuestion: () => Promise.reject(new Error('aborted')) },
    ),
    /^Error: aborted$/,
  );
});

// ───────────────────────── 5. restart simulado: o que sobrevive ─────────────────────────

/**
 * O que SOBREVIVE a um restart no caminho escolhido (tudo no Postgres):
 *  - a pergunta (AgentMessage role=ai + questionId + options) → o front reidrata
 *    os chips e `answerQuestion` acha a pergunta (ADR-0022);
 *  - a resposta (AgentMessage role=user, mesmo questionId) persistida pelo
 *    caminho de resiliência;
 *  - a retomada: `loadHitlResume` + `buildPrompt` reinjetam o par na próxima
 *    iteração (isto é o que a US-F3.6 fecha para runners sem sessão em disco).
 * O que NÃO sobrevive (por desenho, ADR-0018): a promise de `waitForAnswer` e
 * o estado in-process da sessão — dispensáveis, pois o turno é one-shot.
 */

type FindFirstArgs = { where: Record<string, unknown> };

function fakeOrchestrator(rows: {
  answer?: { ts: Date; text: string; questionId: string } | null;
  question?: { text: string } | null;
  lastIteration?: { ts: Date } | null;
  throwOnRead?: boolean;
}) {
  return {
    logger: { warn: () => undefined },
    prisma: {
      agentMessage: {
        findFirst: async (q: FindFirstArgs) => {
          if (rows.throwOnRead) throw new Error('db off');
          return q.where.role === 'user' ? (rows.answer ?? null) : (rows.question ?? null);
        },
      },
      iteration: {
        findFirst: async () => rows.lastIteration ?? null,
      },
    },
  };
}

const loadHitlResume = (
  self: ReturnType<typeof fakeOrchestrator>,
): Promise<{ prompt: string; answer: string } | null> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Orchestrator.prototype as any).loadHitlResume.call(self, 'task-1');

test('restart: resposta ÓRFÃ (posterior à última Iteration) → par pergunta+resposta recuperado do banco', async () => {
  const resume = await loadHitlResume(
    fakeOrchestrator({
      answer: { ts: new Date('2026-01-02'), text: 'sim', questionId: 'q1' },
      question: { text: 'Migrar o schema agora?' },
      lastIteration: { ts: new Date('2026-01-01') },
    }),
  );
  assert.deepEqual(resume, { prompt: 'Migrar o schema agora?', answer: 'sim' });
});

test('restart: SEM Iteration nenhuma (morreu na primeira pergunta) → par recuperado mesmo assim', async () => {
  const resume = await loadHitlResume(
    fakeOrchestrator({
      answer: { ts: new Date('2026-01-02'), text: 'não', questionId: 'q1' },
      question: { text: 'Continuo?' },
      lastIteration: null,
    }),
  );
  assert.deepEqual(resume, { prompt: 'Continuo?', answer: 'não' });
});

test('restart: resposta JÁ consumida (anterior à última Iteration) → null — sem dupla injeção no fluxo normal', async () => {
  const resume = await loadHitlResume(
    fakeOrchestrator({
      answer: { ts: new Date('2026-01-01'), text: 'sim', questionId: 'q1' },
      question: { text: 'Continuo?' },
      lastIteration: { ts: new Date('2026-01-02') },
    }),
  );
  assert.equal(resume, null);
});

test('restart: sem resposta humana persistida → null; falha de DB → null (defensivo, nunca derruba o loop)', async () => {
  assert.equal(await loadHitlResume(fakeOrchestrator({ answer: null })), null);
  assert.equal(await loadHitlResume(fakeOrchestrator({ throwOnRead: true })), null);
});

// ───────────────────────── 6. buildPrompt reinjeta o par ─────────────────────────

function buildPrompt(hitlResume: { prompt: string; answer: string } | null) {
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
    hitlResume,
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
  const fakeThis = { config: { agent: { requireStructuredEvidence: false } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Orchestrator.prototype as any).buildPrompt.call(
    fakeThis,
    'implementation',
    profile,
    ctx,
    '',
    '/repo',
    false,
    true,
  ) as string;
}

test('buildPrompt: com hitlResume a seção de retomada entra com pergunta e resposta', () => {
  const prompt = buildPrompt({ prompt: 'Migrar o schema agora?', answer: 'sim' });
  assert.match(prompt, /Decisão humana recebida \(HITL\)/);
  assert.match(prompt, /Pergunta: Migrar o schema agora\?/);
  assert.match(prompt, /Resposta do humano: sim/);
  assert.match(prompt, /NÃO repita a pergunta/);
});

test('buildPrompt: sem hitlResume (fluxo normal) a seção NÃO existe — prompt segue como antes', () => {
  const prompt = buildPrompt(null);
  assert.ok(!prompt.includes('Decisão humana recebida (HITL)'));
});
