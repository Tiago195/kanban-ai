import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../shared/config/config';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { WorkspaceService } from './workspaces/workspace.service';
import type { ValidationRunner } from './validators/validation.runner';
import type { AgentRunner } from './runners/agent-runner.interface';
import type { AgentSessionManager } from './session-manager/agent-session-manager';
import type { MemoryIndexService } from '../memory/memory-index.service';
import type { MemoryGitService } from '../memory/memory-git.service';
import type { MemoryBootstrapService } from '../memory/memory-bootstrap.service';
import { Orchestrator } from './orchestrator';
import {
  BUILTIN_LOOP_PROFILES,
  resolveLoopProfile,
  type LoopProfileDef,
} from './loop-profiles/loop-profiles';

/**
 * US-COLAB2 / ADR-0031 — loop profile "orquestrador" (board-manager).
 *
 * Cobre:
 *  - `resolveLoopProfile('orchestrator')` retorna o perfil novo, com toolset
 *    `board-only` e sem a fase de implementação de código.
 *  - `buildPrompt` para o profile board-only injeta o mandato de board manager
 *    (restrição/delegação) e NÃO injeta as instruções de "editar arquivos".
 *  - `buildPrompt` para um profile codador (feature) permanece INALTERADO
 *    (regressão): contém a seção de escopo/editar arquivos e NÃO contém a
 *    restrição do orquestrador.
 */

// ── Fakes mínimos para instanciar o Orchestrator (buildPrompt é determinístico
//    e não toca nenhuma dependência) ─────────────────────────────────────────

function makeOrchestrator(): Orchestrator {
  const noop = () => undefined;
  return new Orchestrator(
    {} as unknown as PrismaService,
    {} as unknown as AgentSessionManager,
    {} as unknown as ValidationRunner,
    {} as unknown as WorkspaceService,
    { broadcast: noop } as unknown as RealtimeService,
    { id: 'mock', run: async () => ({ detail: '', summary: '', dodTouched: [] }) } as unknown as AgentRunner,
    { agent: { wakeupQueueEnabled: false } } as unknown as AppConfig,
    {} as unknown as MemoryIndexService,
    {} as unknown as MemoryGitService,
    {} as unknown as MemoryBootstrapService,
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const priv = (orch: Orchestrator) => orch as unknown as any;

/** Contexto mínimo aceito por buildPrompt (o resto é opcional). */
function makeContext(): any {
  return {
    taskTitle: 'Organizar o backlog',
    notes: '',
    taskDescription: '',
    epicContext: null,
    storyContext: null,
    dodItems: [],
    affectedFlows: [],
    iterationHistory: [],
    memoryNeurons: [],
    siblingHandoffs: [],
    epicNotes: '',
    lastDiff: '',
  };
}

function buildPrompt(orch: Orchestrator, phase: string, profile: LoopProfileDef): string {
  return priv(orch).buildPrompt(phase, profile, makeContext(), '', '/repo/target');
}

// ── resolveLoopProfile ──────────────────────────────────────────────────────

test('resolveLoopProfile("orchestrator") retorna o perfil board-manager', () => {
  const profile = resolveLoopProfile('orchestrator');
  assert.equal(profile.id, 'orchestrator');
  assert.equal(profile.builtin, true);
  assert.equal(profile.toolset, 'board-only');
  // Sem fase de implementação de CÓDIGO; última fase é validation.
  assert.ok(!profile.phases.includes('implementation'));
  assert.equal(profile.phases[profile.phases.length - 1], 'validation');
  assert.equal(profile.validation, 'regression-only');
});

test('BUILTIN_LOOP_PROFILES contém orchestrator e mantém os perfis codadores', () => {
  assert.ok(BUILTIN_LOOP_PROFILES.orchestrator);
  // Retrocompat: os perfis existentes continuam full (toolset ausente).
  for (const id of ['feature', 'bug', 'refactor', '__default']) {
    assert.equal(BUILTIN_LOOP_PROFILES[id].toolset, undefined);
  }
});

// ── buildPrompt: profile board-only (orquestrador) ───────────────────────────

test('buildPrompt(orchestrator) contém a restrição/delegação e NÃO instrui a codar', () => {
  const orch = makeOrchestrator();
  const prompt = buildPrompt(orch, 'analysis', resolveLoopProfile('orchestrator'));

  // Contém o mandato de board manager (restrição + delegação).
  assert.match(prompt, /ORQUESTRADOR do board/);
  assert.match(prompt, /NÃO PODE editar, criar ou apagar NENHUM arquivo/);
  assert.match(prompt, /CRIE uma task/);
  assert.match(prompt, /criar\/atribuir\/linkar|atribuir assignee|linkar dependência/);

  // NÃO contém as instruções de codar / editar os arquivos reais.
  assert.doesNotMatch(prompt, /editando os arquivos reais do projeto/);
  assert.doesNotMatch(prompt, /## Escopo e diretório de trabalho/);
  // A seção de proibição de git (que assume "edite os arquivos") também some.
  assert.doesNotMatch(prompt, /PROIBIDO — operações de git/);
});

// ── buildPrompt: profiles codadores permanecem inalterados (regressão) ───────

test('buildPrompt(feature) mantém o escopo de codar e NÃO vira board-manager', () => {
  const orch = makeOrchestrator();
  const prompt = buildPrompt(orch, 'implementation', resolveLoopProfile('feature'));

  assert.match(prompt, /## Escopo e diretório de trabalho/);
  assert.match(prompt, /editando os arquivos reais do projeto/);
  assert.match(prompt, /PROIBIDO — operações de git/);

  // NÃO deve conter o mandato do orquestrador.
  assert.doesNotMatch(prompt, /ORQUESTRADOR do board/);
  assert.doesNotMatch(prompt, /NÃO PODE editar, criar ou apagar NENHUM arquivo/);
});

test('buildPrompt(bug) e buildPrompt(refactor) permanecem codadores', () => {
  const orch = makeOrchestrator();
  for (const id of ['bug', 'refactor']) {
    const prompt = buildPrompt(orch, 'analysis', resolveLoopProfile(id));
    assert.match(prompt, /## Escopo e diretório de trabalho/, `${id} deve manter escopo de código`);
    assert.doesNotMatch(prompt, /ORQUESTRADOR do board/, `${id} não deve virar board-manager`);
  }
});
