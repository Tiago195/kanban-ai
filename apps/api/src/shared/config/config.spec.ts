import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadConfig,
  resetLegacyAgentRunnerKindWarningForTests,
  resolveAgentAdapter,
  warnLegacyAgentRunnerKindOnce,
} from './config';

// --- config-boot: guard-rail anti-alucinação do arquivo-fantasma ---
// Regressão: `apps/api/.env.example` NUNCA deve existir (ver o aviso
// anti-alucinação no cabeçalho de config.ts e o ADR-0019). Existe um único
// template versionado: `.env.example` na raiz do monorepo. Se alguém (humano
// ou agent) recriar o path-fantasma, ou remover o template real da raiz, este
// teste falha cedo.
test('config-boot: apps/api/.env.example não existe (path-fantasma)', () => {
  // __dirname em runtime = apps/api/src/shared/config; ../../../ sobe até apps/api.
  const phantom = resolve(__dirname, '../../../.env.example');
  assert.equal(
    existsSync(phantom),
    false,
    'apps/api/.env.example é um path-fantasma e não deve existir; o único ' +
      'template versionado é .env.example na raiz do monorepo (ver ADR-0019).',
  );

  // Asserção positiva: o único template legítimo deve estar na raiz do
  // monorepo (apps/api/src/shared/config -> ../../../../../ = raiz).
  const rootTemplate = resolve(__dirname, '../../../../../.env.example');
  assert.equal(
    existsSync(rootTemplate),
    true,
    'o template .env.example deve existir na raiz do monorepo; todas as ' +
      'chaves de env ficam documentadas nele (ver ADR-0019).',
  );
});

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// --- US-OBS2 (ADR-0035): flags do worktree isolado resiliente ---

test('loadConfig: worktree flags têm defaults corretos (off/isolated, on/resto)', () => {
  withEnv('AGENT_WORKTREE_ISOLATED', undefined, () =>
    withEnv('AGENT_WORKTREE_MIRROR_IGNORED', undefined, () =>
      withEnv('AGENT_WORKTREE_INIT_SUBMODULES', undefined, () =>
        withEnv('AGENT_WORKTREE_PRESERVE_PATCH', undefined, () => {
          const { agent } = loadConfig();
          assert.equal(agent.worktreeIsolated, false, 'isolated default OFF (retrocompat)');
          assert.equal(agent.worktreeMirrorIgnored, true);
          assert.equal(agent.worktreeInitSubmodules, true);
          assert.equal(agent.worktreePreservePatch, true);
        }),
      ),
    ),
  );
});

test('loadConfig: AGENT_WORKTREE_ISOLATED=true liga o worktree isolado', () => {
  withEnv('AGENT_WORKTREE_ISOLATED', 'true', () => {
    assert.equal(loadConfig().agent.worktreeIsolated, true);
  });
});

test('loadConfig: AGENT_WORKTREE_ISOLATED só liga com o literal "true"', () => {
  withEnv('AGENT_WORKTREE_ISOLATED', '1', () => {
    assert.equal(loadConfig().agent.worktreeIsolated, false);
  });
});

test('loadConfig: MIRROR/INIT/PRESERVE desligam com o literal "false"', () => {
  withEnv('AGENT_WORKTREE_MIRROR_IGNORED', 'false', () =>
    withEnv('AGENT_WORKTREE_INIT_SUBMODULES', 'false', () =>
      withEnv('AGENT_WORKTREE_PRESERVE_PATCH', 'false', () => {
        const { agent } = loadConfig();
        assert.equal(agent.worktreeMirrorIgnored, false);
        assert.equal(agent.worktreeInitSubmodules, false);
        assert.equal(agent.worktreePreservePatch, false);
      }),
    ),
  );
});

// --- US-F2.10 (EP-F2): CUTOVER do recall/blast-radius por grafo ---
// O default das duas envs do strangler-fig do EP-F2 virou LIGADO; `=false` é
// o rollback documentado (restaura o caminho legado byte-idêntico, provado
// pelas specs de paridade da F2.5/F2.7). Ver emenda US-F2.10 do ADR-0027.

test('US-F2.10 cutover: GRAPHIFY_MEMORY_RECALL e GRAPHIFY_AFFECTED_FLOWS ausentes → LIGADOS por default', () => {
  withEnv('GRAPHIFY_MEMORY_RECALL', undefined, () =>
    withEnv('GRAPHIFY_AFFECTED_FLOWS', undefined, () => {
      const { graphify } = loadConfig();
      assert.equal(graphify.memoryRecallEnabled, true, 'recall por grafo é o default pós-cutover');
      assert.equal(graphify.affectedFlowsEnabled, true, 'blast radius derivado é o default pós-cutover');
    }),
  );
});

test('US-F2.10 rollback: o literal "false" DESLIGA cada env (rede de segurança do épico)', () => {
  withEnv('GRAPHIFY_MEMORY_RECALL', 'false', () =>
    withEnv('GRAPHIFY_AFFECTED_FLOWS', 'false', () => {
      const { graphify } = loadConfig();
      assert.equal(graphify.memoryRecallEnabled, false, 'recall desligado (sem memória; o LIKE morreu na US-F2.3)');
      assert.equal(graphify.affectedFlowsEnabled, false, 'rollback do derivado → só declarado');
    }),
  );
});

