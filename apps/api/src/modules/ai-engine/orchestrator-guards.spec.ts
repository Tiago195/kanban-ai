import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator } from './orchestrator';
import { BUILTIN_LOOP_PROFILES } from './loop-profiles/loop-profiles';

/**
 * Testes de núcleo do loop engine (todo `testes-nucleo`, #4). Estratégia 1:
 * instanciamos o `Orchestrator` diretamente com dependências fake leves e
 * exercitamos as salvaguardas e o ciclo de vida SEM depender de timers reais
 * disparando — asseguramos registro/estado/side-effects de forma síncrona.
 *
 * Cobre: cap de iterações, cap de profundidade de derivação, escalonamento a
 * humano, idempotência do watchdog, stop graceful vs hard, reconciliação no
 * boot e encadeamento de iterações (createDerivedTask).
 */

// ── Fakes ─────────────────────────────────────────────────────────────────

interface RecordedBroadcast {
  type: string;
  [k: string]: unknown;
}

function makeRealtime(): { svc: RealtimeService; events: RecordedBroadcast[] } {
  const events: RecordedBroadcast[] = [];
  const svc = {
    broadcast(event: RecordedBroadcast) {
      events.push(event);
    },
  } as unknown as RealtimeService;
  return { svc, events };
}

/** Config do bloco `agent` com defaults inertes; sobrescreve o necessário. */
function makeConfig(overrides: Partial<AppConfig['agent']> = {}): AppConfig {
  const agent = {
    maxConcurrentSessions: 3,
    watchdogIntervalMs: 120_000,
    autoStepIntervalMs: 1_500,
    hitlTimeoutMs: 600_000,
    maxValidationFailures: 3,
    maxIterationsPerTask: 30,
    maxUnproductiveIterations: 0,
    maxDerivedDepth: 3,
    maxTaskDurationMs: 0,
    maxTaskTokens: 0,
    thrashDetectionEnabled: false,
    thrashSimilarityThreshold: 0.9,
    thrashWindow: 2,
    requireStructuredEvidence: false,
    ...overrides,
  } as unknown as AppConfig['agent'];
  return { agent } as unknown as AppConfig;
}

/** Workspaces fake: nenhuma operação de FS real. */
function makeWorkspaces(): WorkspaceService {
  return {
    ensureWorktree: async () => '/wt',
    cleanupWorktree: async () => undefined,
    fileExistsInWorktree: async () => true,
    findRelatedTestFiles: async () => [],
    runTestsForFiles: async () => ({ name: 't', ran: true, passed: true, exitCode: 0, output: '' }),
    runProjectChecks: async () => [],
  } as unknown as WorkspaceService;
}

function makeValidation(): ValidationRunner {
  return { validate: async () => ({ passed: true, problems: [] }) } as unknown as ValidationRunner;
}

function makeRunner(): AgentRunner {
  return { run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner;
}

/**
 * PrismaService fake genérico. Cada método relevante é um stub configurável via
 * `overrides` (ex.: `iteration.findMany`). Métodos não configurados retornam
 * valores neutros. Registra chamadas de `card.update` em `updates`.
 */
interface FakePrisma {
  svc: PrismaService;
  updates: Array<{ where: unknown; data: Record<string, unknown> }>;
  activities: Array<{ cardId: string; text: string }>;
}

function makemaybe<T>(fn: T | undefined, fallback: T): T {
  return fn ?? fallback;
}

function makePrisma(overrides: {
  iterationFindMany?: () => Promise<unknown[]>;
  iterationCount?: () => Promise<number>;
  cardFindUnique?: (args: { where: { id: string }; select?: unknown }) => Promise<unknown>;
  cardFindMany?: (args?: { where?: { type?: string } }) => Promise<unknown[]>;
} = {}): FakePrisma {
  const updates: FakePrisma['updates'] = [];
  const activities: FakePrisma['activities'] = [];

  const svc = {
    activity: {
      create: async ({ data }: { data: { cardId: string; text: string } }) => {
        activities.push(data);
        return data;
      },
    },
    iteration: {
      findMany: makemaybe(overrides.iterationFindMany, async () => []),
      count: makemaybe(overrides.iterationCount, async () => 0),
    },
    card: {
      findUnique: makemaybe(
        overrides.cardFindUnique,
        async (_args: unknown) => ({ derivedDepth: 0 }),
      ),
      findMany: makemaybe(overrides.cardFindMany, async () => []),
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return args.data;
      },
      count: async () => 0,
    },
    column: { findFirst: async () => null, findMany: async () => [] },
    label: { findFirst: async () => null },
    board: {
      findUnique: async () => ({ id: 'b1', seq: 1 }),
      update: async () => undefined,
    },
    taskDependency: { create: async () => undefined },
    dodItem: { count: async () => 0 },
    assignee: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(svc),
  } as unknown as PrismaService;

  return { svc: svc as PrismaService, updates, activities };
}

