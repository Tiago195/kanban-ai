import type { AgentAdapterKind } from '@kanban-ai/shared';
import * as path from 'node:path';

/**
 * Configuração centralizada da API, lida de variáveis de ambiente.
 * Ver `.env.example` na raiz do monorepo.
 *
 * NOTA: existe **um único** arquivo de exemplo de env — `.env.example` na
 * **raiz** do monorepo. Embora existam dois `.env` reais em runtime (raiz e
 * `apps/api/.env`, ver ADR-0019), **não** há `apps/api/.env.example`: todas as
 * chaves ficam documentadas no template da raiz.
 *
 * AVISO (anti-alucinação): NÃO crie `apps/api/.env.example`. Esse path é um
 * arquivo-fantasma — nunca existiu e não deve existir. Este módulo lê apenas
 * `process.env.*` (nenhuma leitura de `.env.example` em runtime); o template
 * versionado vive só na raiz. Ferramentas/agents não devem listá-lo como
 * arquivo tocado no fluxo `config-boot`.
 */
export interface AppConfig {
  apiPort: number;
  wsPath: string;
  databaseUrl: string;
  /**
   * US-OBS4 — adapter de agent ativo no loop engine. O `AGENT_RUNNER` é
   * resolvido a partir deste `kind` via `agent-adapter.registry`. Default
   * `copilot-cli` (não-regressão: sem env, o loop se comporta como antes).
   * Lido de `AGENT_ADAPTER`; valores desconhecidos caem no default. Ver
   * ADR-0036.
   */
  agentAdapter: AgentAdapterKind;
  /**
   * Serviço de memória (ADR-0027, Camada 1 — git como fonte da verdade).
   */
  memory: {
    /**
     * Raiz do **bare git repository** da memória (isomorphic-git). Aponta para
     * um **volume dedicado do serviço**, FORA do repo-alvo, com ciclo de vida
     * independente (não é clone nem convive com o working tree do projeto).
     * Lido de `MEMORY_GIT_DIR`. Default: `./.kanban-ai-memory/git` (relativo ao
     * cwd da API). A validação no boot garante que esteja configurado/válido.
     */
    gitDir: string;
    /**
     * EP-B (ADR-0027) — liga o `MemorySchedulerService`, que dispara em cadência
     * os jobs de manutenção da colmeia (`expireStale` de locks + GC). Lido de
     * `MEMORY_SCHEDULER_ENABLED`. Default `true`; `'false'` desliga TODOS os
     * timers (nada é agendado no boot).
     */
    schedulerEnabled: boolean;
    /**
     * EP-B — intervalo (ms) do tick que varre e auto-libera leases vencidos
     * (`MemoryLockService.expireStale`). Lido de `MEMORY_LOCK_SWEEP_INTERVAL_MS`.
     * Default `30000` (30s).
     */
    lockSweepIntervalMs: number;
    /**
     * EP-B — intervalo (ms) do job de garbage collection da memória
     * (`MemoryGcService`). Lido de `MEMORY_GC_INTERVAL_MS`. Default `3600000`
     * (1h).
     */
    gcIntervalMs: number;
  };
  agent: {
    defaultModel: string;
    maxConcurrentSessions: number;
    watchdogIntervalMs: number;
    autoStepIntervalMs: number;
    workspacesDir: string;
    runnerKind: 'mock' | 'copilot-cli';
    /** Comando base da CLI (ex.: 'copilot', 'node'). */
    cliCommand: string;
    /** Args template da CLI (separados por espaço). `{prompt}` é substituído se promptMode='arg'. */
    cliArgs: string[];
    /** Como o prompt chega à CLI: via stdin ou como argumento. */
    promptMode: 'stdin' | 'arg';
    /** Timeout de espera por resposta do humano (HITL). */
    hitlTimeoutMs: number;
    /** Timeout de inatividade de stdout do subprocesso. */
    streamIdleTimeoutMs: number;
    /** #1: habilita validação empírica (rodar scripts do projeto no worktree). */
    validationEnabled: boolean;
    /** #1: timeout (ms) por script de validação rodado no worktree. */
    validationTimeoutMs: number;
    /** #1: override opcional dos scripts a rodar (default: auto-detect test/build/lint). */
    validationScripts: string[];
    /** #7: verifica se os arquivos declarados em affectedFlows existem no worktree. */
    verifyFlowFiles: boolean;
    /**
     * Validação direcionada por fluxo: liga a busca+execução de testes
     * associados aos arquivos de cada affectedFlow (complementa os scripts
     * globais). Default true.
     */
    flowTestsEnabled: boolean;
    /**
     * Marcadores (infixos/sufixos) que identificam um arquivo de teste
     * co-located, ex.: `.spec.` casa `foo.spec.ts`. Default `['.spec.','.test.']`.
     */
    flowTestGlobs: string[];
    /**
     * Se true, um fluxo declarado sem NENHUM teste associado vira `problem`.
     * Se false (default), apenas registra aviso — não bloqueia.
     */
    requireFlowCoverage: boolean;
    /**
     * "Needs human": número máximo de falhas de validação por task antes de o
     * loop desistir de derivar e marcar a task com `needsHuman`, parando o
     * auto-play da story (graceful). Default 3.
     */
    maxValidationFailures: number;
    /**
     * Cap de iterações por task — proteção contra loop infinito. Ao atingir
     * `maxIterationsPerTask` iterações persistidas, o loop escala para humano
     * (reason de loop). Default 30 (LIGADO por padrão — é a salvaguarda
     * anti-loop-infinito). `0` desliga. AGENT_MAX_ITERATIONS_PER_TASK.
     */
    maxIterationsPerTask: number;
    /**
     * Cap de iterações IMPRODUTIVAS consecutivas — quantas iterações seguidas
     * de fase `implementation` podem terminar com o `diff` do worktree VAZIO
     * antes de o loop escalar para humano (marca `needsHuman`, para o auto-play).
     * É uma defesa PRÓPRIA contra o deadlock de `blocked_dep`/derivações que
     * ciclam sem produzir código — independente de qualquer outro defeito que
     * possa zerar o diff. Default 3. `0` desliga.
     * AGENT_MAX_UNPRODUCTIVE_ITERATIONS.
     */
    maxUnproductiveIterations: number;
    /**
     * Cap de profundidade de derivação — quantas derivações em cadeia
     * (task → task derivada → ...) são permitidas antes de o loop escalar para
     * humano em vez de derivar de novo. Default 3. `0` desliga.
     * AGENT_MAX_DERIVED_DEPTH.
     */
    maxDerivedDepth: number;
    /**
     * Cap AGREGADO de derivações por problema/fluxo dentro da MESMA story —
     * quantas tasks de correção abertas para o MESMO `problem.title` (mesmo
     * título `Corrigir: …` sob o mesmo epic/story) podem coexistir antes de o
     * loop escalar para humano em vez de derivar mais uma. Fecha a brecha em
     * que cada falha inicia uma cadeia NOVA (depth reinicia) escapando do cap
     * de profundidade. Default 2. `0` desliga. AGENT_MAX_DERIVED_PER_PROBLEM.
     */
    maxDerivedPerProblem: number;
    /**
     * Gate de custo — orçamento de TEMPO por task. Soma de `durationMs` das
     * iterações da task; ao ultrapassar, o loop marca `needsHuman` (reason de
     * custo), para o auto-play graceful e emite `card.needs_human`.
     * `0` desliga o gate (default). AGENT_MAX_TASK_DURATION_MS.
     */
    maxTaskDurationMs: number;
    /**
     * Gate de custo — orçamento de TOKENS por task (input+output somados das
     * iterações). Mesmo destino do gate de tempo. `0` desliga (default).
     * AGENT_MAX_TASK_TOKENS.
     */
    maxTaskTokens: number;
    /**
     * Serialização de stories: quando `true`, mantém o guard-rail LEGADO de "uma
     * story In Progress por repo-alvo físico" (aiProject) EM ADIÇÃO à
     * serialização por epic. Necessário só enquanto o worktree isolado por
     * execução for stub (ADR-0019): dois épicos apontando para o MESMO repo
     * físico se sobrescreveriam ao codar no mesmo working tree. Default `false`
     * — a serialização passa a ser por EPIC (stories de épicos diferentes rodam
     * concorrentes, respeitando o limite global de sessões). Ligue quando vários
     * épicos ativos compartilharem o mesmo repo-alvo sem worktree isolado.
     * AGENT_SERIALIZE_BY_REPO.
     */
    serializeByRepo: boolean;
    /**
     * Anti-thrash — similaridade (0..1) entre `summary`+`nextStep` de iterações
     * consecutivas acima da qual a AI é considerada "travada". Default 0.9.
    /**
     * Anti-thrash — liga a detecção de "AI travada" (iterações repetitivas).
     * Desligado por default para não interferir no loop normal/mock (onde
     * iterações de implementação podem repetir `summary`/`nextStep`
     * legitimamente). AGENT_THRASH_DETECTION_ENABLED.
     */
    thrashDetectionEnabled: boolean;
    /**
     * Anti-thrash — similaridade (0..1) entre `summary`+`nextStep` de iterações
     * consecutivas acima da qual a AI é considerada "travada". Default 0.9.
     * AGENT_THRASH_SIMILARITY.
     */
    thrashSimilarityThreshold: number;
    /**
     * Anti-thrash — quantas iterações recentes comparar (janela). Default 2
     * (compara a última com a anterior). AGENT_THRASH_WINDOW.
     */
    thrashWindow: number;
    /**
     * Gate de `done` — exige `evidence` ESTRUTURADA e verificável (ao menos um
     * check com `passed=true`) antes de fechar a task. Se `true` e a evidence
     * não for verificável, o `done` é recusado. Default false.
     * AGENT_REQUIRE_STRUCTURED_EVIDENCE.
     */
    requireStructuredEvidence: boolean;
    /**
     * US-ROB1 — quando ligado, o gate de `done` exige o artefato MÍNIMO por
     * classe de resultado (code-change → diff não-vazio; test-green → check de
     * teste passed:true; flow-artifact → arquivos de fluxo presentes).
     * Complementa `requireStructuredEvidence`. Off por default (retrocompat).
     * Env: AGENT_REQUIRE_MIN_ARTIFACT.
     */
    requireMinArtifact: boolean;
    /**
     * US-ROB2 — persiste o estado de runtime da sessão (AgentRuntimeState) para
     * sobreviver a restart. Default LIGADO (persistir é seguro e idempotente).
     * Off = comportamento legado (só Map in-process). Env:
     * AGENT_RUNTIME_PERSIST_ENABLED (`false` desliga).
     */
    runtimePersistEnabled: boolean;
    /**
     * US-ROB4 — liga o lease/claim por execução (claimLock/claimExpiresAt em
     * AgentRuntimeState). O watchdog renova o lease enquanto a sessão vive e
     * recupera o slot quando vence. Off por default (retrocompat: boot/watchdog
     * como hoje). Env: AGENT_CLAIM_ENABLED (`true` liga).
     */
    claimEnabled: boolean;
    /**
     * US-ROB4 — TTL do lease em ms. DEVE ser > `watchdogIntervalMs` para o
     * heartbeat renovar antes do vencimento (senão o watchdog recuperaria
     * sessões vivas). Default 5 min. Env: AGENT_CLAIM_TTL_MS.
     */
    claimTtlMs: number;
    /**
     * US-ROB3 — quando true, ao fechar uma task o orquestrador promove
     * proativamente os dependentes que ficaram READY (recompute + auto-play da
     * story-dona, se In Progress). Off por default. Env: AGENT_AUTOSTART_DEPENDENTS.
     */
    autostartDependents: boolean;
    /**
     * US-COLAB3 — liga a wakeup queue persistente (Postgres) idempotente com
     * coalescing. Quando ON, os gatilhos (story→In Progress, task_added, HITL,
     * stepOnce, reconcile no boot) ENFILEIRAM o wakeup numa tabela durável antes
     * de acordar a story, e o boot recupera `claimed` órfãos. Off por default
     * (retrocompat: acorda direto, sem estado durável). O executor segue
     * in-process, SEM Redis (invariante 7). Env: AGENT_WAKEUP_QUEUE_ENABLED
     * (`true` liga).
     */
    wakeupQueueEnabled: boolean;
    /**
     * US-OBS2 (ADR-0035, refina ADR-0008) — worktree ISOLADO por execução.
     * Quando `true`, `resolveWorkdir` cria um `git worktree add` dedicado (branch
     * `kanban-ai/<key>`) e `cleanupWorktree` roda `git worktree remove` só contra
     * esse worktree (nunca contra o repo-alvo). Off por default = comportamento
     * legado (agent coda direto no working tree do repo-alvo). Só têm efeito com
     * a flag ligada. Env: AGENT_WORKTREE_ISOLATED (`true` liga).
     */
    worktreeIsolated: boolean;
    /**
     * US-OBS2 — ao criar o worktree isolado, espelha paths ignorados pesados
     * (ex.: node_modules) do repo-alvo via SYMLINK (barato). Default `true`; só
     * atua com `worktreeIsolated=true`. Env: AGENT_WORKTREE_MIRROR_IGNORED
     * (`false` desliga).
     */
    worktreeMirrorIgnored: boolean;
    /**
     * US-OBS2 — ao criar o worktree isolado, roda
     * `git submodule update --init --recursive`. Default `true`; só atua com
     * `worktreeIsolated=true`. Env: AGENT_WORKTREE_INIT_SUBMODULES (`false`
     * desliga).
     */
    worktreeInitSubmodules: boolean;
    /**
     * US-OBS2 — ao remover o worktree (trash/restart), captura o patch
     * não-commitado para reaplicar numa recriação futura. Default `true`; só
     * atua com `worktreeIsolated=true`. Env: AGENT_WORKTREE_PRESERVE_PATCH
     * (`false` desliga).
     */
    worktreePreservePatch: boolean;
    /**
     * US-OBS3 (ADR-0037) — auto-commit OPT-IN (default `false`). Quando `true`
     * E a validação da iteração fecha VERDE (evidência verificável) E existe um
     * worktree ISOLADO (ADR-0035), o ENGINE (nunca o agent) commita as mudanças
     * do worktree na branch de execução. Default off = comportamento idêntico ao
     * de hoje (zero commit). Env: AGENT_AUTO_COMMIT (`true` liga).
     */
    autoCommit: boolean;
    /**
     * US-OBS3 (ADR-0037) — abre PR OPCIONAL após um auto-commit bem-sucedido
     * (só faz sentido com `autoCommit=true`). Default `false`. Env: AGENT_AUTO_PR
     * (`true` liga). No v1 é um ponto de extensão: sem `gh`/token configurado,
     * o commit é feito mas nenhum PR é aberto (sem erro).
     */
    autoPr: boolean;
  };
  /**
   * US-OBS1 — configuração do dashboard de frota (`GET /dashboard`).
   */
  dashboard: {
    /**
     * Threshold (minutos) acima do qual uma story `In Progress` sem iteração
     * recente é considerada "stale" no dashboard. Lido de
     * `DASHBOARD_STALE_MINUTES`. Default `30`.
     */
    staleMinutes: number;
  };
  /**
   * EP-PROJECT / US-PROJ2 — clone gerenciado dos repositórios de `Project`.
   */
  projects: {
    /**
     * Raiz gerenciada dos clones (`<PROJECTS_DIR>/<projectId>`). Resolvida para
     * caminho ABSOLUTO no boot. Lido de `PROJECTS_DIR`. Default
     * `./.kanban-ai-projects` (relativo ao cwd da API). O `ProjectWorkspaceService`
     * cria o diretório se ausente e recusa qualquer clone que aterrisse DENTRO do
     * próprio repo do kanban-ai (guard-rail `isInsideSelfRepo`).
     */
    dir: string;
    /**
     * Timeout (ms) das operações de git (`clone`/`fetch`) via isomorphic-git.
     * Lido de `PROJECTS_GIT_TIMEOUT_MS`. Default `300000` (5 min).
     */
    gitTimeoutMs: number;
    /**
     * EP-PROJECT / US-PROJ3 — habilita clone via SSH (delegado ao `git` do
     * sistema por `child_process`, pois isomorphic-git não fala ssh). Lido de
     * `PROJECTS_ALLOW_SSH`. Default **false** (desabilitado): com a flag off,
     * um Project `authKind='ssh'` falha com mensagem legível. Ligar exige um
     * agente ssh/chave configurado no ambiente do servidor.
     */
    allowSsh: boolean;
  };
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Lê uma env csv em lista de strings não-vazias; usa `fallback` se ausente/vazia. */
function csv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  const parsed = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * Default do bare repo da memória (ADR-0027, Camada 1). VOLUME DEDICADO, com
 * ciclo de vida independente e FORA do repo-alvo.
 */
export const DEFAULT_MEMORY_GIT_DIR = './.kanban-ai-memory/git';

/**
 * Resolve e valida o caminho do bare repo da memória (`MEMORY_GIT_DIR`),
 * falhando cedo com mensagem clara se estiver configurado de forma inválida.
 *
 * - Ausente (`undefined`): usa o default documentado.
 * - Presente mas vazio/só-espaços: erro (configuração explícita inválida).
 * - Presente e válido: usa o valor com trim.
 */
export function resolveMemoryGitDir(value: string | undefined): string {
  if (value === undefined) return DEFAULT_MEMORY_GIT_DIR;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'MEMORY_GIT_DIR está definido mas vazio: configure o caminho do bare repo ' +
        `da memória (volume dedicado, fora do repo-alvo) ou remova a variável para usar o default "${DEFAULT_MEMORY_GIT_DIR}".`,
    );
  }
  return trimmed;
}