test('US-F2.10: "true" explícito (o opt-in antigo) continua ligando — .env pré-cutover não regride', () => {
  withEnv('GRAPHIFY_MEMORY_RECALL', 'true', () =>
    withEnv('GRAPHIFY_AFFECTED_FLOWS', 'true', () => {
      const { graphify } = loadConfig();
      assert.equal(graphify.memoryRecallEnabled, true);
      assert.equal(graphify.affectedFlowsEnabled, true);
    }),
  );
});

// --- US-F3.1 (ADR-0036, emenda): AGENT_ADAPTER como única fonte de verdade ---
// Matriz de precedência: AGENT_ADAPTER explícito vence; ausente, o alias
// DEPRECADO AGENT_RUNNER_KIND é honrado; sem os dois, default copilot-cli.

test('resolveAgentAdapter: só AGENT_ADAPTER → vence', () => {
  assert.equal(resolveAgentAdapter('mock', undefined), 'mock');
  assert.equal(resolveAgentAdapter('claude', undefined), 'claude');
});

test('resolveAgentAdapter: só AGENT_RUNNER_KIND legado → honrado', () => {
  assert.equal(resolveAgentAdapter(undefined, 'mock'), 'mock');
  assert.equal(resolveAgentAdapter(undefined, 'copilot-cli'), 'copilot-cli');
  assert.equal(resolveAgentAdapter(undefined, ' MOCK '), 'mock', 'case/trim-insensitive');
});

test('resolveAgentAdapter: ambos setados → AGENT_ADAPTER vence', () => {
  assert.equal(resolveAgentAdapter('copilot-cli', 'mock'), 'copilot-cli');
  assert.equal(resolveAgentAdapter('mock', 'copilot-cli'), 'mock');
});

test('resolveAgentAdapter: nenhum dos dois → default do processo mock (ADR-0014)', () => {
  assert.equal(resolveAgentAdapter(undefined, undefined), 'mock');
});

test('resolveAgentAdapter: AGENT_ADAPTER vazio/desconhecido e legado inválido', () => {
  // Vazio conta como ausente → legado é honrado.
  assert.equal(resolveAgentAdapter('   ', 'mock'), 'mock');
  // Explícito desconhecido vence (e cai no default de CATÁLOGO) — legado NÃO
  // reentra (comportamento pré-US-F3.1: AGENT_ADAPTER setado ia pro registry).
  assert.equal(resolveAgentAdapter('nope', 'mock'), 'copilot-cli');
  // Legado desconhecido → default do processo (pré-US-F3.1: runnerKind caía em mock).
  assert.equal(resolveAgentAdapter(undefined, 'banana'), 'mock');
});

test('loadConfig: agent.runnerKind é DERIVADO de agentAdapter (não diverge)', () => {
  withEnv('AGENT_ADAPTER', 'mock', () =>
    withEnv('AGENT_RUNNER_KIND', undefined, () => {
      const config = loadConfig();
      assert.equal(config.agentAdapter, 'mock');
      assert.equal(config.agent.runnerKind, 'mock');
    }),
  );
  withEnv('AGENT_ADAPTER', undefined, () =>
    withEnv('AGENT_RUNNER_KIND', 'mock', () => {
      const config = loadConfig();
      assert.equal(config.agentAdapter, 'mock', 'alias legado honrado');
      assert.equal(config.agent.runnerKind, 'mock');
    }),
  );
  withEnv('AGENT_ADAPTER', 'copilot-cli', () =>
    withEnv('AGENT_RUNNER_KIND', 'mock', () => {
      const config = loadConfig();
      assert.equal(config.agentAdapter, 'copilot-cli', 'AGENT_ADAPTER vence o conflito');
      assert.equal(config.agent.runnerKind, 'copilot-cli');
    }),
  );
  withEnv('AGENT_ADAPTER', undefined, () =>
    withEnv('AGENT_RUNNER_KIND', undefined, () => {
      const config = loadConfig();
      assert.equal(config.agentAdapter, 'mock', 'default do processo sem envs (ADR-0014)');
      assert.equal(config.agent.runnerKind, 'mock');
    }),
  );
});

test('warnLegacyAgentRunnerKindOnce: avisa UMA vez quando só o legado decide', () => {
  resetLegacyAgentRunnerKindWarningForTests();
  const messages: string[] = [];
  const env = { AGENT_RUNNER_KIND: 'mock' };
  assert.equal(warnLegacyAgentRunnerKindOnce((m) => messages.push(m), env), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /AGENT_RUNNER_KIND/);
  assert.match(messages[0], /DEPRECADO/);
  assert.match(messages[0], /AGENT_ADAPTER=mock/, 'diz qual env usar no lugar');
  // Segunda chamada no mesmo processo: NÃO repete o aviso.
  assert.equal(warnLegacyAgentRunnerKindOnce((m) => messages.push(m), env), false);
  assert.equal(messages.length, 1);
});

test('warnLegacyAgentRunnerKindOnce: silencioso com AGENT_ADAPTER setado ou sem legado', () => {
  resetLegacyAgentRunnerKindWarningForTests();
  const messages: string[] = [];
  const push = (m: string): number => messages.push(m);
  // AGENT_ADAPTER explícito → legado ignorado, sem aviso.
  assert.equal(
    warnLegacyAgentRunnerKindOnce(push, { AGENT_ADAPTER: 'copilot-cli', AGENT_RUNNER_KIND: 'mock' }),
    false,
  );
  // Nenhuma env → sem aviso.
  assert.equal(warnLegacyAgentRunnerKindOnce(push, {}), false);
  assert.equal(messages.length, 0);
  resetLegacyAgentRunnerKindWarningForTests();
});