function makeOrchestrator(opts: {
  config?: AppConfig;
  prisma?: FakePrisma;
  sessions?: AgentSessionManager;
  realtime?: { svc: RealtimeService; events: RecordedBroadcast[] };
} = {}) {
  const config = opts.config ?? makeConfig();
  const prisma = opts.prisma ?? makePrisma();
  const sessions = opts.sessions ?? new AgentSessionManager(config);
  const realtime = opts.realtime ?? makeRealtime();
  const orch = new Orchestrator(
    prisma.svc,
    sessions,
    makeValidation(),
    makeWorkspaces(),
    realtime.svc,
    makeRunner(),
    config,
  );
  return { orch, config, prisma, sessions, realtime };
}

// Acesso aos membros privados para teste caixa-branca dos guards.
/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (orch: Orchestrator) => orch as unknown as any;

// ── (b) Cap de iterações ────────────────────────────────────────────────────

test('enforceLoopGuards: cap de iterações atingido -> escala para humano', async () => {
  const iterations = Array.from({ length: 5 }, () => ({
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    summary: 's',
    handoffNextStep: 'n',
  }));
  const prisma = makePrisma({ iterationFindMany: async () => iterations });
  const realtime = makeRealtime();
  const { orch, sessions } = makeOrchestrator({
    config: makeConfig({ maxIterationsPerTask: 5 }),
    prisma,
    realtime,
  });
  sessions.start('story-1');

  const escalated = await priv(orch).enforceLoopGuards('task-1', 'story-1');

  assert.equal(escalated, true, 'deve escalar quando iterations.length >= cap');
  // needsHuman gravado
  const needsHumanUpdate = prisma.updates.find(
    (u) => (u.data as { needsHuman?: boolean }).needsHuman === true,
  );
  assert.ok(needsHumanUpdate, 'deve marcar needsHuman=true');
  // broadcast card.needs_human
  const evt = realtime.events.find((e) => e.type === 'card.needs_human');
  assert.ok(evt, 'deve emitir card.needs_human');
  assert.equal(evt?.taskId, 'task-1');
  assert.match(String((needsHumanUpdate!.data as { needsHumanReason: string }).needsHumanReason), /cap de itera/i);
});

test('enforceLoopGuards: N iterações improdutivas consecutivas (diff vazio) -> escala para humano', async () => {
  const iterations = [
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'a', handoffNextStep: 'n', phase: 'implementation', diff: '' },
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'b', handoffNextStep: 'n', phase: 'implementation', diff: '   ' },
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'c', handoffNextStep: 'n', phase: 'implementation', diff: '' },
  ];
  const prisma = makePrisma({ iterationFindMany: async () => iterations });
  const realtime = makeRealtime();
  const { orch, sessions } = makeOrchestrator({
    config: makeConfig({ maxIterationsPerTask: 0, maxUnproductiveIterations: 3 }),
    prisma,
    realtime,
  });
  sessions.start('story-1');

  const escalated = await priv(orch).enforceLoopGuards('task-1', 'story-1');

  assert.equal(escalated, true, 'deve escalar com 3 iterações improdutivas');
  const needsHumanUpdate = prisma.updates.find(
    (u) => (u.data as { needsHuman?: boolean }).needsHuman === true,
  );
  assert.ok(needsHumanUpdate, 'deve marcar needsHuman=true');
  assert.match(
    String((needsHumanUpdate!.data as { needsHumanReason: string }).needsHumanReason),
    /improdutiv/i,
  );
});