/**
 * US-OBS4 — kinds de adapter conhecidos. Fonte da verdade para validar
 * `AGENT_ADAPTER` e para o registry declarar descritores. Espelha o union
 * `AgentAdapterKind` de `@kanban-ai/shared`.
 */
export const AGENT_ADAPTER_KINDS: readonly AgentAdapterKind[] = [
  'copilot-cli',
  'claude',
  'codex',
  'gemini',
  'mock',
];

/** Adapter default do loop (não-regressão). */
export const DEFAULT_AGENT_ADAPTER: AgentAdapterKind = 'copilot-cli';
/**
 * Resolve `AGENT_ADAPTER` para um `AgentAdapterKind` conhecido. Ausente, vazio
 * ou desconhecido → default `copilot-cli` (não-regressão). Case-insensitive.
 */
export function resolveAgentAdapter(value: string | undefined): AgentAdapterKind {
  if (value === undefined) return DEFAULT_AGENT_ADAPTER;
  const normalized = value.trim().toLowerCase();
  const match = AGENT_ADAPTER_KINDS.find((k) => k === normalized);
  return match ?? DEFAULT_AGENT_ADAPTER;
}

/**
 * Default da raiz gerenciada dos clones de Project (EP-PROJECT / US-PROJ2).
 * Relativo ao cwd da API; resolvido para ABSOLUTO por `resolveProjectsDir`.
 */
