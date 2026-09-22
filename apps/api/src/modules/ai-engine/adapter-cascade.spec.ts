import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentAdapterKind } from '@kanban-ai/shared';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner, AgentRunInput, AgentRunResult } from './runners/agent-runner.interface';
import type { AgentAdapterRegistry } from './runners/agent-adapter.registry';
import { AgentSessionManager } from './session-manager/agent-session-manager';
import { Orchestrator } from './orchestrator';
import { resolveDispatchAdapter } from './recovery-lane';

/**
 * US-F3.10 — Cascata de adapter (board→epic→story→task).
 *
 * Cobre, sem banco e sem rede:
 *  1. a matriz de herança de `resolveCardAdapter` (card > story > epic >
 *     board.defaultAdapter > global), espelho de `resolveCardModel`;
 *  2. valores desconhecidos no banco IGNORADOS (cascata continua) e guard de
 *     ciclo na hierarquia;
 *  3. runner POR CARD: duas tasks da MESMA story com adapters diferentes rodam
 *     em runners DIFERENTES via registry — e o token AGENT_RUNNER segue como
 *     fallback quando o registry não está injetado (specs posicionais);
 *  4. recovery lane × cascata: a lane VENCE — adapter GLOBAL + modelo barato
 *     (o caminho de recuperação nunca fica mais caro que o pré-F3.10).
 */

// ── Fakes mínimos (mesma estratégia do orchestrator-guards.spec) ────────────

interface FakeCard {
  adapter?: string | null;
  model?: string | null;
  parentId?: string | null;
}

function makeConfig(agentAdapter: AgentAdapterKind = 'copilot-cli'): AppConfig {
  return {
    agentAdapter,
    agent: {
      wakeupQueueEnabled: false,
      defaultModel: 'opus',
      cheapModelId: 'cheap-model',
      maxConcurrentSessions: 3,
      watchdogIntervalMs: 120_000,
      hitlTimeoutMs: 1000,
    },
  } as unknown as AppConfig;
}

/** Prisma fake: hierarquia de cards por id + board com defaultAdapter. */
function makePrisma(
  cards: Record<string, FakeCard>,
  board: { defaultAdapter?: string | null; defaultModel?: string | null } = {},
): PrismaService {
  return {
    card: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const card = cards[where.id];
        if (!card) return null;
        return {
          title: where.id,
          loopType: null,
          adapter: card.adapter ?? null,
          model: card.model ?? null,
          parentId: card.parentId ?? null,
          boardId: 'b1',
          assignees: [],
          derivedDepth: 0,
        };
      },
    },
    board: {
      findUnique: async () => ({
        defaultAdapter: board.defaultAdapter ?? null,
        defaultModel: board.defaultModel ?? null,
      }),
    },
    agentRuntimeState: { upsert: async () => undefined },
    agentMessage: { create: async () => undefined },
    activity: { create: async () => undefined },
  } as unknown as PrismaService;
}