test('enforceLoopGuards: iteração produtiva recente ZERA a contagem de improdutivas', async () => {
  const iterations = [
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'a', handoffNextStep: 'n', phase: 'implementation', diff: '' },
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'b', handoffNextStep: 'n', phase: 'implementation', diff: '' },
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'c', handoffNextStep: 'n', phase: 'implementation', diff: 'diff --git a/x b/x' },
  ];
  const prisma = makePrisma({ iterationFindMany: async () => iterations });
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxIterationsPerTask: 0, maxUnproductiveIterations: 3 }),
    prisma,
    realtime: makeRealtime(),
  });

  const escalated = await priv(orch).enforceLoopGuards('task-1', 'story-1');
  assert.equal(escalated, false, 'não escala: houve trabalho produtivo na última iteração');
  assert.equal(prisma.updates.length, 0);
});

test('enforceLoopGuards: iterações sem diff fora da fase implementation NÃO contam', async () => {
  const iterations = [
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'a', handoffNextStep: 'n', phase: 'analysis', diff: '' },
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'b', handoffNextStep: 'n', phase: 'reproduce', diff: '' },
    { durationMs: 0, inputTokens: 0, outputTokens: 0, summary: 'c', handoffNextStep: 'n', phase: 'validation', diff: '' },
  ];
  const prisma = makePrisma({ iterationFindMany: async () => iterations });
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxIterationsPerTask: 0, maxUnproductiveIterations: 3 }),
    prisma,
    realtime: makeRealtime(),
  });

  const escalated = await priv(orch).enforceLoopGuards('task-1', 'story-1');
  assert.equal(escalated, false, 'fases não-implementation não disparam o cap improdutivo');
});

test('enforceLoopGuards: abaixo do cap -> NÃO escala', async () => {
  const iterations = Array.from({ length: 2 }, () => ({
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    summary: 's',
    handoffNextStep: 'n',
  }));
  const prisma = makePrisma({ iterationFindMany: async () => iterations });
  const realtime = makeRealtime();
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxIterationsPerTask: 5 }),
    prisma,
    realtime,
  });

  const escalated = await priv(orch).enforceLoopGuards('task-1', 'story-1');

  assert.equal(escalated, false);
  assert.equal(prisma.updates.length, 0, 'não deve marcar needsHuman');
  assert.equal(realtime.events.length, 0, 'não deve emitir eventos');
});

test('enforceLoopGuards: cap desligado (0) + sem outras guardas -> curto-circuito, não consulta iterações', async () => {
  let queried = false;
  const prisma = makePrisma({
    iterationFindMany: async () => {
      queried = true;
      return [];
    },
  });
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxIterationsPerTask: 0, maxTaskDurationMs: 0, maxTaskTokens: 0, thrashDetectionEnabled: false }),
    prisma,
  });

  const escalated = await priv(orch).enforceLoopGuards('task-1', 'story-1');

  assert.equal(escalated, false);
  assert.equal(queried, false, 'com todas as guardas desligadas nem deve buscar iterações');
});

test('enforceLoopGuards: cost gate por duração excede orçamento -> escala', async () => {
  const iterations = [{ durationMs: 60_000, inputTokens: 0, outputTokens: 0, summary: 'a', handoffNextStep: 'b' }];
  const prisma = makePrisma({ iterationFindMany: async () => iterations });
  const realtime = makeRealtime();
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxIterationsPerTask: 0, maxTaskDurationMs: 50_000 }),
    prisma,
    realtime,
  });

  const escalated = await priv(orch).enforceLoopGuards('task-1', 'story-1');

  assert.equal(escalated, true);
  const evt = realtime.events.find((e) => e.type === 'card.needs_human');
  assert.match(String(evt?.reason), /or.amento de tempo/i);
});