export const DEFAULT_PROJECTS_DIR = './.kanban-ai-projects';

/**
 * Resolve `PROJECTS_DIR` para um caminho ABSOLUTO, falhando cedo se configurado
 * de forma inválida (presente mas vazio). Ausente → default documentado. O
 * resultado é sempre absoluto (`path.resolve`) porque o clone gerenciado precisa
 * de um path estável independente do cwd de cada operação.
 */
export function resolveProjectsDir(value: string | undefined): string {
  if (value === undefined) return path.resolve(DEFAULT_PROJECTS_DIR);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'PROJECTS_DIR está definido mas vazio: configure a raiz gerenciada dos ' +
        `clones de Project ou remova a variável para usar o default "${DEFAULT_PROJECTS_DIR}".`,
    );
  }
  return path.resolve(trimmed);
}

export function loadConfig(): AppConfig {
  return {
    apiPort: num(process.env.API_PORT, 3333),
    wsPath: process.env.WS_PATH ?? '/ws',
    databaseUrl: process.env.DATABASE_URL ?? '',
    agentAdapter: resolveAgentAdapter(process.env.AGENT_ADAPTER),
    memory: {
      gitDir: resolveMemoryGitDir(process.env.MEMORY_GIT_DIR),
      schedulerEnabled: process.env.MEMORY_SCHEDULER_ENABLED !== 'false',
      lockSweepIntervalMs: num(process.env.MEMORY_LOCK_SWEEP_INTERVAL_MS, 30_000),
      gcIntervalMs: num(process.env.MEMORY_GC_INTERVAL_MS, 3_600_000),
    },
    agent: {
      defaultModel: process.env.AGENT_DEFAULT_MODEL ?? 'opus',
      maxConcurrentSessions: num(process.env.AGENT_MAX_CONCURRENT_SESSIONS, 3),
      watchdogIntervalMs: num(process.env.AGENT_WATCHDOG_INTERVAL_MS, 120_000),
      autoStepIntervalMs: num(process.env.AGENT_AUTO_STEP_INTERVAL_MS, 1_500),
      workspacesDir: process.env.AGENT_WORKSPACES_DIR ?? './.agent-workspaces',
      runnerKind: process.env.AGENT_RUNNER_KIND === 'copilot-cli' ? 'copilot-cli' : 'mock',
      cliCommand: process.env.AGENT_CLI_COMMAND ?? 'copilot',
      cliArgs: (process.env.AGENT_CLI_ARGS ?? '').split(' ').filter((a) => a.length > 0),
      promptMode: process.env.AGENT_CLI_PROMPT_MODE === 'arg' ? 'arg' : 'stdin',
      hitlTimeoutMs: num(process.env.AGENT_HITL_TIMEOUT_MS, 600_000),
      streamIdleTimeoutMs: num(process.env.AGENT_STREAM_IDLE_TIMEOUT_MS, 120_000),
      validationEnabled: process.env.AGENT_VALIDATION_ENABLED !== 'false',
      validationTimeoutMs: num(process.env.AGENT_VALIDATION_TIMEOUT_MS, 300_000),
      validationScripts: (process.env.AGENT_VALIDATION_SCRIPTS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      verifyFlowFiles: process.env.AGENT_VERIFY_FLOW_FILES !== 'false',
      flowTestsEnabled: process.env.AGENT_FLOW_TESTS_ENABLED !== 'false',
      flowTestGlobs: csv(process.env.AGENT_FLOW_TEST_GLOBS, ['.spec.', '.test.']),
      requireFlowCoverage: process.env.AGENT_REQUIRE_FLOW_COVERAGE === 'true',
      maxValidationFailures: num(process.env.AGENT_MAX_VALIDATION_FAILURES, 3),
      maxIterationsPerTask: num(process.env.AGENT_MAX_ITERATIONS_PER_TASK, 30),
      maxUnproductiveIterations: num(process.env.AGENT_MAX_UNPRODUCTIVE_ITERATIONS, 3),
      maxDerivedDepth: num(process.env.AGENT_MAX_DERIVED_DEPTH, 3),
      maxDerivedPerProblem: num(process.env.AGENT_MAX_DERIVED_PER_PROBLEM, 2),
      maxTaskDurationMs: num(process.env.AGENT_MAX_TASK_DURATION_MS, 0),
      maxTaskTokens: num(process.env.AGENT_MAX_TASK_TOKENS, 0),
      serializeByRepo: process.env.AGENT_SERIALIZE_BY_REPO === 'true',
      thrashDetectionEnabled:
        process.env.AGENT_THRASH_DETECTION_ENABLED === 'true',
      thrashSimilarityThreshold: num(process.env.AGENT_THRASH_SIMILARITY, 0.9),
      thrashWindow: num(process.env.AGENT_THRASH_WINDOW, 2),
      requireStructuredEvidence: process.env.AGENT_REQUIRE_STRUCTURED_EVIDENCE === 'true',
      requireMinArtifact: process.env.AGENT_REQUIRE_MIN_ARTIFACT === 'true',
      runtimePersistEnabled: process.env.AGENT_RUNTIME_PERSIST_ENABLED !== 'false',
      claimEnabled: process.env.AGENT_CLAIM_ENABLED === 'true',
      claimTtlMs: num(process.env.AGENT_CLAIM_TTL_MS, 300_000),
      autostartDependents: process.env.AGENT_AUTOSTART_DEPENDENTS === 'true',
      wakeupQueueEnabled: process.env.AGENT_WAKEUP_QUEUE_ENABLED === 'true',
      worktreeIsolated: process.env.AGENT_WORKTREE_ISOLATED === 'true',
      worktreeMirrorIgnored: process.env.AGENT_WORKTREE_MIRROR_IGNORED !== 'false',
      worktreeInitSubmodules: process.env.AGENT_WORKTREE_INIT_SUBMODULES !== 'false',
      worktreePreservePatch: process.env.AGENT_WORKTREE_PRESERVE_PATCH !== 'false',
      autoCommit: process.env.AGENT_AUTO_COMMIT === 'true',
      autoPr: process.env.AGENT_AUTO_PR === 'true',
    },
    dashboard: {
      staleMinutes: num(process.env.DASHBOARD_STALE_MINUTES, 30),
    },
    projects: {
      dir: resolveProjectsDir(process.env.PROJECTS_DIR),
      gitTimeoutMs: num(process.env.PROJECTS_GIT_TIMEOUT_MS, 300_000),
      allowSsh: process.env.PROJECTS_ALLOW_SSH === 'true',
    },
  };
}

/** Token de injeção para o AppConfig. */
export const APP_CONFIG = 'APP_CONFIG';