function makeOrchestrator(opts: {
  config?: AppConfig;
  prisma?: PrismaService;
  runner?: AgentRunner;
  registry?: AgentAdapterRegistry;
}): Orchestrator {
  const config = opts.config ?? makeConfig();
  const prisma = opts.prisma ?? makePrisma({});
  const sessions = new AgentSessionManager(config, prisma);
  return new Orchestrator(
    prisma,
    sessions,
    { validate: async () => ({ passed: true, problems: [] }) } as unknown as ValidationRunner,
    { resolveWorkdir: async () => '/repo' } as unknown as WorkspaceService,
    { broadcast() {} } as unknown as RealtimeService,
    opts.runner ??
      ({ id: 'boot', run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner),
    config,
    undefined, // wakeupQueue
    undefined, // projectWorkspace
    undefined, // reviewActions
    undefined, // projectGraph
    opts.registry, // US-F3.10 — registry por card (último parâmetro, @Optional)
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (orch: Orchestrator) => orch as unknown as any;

const resolveAdapter = (
  orch: Orchestrator,
  own: string | null,
  parentId: string | null,
  boardId: string | null = 'b1',
): Promise<AgentAdapterKind> => priv(orch).resolveCardAdapter(own, parentId, boardId);

// ── 1/2. Matriz de herança ──────────────────────────────────────────────────

/** Hierarquia padrão: task t1 → story s1 → epic e1 (adapters por teste). */
const HIER = (over: Record<string, FakeCard>): Record<string, FakeCard> => ({
  e1: { parentId: null },
  s1: { parentId: 'e1' },
  t1: { parentId: 's1' },
  ...over,
});

test('US-F3.10 matriz: adapter do PRÓPRIO card vence tudo', async () => {
  const orch = makeOrchestrator({
    prisma: makePrisma(
      HIER({ s1: { parentId: 'e1', adapter: 'codex' }, e1: { adapter: 'claude' } }),
      { defaultAdapter: 'tanstack' },
    ),
  });
  assert.equal(await resolveAdapter(orch, 'gemini', 's1'), 'gemini');
});

test('US-F3.10 matriz: task herda da STORY antes de epic/board/global', async () => {
  const orch = makeOrchestrator({
    prisma: makePrisma(
      HIER({ s1: { parentId: 'e1', adapter: 'codex' }, e1: { adapter: 'claude' } }),
      { defaultAdapter: 'tanstack' },
    ),
  });
  assert.equal(await resolveAdapter(orch, null, 's1'), 'codex');
});

test('US-F3.10 matriz: sem story, herda do EPIC', async () => {
  const orch = makeOrchestrator({
    prisma: makePrisma(HIER({ e1: { adapter: 'claude' } }), { defaultAdapter: 'tanstack' }),
  });
  assert.equal(await resolveAdapter(orch, null, 's1'), 'claude');
});

test('US-F3.10 matriz: sem hierarquia, cai no board.defaultAdapter', async () => {
  const orch = makeOrchestrator({
    prisma: makePrisma(HIER({}), { defaultAdapter: 'tanstack' }),
  });
  assert.equal(await resolveAdapter(orch, null, 's1'), 'tanstack');
});

test('US-F3.10 matriz: sem board.defaultAdapter, cai no GLOBAL (config.agentAdapter)', async () => {
  const orch = makeOrchestrator({
    prisma: makePrisma(HIER({})),
    config: makeConfig('copilot-cli'),
  });
  assert.equal(await resolveAdapter(orch, null, 's1'), 'copilot-cli');
});

test('US-F3.10 matriz: global reflete o default do processo (mock) quando é o efetivo', async () => {
  const orch = makeOrchestrator({
    prisma: makePrisma(HIER({})),
    config: makeConfig('mock'),
  });
  assert.equal(await resolveAdapter(orch, null, 's1', null), 'mock');
});

test('US-F3.10: valor DESCONHECIDO no banco é ignorado e a cascata continua', async () => {
  const orch = makeOrchestrator({
    prisma: makePrisma(
      HIER({ s1: { parentId: 'e1', adapter: 'vendor-que-nao-existe' }, e1: { adapter: 'claude' } }),
    ),
  });
  // 'vendor-que-nao-existe' (own e story) não corrompe a resolução: epic vence.
  assert.equal(await resolveAdapter(orch, 'outro-invalido', 's1'), 'claude');
});

test('US-F3.10: ciclo na hierarquia não trava a resolução (guard de seen)', async () => {
  const orch = makeOrchestrator({
    prisma: makePrisma({ a: { parentId: 'b' }, b: { parentId: 'a' } }),
    config: makeConfig('copilot-cli'),
  });
  assert.equal(await resolveAdapter(orch, null, 'a'), 'copilot-cli');
});

// ── 4. Recovery lane × cascata ──────────────────────────────────────────────

test('US-F3.10: resolveDispatchAdapter — trabalho normal usa a cascata; recovery VENCE com o global', () => {
  assert.equal(resolveDispatchAdapter('claude', 'copilot-cli', false), 'claude');
  assert.equal(resolveDispatchAdapter('claude', 'copilot-cli', true), 'copilot-cli');
  // Simetria com resolveDispatchModel: recovery = status-only barato, sempre no
  // namespace do adapter global (cheapModelId é id de lá).
});

// ── 3. Runner por card, na MESMA story ──────────────────────────────────────

interface RecordingRunner extends AgentRunner {
  calls: AgentRunInput[];
}

/** Runner fake que registra o run e retorna fatalError (encerra a iteração cedo). */
function recordingRunner(id: string): RecordingRunner {
  const calls: AgentRunInput[] = [];
  return {
    id,
    calls,
    run: async (input: AgentRunInput): Promise<AgentRunResult> => {
      calls.push(input);
      return {
        detail: '',
        summary: 'fatal de teste',
        dodTouched: [],
        nextStep: '',
        done: false,
        fatalError: 'teste: encerra a iteração aqui',
      } as AgentRunResult;
    },
  } as unknown as RecordingRunner;
}

/**
 * Harness de runIteration: duas tasks da MESMA story (s1), uma com adapter
 * 'mock' e outra com 'claude'. Os runners fake retornam fatalError para a
 * iteração encerrar logo após o run — o que importa aqui é QUEM rodou.
 */
async function runWithRegistry(recovery: boolean): Promise<{
  runners: Record<string, RecordingRunner>;
  boot: RecordingRunner;
  resolved: string[];
}> {
  const runners: Record<string, RecordingRunner> = {
    mock: recordingRunner('mock'),
    claude: recordingRunner('claude'),
    'copilot-cli': recordingRunner('copilot-cli'),
  };
  const resolved: string[] = [];
  const registry = {
    resolve: (kind: AgentAdapterKind) => {
      resolved.push(kind);
      return runners[kind];
    },
  } as unknown as AgentAdapterRegistry;
  const boot = recordingRunner('boot');

  const cards: Record<string, FakeCard & { title?: string }> = {
    e1: { parentId: null },
    s1: { parentId: 'e1' },
    'task-barata': { parentId: 's1', adapter: 'mock' },
    'task-cara': { parentId: 's1', adapter: 'claude' },
  };
  const prisma = {
    card: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const card = cards[where.id];
        if (!card) return null;
        return {
          title: where.id,
          loopType: null,
          model: null,
          adapter: card.adapter ?? null,
          parentId: card.parentId ?? null,
          boardId: 'b1',
          assignees: [],
          derivedDepth: 0,
        };
      },
    },
    board: { findUnique: async () => ({ defaultAdapter: null, defaultModel: null }) },
    agentRuntimeState: { upsert: async () => undefined },
    agentMessage: { create: async () => undefined },
    activity: { create: async () => undefined },
    dodItem: { count: async () => 0 },
    assignee: { findUnique: async () => null },
    iteration: { findMany: async () => [], count: async () => 0 },
  } as unknown as PrismaService;

  const orch = makeOrchestrator({ prisma, runner: boot, registry, config: makeConfig('copilot-cli') });
  const p = priv(orch);
  const loadedTask = (id: string) => ({
    id,
    execState: 'analyzing',
    phases: ['implementation', 'validation'],
    derivedDepth: 0,
    dependsOn: [],
    dodDone: [],
    type: 'task',
  });
  p.loadSiblingsById = async () => new Map();
  p.buildContext = async () => ({
    taskTitle: 't',
    project: '/repo',
    notes: '',
    flowNames: [],
    files: [],
    storyId: 's1',
    affectedFlows: [],
    dodItems: [{ id: 'd1', text: 'x', done: false }],
    iterationHistory: [],
    siblingHandoffs: [],
  });
  p.enforceLoopGuards = async () => false;
  p.resolveCardModel = async () => 'modelo-normal';
  p.resolveStoryTargetRepo = async () => '/repo/target';
  p.captureTreeBaseline = async () => null;
  p.captureDiff = async () => '';
  p.buildPrompt = () => 'prompt';
  p.escalateToHuman = async () => undefined;
  p.appendIteration = async () => undefined;
  p.log = async () => undefined;
  p.renewClaim = async () => undefined;
  p.touchHeartbeat = () => undefined;

  for (const taskId of ['task-barata', 'task-cara']) {
    p.loadTask = async () => loadedTask(taskId);
    await orch.runIteration(taskId, { recovery });
  }
  return { runners, boot, resolved };
}

test('US-F3.10: tasks da MESMA story com adapters diferentes rodam em runners DIFERENTES', async () => {
  const { runners, boot, resolved } = await runWithRegistry(false);
  assert.equal(runners.mock.calls.length, 1, 'task-barata deve rodar no runner mock');
  assert.equal(runners.claude.calls.length, 1, 'task-cara deve rodar no runner claude');
  assert.equal(boot.calls.length, 0, 'o runner do boot (token) NÃO deve rodar com registry presente');
  assert.deepEqual(resolved, ['mock', 'claude'], 'registry consultado por card, na ordem');
  // Modelo normal preservado no trabalho normal (a cascata de model é ortogonal).
  assert.equal(runners.mock.calls[0].model, 'modelo-normal');
  assert.equal(runners.claude.calls[0].model, 'modelo-normal');
});

test('US-F3.10: em RECOVERY a lane vence — adapter GLOBAL + modelo BARATO para ambas as tasks', async () => {
  const { runners, resolved } = await runWithRegistry(true);
  assert.equal(runners['copilot-cli'].calls.length, 2, 'ambas rodam no adapter global');
  assert.equal(runners.mock.calls.length, 0);
  assert.equal(runners.claude.calls.length, 0);
  assert.deepEqual(resolved, ['copilot-cli', 'copilot-cli']);
  for (const call of runners['copilot-cli'].calls) {
    assert.equal(call.model, 'cheap-model', 'recovery usa o AGENT_CHEAP_MODEL_ID');
  }
});

test('US-F3.10: SEM registry (specs posicionais), o runner do token AGENT_RUNNER segue valendo', async () => {
  const boot = recordingRunner('boot');
  const prisma = makePrisma({ t1: { parentId: null, adapter: 'claude' } });
  const orch = makeOrchestrator({ prisma, runner: boot, config: makeConfig('copilot-cli') });
  const p = priv(orch);
  p.loadTask = async () => ({
    id: 't1',
    execState: 'analyzing',
    phases: ['implementation', 'validation'],
    derivedDepth: 0,
    dependsOn: [],
    dodDone: [],
    type: 'task',
  });
  p.loadSiblingsById = async () => new Map();
  p.buildContext = async () => ({
    taskTitle: 't',
    project: '/repo',
    notes: '',
    flowNames: [],
    files: [],
    storyId: 's1',
    affectedFlows: [],
    dodItems: [],
    iterationHistory: [],
    siblingHandoffs: [],
  });
  p.enforceLoopGuards = async () => false;
  p.resolveCardModel = async () => 'modelo-normal';
  p.resolveStoryTargetRepo = async () => '/repo/target';
  p.captureTreeBaseline = async () => null;
  p.captureDiff = async () => '';
  p.buildPrompt = () => 'prompt';
  p.escalateToHuman = async () => undefined;
  p.appendIteration = async () => undefined;
  p.log = async () => undefined;
  p.renewClaim = async () => undefined;
  p.touchHeartbeat = () => undefined;

  await orch.runIteration('t1');
  assert.equal(boot.calls.length, 1, 'fallback: sem registry, roda o runner do token');
});