// ── (c) Cap de profundidade de derivação vs derivar ─────────────────────────

test('decideValidationFailureAction: derivedDepth >= cap -> escala (depth)', () => {
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxDerivedDepth: 3, maxValidationFailures: 3 }),
  });
  // depth no cap; validationFailures baixo — deve escalar POR PROFUNDIDADE.
  const decision = priv(orch).decideValidationFailureAction(3, 1);
  assert.equal(decision.action, 'escalate');
  assert.equal(decision.reasonKind, 'depth');
  assert.match(String(decision.reason), /profundidade de deriva/i);
});

test('decideValidationFailureAction: abaixo dos caps -> deriva', () => {
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxDerivedDepth: 3, maxValidationFailures: 3 }),
  });
  const decision = priv(orch).decideValidationFailureAction(1, 1);
  assert.equal(decision.action, 'derive');
});

test('decideValidationFailureAction: falhas de validação no limite -> escala (failures)', () => {
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxDerivedDepth: 3, maxValidationFailures: 3 }),
  });
  // depth abaixo do cap, mas falhas de validação atingem o limite.
  const decision = priv(orch).decideValidationFailureAction(0, 3);
  assert.equal(decision.action, 'escalate');
  assert.equal(decision.reasonKind, 'failures');
});

test('decideValidationFailureAction: cap de profundidade tem precedência sobre falhas', () => {
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxDerivedDepth: 3, maxValidationFailures: 3 }),
  });
  // ambos os caps atingidos — profundidade vence.
  const decision = priv(orch).decideValidationFailureAction(3, 3);
  assert.equal(decision.action, 'escalate');
  assert.equal(decision.reasonKind, 'depth');
});

test('decideValidationFailureAction: maxDerivedDepth=0 desliga o cap de profundidade', () => {
  const { orch } = makeOrchestrator({
    config: makeConfig({ maxDerivedDepth: 0, maxValidationFailures: 3 }),
  });
  // profundidade altíssima, mas cap desligado e poucas falhas -> deriva.
  const decision = priv(orch).decideValidationFailureAction(99, 1);
  assert.equal(decision.action, 'derive');
});

test('escalateToHuman: marca needsHuman, para graceful e emite card.needs_human', async () => {
  const prisma = makePrisma();
  const realtime = makeRealtime();
  const { orch, sessions } = makeOrchestrator({ prisma, realtime });
  sessions.start('story-x');

  await priv(orch).escalateToHuman('task-x', 'story-x', 'motivo teste', 'log da escalada');

  // needsHuman + reason gravados
  const upd = prisma.updates.find((u) => (u.data as { needsHuman?: boolean }).needsHuman === true);
  assert.ok(upd);
  assert.equal((upd!.data as { needsHumanReason: string }).needsHumanReason, 'motivo teste');
  // broadcast
  const evt = realtime.events.find((e) => e.type === 'card.needs_human');
  assert.ok(evt);
  assert.equal(evt?.taskId, 'task-x');
  assert.equal(evt?.storyId, 'story-x');
  // stop graceful: NÃO removeu a sessão (hard removeria) e NÃO abortou
  assert.ok(sessions.get('story-x'), 'graceful mantém a sessão viva');
  assert.notEqual(sessions.get('story-x')?.state, 'dead', 'graceful não aborta a sessão');
  // atividade logada
  assert.ok(prisma.activities.some((a) => a.text === 'log da escalada'));
});

// ── createDerivedTask: encadeamento de iterações (dependência reversa) ────────

