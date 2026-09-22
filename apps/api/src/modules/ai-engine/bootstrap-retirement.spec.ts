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

/**
 * US-F2.9 (EP-F2) — aposentadoria da semeadura de neurônios no arranque.
 *
 * Com o recall por grafo (cutover US-F2.10), o grafo do código já dá o mapa do
 * repo ao agent; o neurônio nasce LAZY na primeira escrita real de learning
 * (memory doc canônico da US-F5.1 — coberto por neuron-format.spec.ts e
 * learning-write.spec.ts). Aqui provamos o lado do orchestrator:
 * `bootstrapAndStartAuto` NÃO semeia nada (desde a US-F2.3 é estrutural: o
 * módulo memory/ foi deletado), mas PRESERVA a resolução do repo-alvo
 * (`resolveStoryTargetRepo` → `ensureCloned`), que é o motivo original da
 * cauda rodar em background (fix boot-hang).
 */

function makeConfig(): AppConfig {
  return {
    agent: {
      maxConcurrentSessions: 3,
      watchdogIntervalMs: 120_000,
      claimEnabled: false,
    },
  } as unknown as AppConfig;
}

function makeOrchestrator(): Orchestrator {
  const noop = () => undefined;
  const config = makeConfig();
  const prisma = {
    agentRuntimeState: { upsert: async () => undefined },
    card: { findUnique: async () => null, findMany: async () => [] },
    column: { findMany: async () => [] },
  } as unknown as PrismaService;
  const realtime = { broadcast: noop } as unknown as RealtimeService;
  const workspaces = {
    cleanupWorktree: async () => undefined,
    resolveWorkdir: async () => '/repo',
  } as unknown as WorkspaceService;
  const validation = {
    validate: async () => ({ passed: true, problems: [] }),
  } as unknown as ValidationRunner;
  const runner = {
    run: async () => ({ detail: '', summary: '', dodTouched: [] }),
  } as unknown as AgentRunner;
  return new Orchestrator(
    prisma,
    new AgentSessionManager(config, prisma),
    validation,
    workspaces,
    realtime,
    runner,
    config,
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (orch: Orchestrator) => orch as unknown as any;

test('US-F2.9: bootstrapAndStartAuto NÃO semeia neurônios; o clone (resolveStoryTargetRepo) continua garantido', async () => {
  const orch = makeOrchestrator();

  let resolved = 0;
  let started = 0;
  priv(orch).resolveStoryTargetRepo = async () => {
    resolved++;
    return '/tmp/repo-alvo';
  };
  priv(orch).startAuto = () => {
    started++;
  };
  // Simula a sessão viva (criada de forma síncrona por onStoryEnterInProgress).
  priv(orch).sessions = { get: () => ({ storyId: 'US-X' }) };

  // US-F2.3 — a aposentadoria virou ESTRUTURAL: o construtor do Orchestrator
  // nem aceita mais os serviços de memória (o módulo memory/ foi deletado).
  // O que resta a provar é o fluxo clone→startAuto intacto sem semeadura.
  await priv(orch).bootstrapAndStartAuto('US-X');

  assert.equal(resolved, 1, 'resolveStoryTargetRepo (ensureCloned) preservado');
  assert.equal(started, 1, 'startAuto arranca após o clone');
});

test('US-F2.9: falha na resolução do repo-alvo é engolida (warn) e o guard de sessão ausente segue valendo', async () => {
  const orch = makeOrchestrator();
  priv(orch).resolveStoryTargetRepo = async () => {
    throw new Error('clone indisponível');
  };
  let started = 0;
  priv(orch).startAuto = () => {
    started++;
  };
  // Sessão sumiu durante a cauda em background (stop/leave) → não ressuscita.
  await priv(orch).bootstrapAndStartAuto('US-Y');
  assert.equal(started, 0, 'sem sessão viva, auto-play não inicia');
});
