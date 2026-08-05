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
  };
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    },
  };
}

/** Token de injeção para o AppConfig. */
export const APP_CONFIG = 'APP_CONFIG';