test('createDerivedTask: cria derivada com derivedDepth+1 e dependência reversa', async () => {
  const created: Array<Record<string, unknown>> = [];
  const deps: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const realtime = makeRealtime();

  const tx = {
    board: {
      findUnique: async () => ({ id: 'b1', seq: 7 }),
      update: async () => undefined,
    },
    column: { findFirst: async () => ({ id: 'col-task' }) },
    label: { findFirst: async () => null },
    card: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'derived-1' };
      },
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return undefined;
      },
    },
    taskDependency: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        deps.push(data);
        return undefined;
      },
    },
  };

  const prismaSvc = {
    activity: { create: async () => undefined },
    card: {
      findUnique: async () => ({
        id: 'origin-1',
        boardId: 'b1',
        parentId: 'story-1',
        key: 'TK-1',
        derivedDepth: 1,
        assignees: [{ assigneeId: 'ag-1' }],
      }),
    },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;

  const orch = new Orchestrator(
    prismaSvc,
    new AgentSessionManager(makeConfig()),
    makeValidation(),
    makeWorkspaces(),
    realtime.svc,
    makeRunner(),
    makeConfig(),
  );

  const derivedId = await orch.createDerivedTask('origin-1', {
    title: 'parser quebrado',
    description: 'falha ao parsear',
  });

  assert.equal(derivedId, 'derived-1');
  // derivedDepth incrementado (origem 1 -> derivada 2)
  assert.equal(created[0].derivedDepth, 2);
  assert.equal(created[0].derivedFromId, 'origin-1');
  // dependência reversa: origem depende da derivada
  assert.equal(deps[0].dependentId, 'origin-1');
  assert.equal(deps[0].dependsOnId, 'derived-1');
  // origem vai para blocked_dep
  assert.ok(updates.some((u) => (u.data as { execState?: string }).execState === 'blocked_dep'));
  // eventos WS
  assert.ok(realtime.events.some((e) => e.type === 'task.derived'));
  assert.ok(realtime.events.some((e) => e.type === 'task.state.changed'));
});

// ── Idempotência do watchdog ─────────────────────────────────────────────────

test('watchdog: startWatchdog é idempotente (não registra dois intervals)', async () => {
  const { orch } = makeOrchestrator();
  const watchdogs: Map<string, unknown> = priv(orch).watchdogs;

  priv(orch).startWatchdog('story-1');
  const handle1 = watchdogs.get('story-1');
  priv(orch).startWatchdog('story-1');
  const handle2 = watchdogs.get('story-1');

  assert.equal(watchdogs.size, 1, 'deve haver apenas 1 watchdog');
  assert.strictEqual(handle1, handle2, 'o handle não deve ser recriado');

  // limpeza (evita timer pendurado)
  priv(orch).clearWatchdog('story-1');
  assert.equal(watchdogs.size, 0);
});

// ── stop graceful vs hard ─────────────────────────────────────────────────────

test('stop graceful: não aborta a sessão nem limpa o watchdog', async () => {
  const { orch, sessions } = makeOrchestrator();
  const session = sessions.start('story-1');
  priv(orch).startWatchdog('story-1');
  const abortController = (session as unknown as { abort: AbortController }).abort;

  await orch.stop('story-1', 'graceful');

  assert.equal(abortController.signal.aborted, false, 'graceful NÃO aborta');
  assert.ok(sessions.get('story-1'), 'graceful mantém a sessão');
  assert.equal(priv(orch).watchdogs.has('story-1'), true, 'graceful mantém o watchdog');
  assert.equal(priv(orch).stopRequested.get('story-1'), 'graceful');

  priv(orch).clearWatchdog('story-1');
});

test('stop hard: aborta a sessão (AbortController), remove sessão e limpa watchdog', async () => {
  const { orch, sessions } = makeOrchestrator();
  const session = sessions.start('story-1');
  priv(orch).startWatchdog('story-1');
  const abortController = (session as unknown as { abort: AbortController }).abort;

  await orch.stop('story-1', 'hard');

  assert.equal(abortController.signal.aborted, true, 'hard aborta o AbortController da sessão');
  assert.equal(sessions.get('story-1'), undefined, 'hard remove a sessão');
  assert.equal(priv(orch).watchdogs.has('story-1'), false, 'hard limpa o watchdog');
});

// ── reconcileOnBoot ───────────────────────────────────────────────────────────

test('reconcileOnBoot: sem stories ativas -> no-op (nenhuma sessão criada)', async () => {
  const prisma = makePrisma({ cardFindMany: async () => [] });
  const { orch, sessions } = makeOrchestrator({ prisma });

  await orch.reconcileOnBoot();

  assert.equal((sessions as unknown as { activeCount: number }).activeCount, 0);
});

