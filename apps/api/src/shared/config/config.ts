/**
 * Configuração centralizada da API, lida de variáveis de ambiente.
 * Ver `.env.example` na raiz do monorepo.
 */
export interface AppConfig {
  apiPort: number;
  wsPath: string;
  databaseUrl: string;
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
     * Cap de profundidade de derivação — quantas derivações em cadeia
     * (task → task derivada → ...) são permitidas antes de o loop escalar para
     * humano em vez de derivar de novo. Default 3. `0` desliga.
     * AGENT_MAX_DERIVED_DEPTH.
     */
    maxDerivedDepth: number;
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

export function loadConfig(): AppConfig {
  return {
    apiPort: num(process.env.API_PORT, 3333),
    wsPath: process.env.WS_PATH ?? '/ws',
    databaseUrl: process.env.DATABASE_URL ?? '',
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
      maxDerivedDepth: num(process.env.AGENT_MAX_DERIVED_DEPTH, 3),
      maxTaskDurationMs: num(process.env.AGENT_MAX_TASK_DURATION_MS, 0),
      maxTaskTokens: num(process.env.AGENT_MAX_TASK_TOKENS, 0),
      thrashDetectionEnabled:
        process.env.AGENT_THRASH_DETECTION_ENABLED === 'true',
      thrashSimilarityThreshold: num(process.env.AGENT_THRASH_SIMILARITY, 0.9),
      thrashWindow: num(process.env.AGENT_THRASH_WINDOW, 2),
      requireStructuredEvidence: process.env.AGENT_REQUIRE_STRUCTURED_EVIDENCE === 'true',
    },
  };
}

/** Token de injeção para o AppConfig. */
export const APP_CONFIG = 'APP_CONFIG';