test('reconcileOnBoot: story ativa -> retoma o loop (cria sessão e watchdog)', async () => {
  const prisma = makePrisma({
    cardFindMany: async (args) => (args?.where?.type === 'story' ? [{ id: 'story-boot' }] : []),
  });
  const realtime = makeRealtime();
  const { orch, sessions } = makeOrchestrator({ prisma, realtime });

  await orch.reconcileOnBoot();

  assert.ok(sessions.get('story-boot'), 'deve recriar a sessão da story ativa');
  assert.ok(
    realtime.events.some((e) => e.type === 'agent.session.state_changed'),
    'deve emitir estado da sessão retomada',
  );

  // Encerra qualquer timer de auto-play/watchdog para não vazar entre testes.
  await orch.stop('story-boot', 'hard');
});

// ── (i) Isolamento do worktree no prompt (bug-hallucinated-loop) ────────────
// O prompt injetado no agent NUNCA pode expor o path absoluto do repo-alvo
// original — se expuser, o agent faz `cd` para lá e escreve FORA do worktree,
// deixando o `git diff` do worktree vazio e impedindo o loop de convergir.
// Estes testes fixam o contrato do `buildPrompt`.

function makePromptContext(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'TK-1',
    storyId: 'US-1',
    taskTitle: 'Criar arquivo ping.js',
    project: '/home/user/repo-alvo-original',
    notes: '',
    epicNotes: '',
    files: [],
    affectedFlows: [],
    dodItems: [{ id: 'd1', text: 'ping.js existe', done: false }],
    iterationHistory: [],
    siblingHandoffs: [],
    lastDiff: '',
    ...overrides,
  };
}

test('buildPrompt: usa o worktree (cwd) e NÃO expõe o path do repo-alvo original', () => {
  const { orch } = makeOrchestrator();
  const worktree = '/home/user/repo-alvo-original/apps/api/.agent-workspaces/US-1';
  const prompt: string = priv(orch).buildPrompt(
    'implementation',
    BUILTIN_LOOP_PROFILES.feature,
    makePromptContext(),
    '',
    worktree,
  );

  // O worktree (cwd) deve aparecer como diretório de trabalho.
  assert.ok(prompt.includes(worktree), 'o prompt deve referir o worktree/cwd');
  // O path do repo-alvo original NÃO pode aparecer isolado (só como prefixo do
  // worktree, o que é aceitável). Verificamos que não há menção ao projeto puro
  // seguida de fim de linha/espaço — heurística: a string do projeto sozinha
  // como "Projeto-alvo (repo): <path>" foi removida.
  assert.ok(
    !prompt.includes('Projeto-alvo (repo): /home/user/repo-alvo-original'),
    'o prompt não pode mais expor "Projeto-alvo (repo): <path original>"',
  );
});

test('buildPrompt: proíbe explicitamente `cd` para outro caminho absoluto', () => {
  const { orch } = makeOrchestrator();
  const worktree = '/tmp/wt/US-2';
  const prompt: string = priv(orch).buildPrompt(
    'implementation',
    BUILTIN_LOOP_PROFILES.feature,
    makePromptContext(),
    '',
    worktree,
  );
  assert.match(
    prompt,
    /NÃO.*rode `cd`|não use `cd`|não rode `cd`/i,
    'o prompt deve proibir `cd` para outro caminho',
  );
});

test('buildPrompt: sem worktree, instrui a trabalhar só no cwd atual', () => {
  const { orch } = makeOrchestrator();
  const prompt: string = priv(orch).buildPrompt(
    'implementation',
    BUILTIN_LOOP_PROFILES.feature,
    makePromptContext(),
    '',
    '',
  );
  assert.match(prompt, /diretório atual|`cwd`/i, 'sem worktree deve ancorar no cwd atual');
  assert.ok(
    !prompt.includes('/home/user/repo-alvo-original'),
    'sem worktree também não pode vazar o path do repo-alvo',
  );
});
