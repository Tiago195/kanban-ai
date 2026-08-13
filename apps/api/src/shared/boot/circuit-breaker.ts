import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * US-HARD2 — circuit-breaker de crash-loop no boot com backoff persistido.
 *
 * PROBLEMA: se a API entra em crash-loop (falha ANTES de um shutdown limpo),
 * um supervisor (systemd, docker restart, k8s) a reinicia imediatamente, e cada
 * reinício martela o Postgres/LLM. Isso amplifica um incidente em vez de dar
 * tempo para a dependência se recuperar.
 *
 * SOLUÇÃO: antes do `NestFactory.create`, persistimos um contador de tentativas
 * "sujas" (in-progress) em `<dataDir>/circuit-breaker.json`. Cada boot:
 *   1. lê o estado anterior;
 *   2. se o boot anterior NÃO marcou shutdown limpo dentro da janela de
 *      recuperação, ele é considerado uma falha → incrementa `attempt`;
 *   3. caso contrário (marca limpa OU janela expirou) → reseta `attempt` para 0;
 *   4. dorme `computeBackoffSeconds(attempt)` segundos antes de prosseguir;
 *   5. grava o estado "sujo" incrementado (para que, se ESTE boot crashar antes
 *      do shutdown limpo, o próximo veja a falha).
 *
 * Ao boot bem-sucedido (`app.listen` OK) e ao shutdown gracioso, chamamos
 * `reset()`, que zera o contador — saímos da zona de perigo do crash-loop.
 *
 * A DECISÃO é PURA e testável (`computeBackoffSeconds`, `nextAttemptState`),
 * separada do I/O de disco (`readState`, `writeState`, `reset`).
 */

/** Estado persistido do circuit-breaker. */
export interface CircuitBreakerState {
  /** Número de tentativas de boot consecutivas sem shutdown limpo. */
  attempt: number;
  /** Epoch ms em que este estado foi gravado. */
  timestamp: number;
}

/**
 * Schedule de backoff (segundos) indexado por `attempt`. As duas primeiras
 * tentativas são `0s` para NÃO atrasar boots saudáveis (ou o primeiro reinício
 * após um restart legítimo). A partir daí a espera cresce até um teto de 15min.
 */
export const BACKOFF_SCHEDULE_SECONDS: readonly number[] = [0, 0, 10, 30, 120, 300, 900];

/** Estado inicial (nenhum boot registrado ainda). */
export const INITIAL_STATE: CircuitBreakerState = { attempt: 0, timestamp: 0 };

/**
 * PURA — segundos de backoff para uma dada `attempt`. Clampa no último valor do
 * schedule para attempts além do fim (e trata negativos/NaN como 0).
 */
export function computeBackoffSeconds(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return BACKOFF_SCHEDULE_SECONDS[0];
  const idx = Math.min(Math.floor(attempt), BACKOFF_SCHEDULE_SECONDS.length - 1);
  return BACKOFF_SCHEDULE_SECONDS[idx];
}

/**
 * PURA — calcula o próximo estado do circuit-breaker a partir do estado anterior.
 *
 * @param prev          estado lido do disco (ou `INITIAL_STATE` se ausente).
 * @param cleanShutdown `true` se o boot anterior registrou shutdown limpo
 *                      (contador já foi zerado por `reset`); nesse caso o estado
 *                      persistido tem `attempt === 0`.
 * @param now           epoch ms atual.
 * @param windowMs      janela de recuperação: se o estado sujo é MAIS VELHO que
 *                      isso, assumimos que o processo ficou muito tempo no ar
 *                      (não é crash-loop) e resetamos.
 *
 * Regras:
 *  - `cleanShutdown` OU `prev.attempt === 0` → reset (`attempt: 0`).
 *  - estado sujo mais velho que a janela → reset (não é crash-loop imediato).
 *  - caso contrário (crash sem shutdown limpo dentro da janela) → incrementa.
 */
export function nextAttemptState(
  prev: CircuitBreakerState,
  cleanShutdown: boolean,
  now: number,
  windowMs: number,
): CircuitBreakerState {
  const staleByWindow = windowMs > 0 && now - prev.timestamp > windowMs;
  if (cleanShutdown || prev.attempt <= 0 || staleByWindow) {
    return { attempt: 0, timestamp: now };
  }
  return { attempt: prev.attempt + 1, timestamp: now };
}

/** Caminho do arquivo de estado dentro do data dir. */
export function stateFilePath(dataDir: string): string {
  return path.join(dataDir, 'circuit-breaker.json');
}

/**
 * I/O — lê o estado do disco. Retorna `INITIAL_STATE` se o arquivo não existe ou
 * está corrompido (fail-open: nunca bloqueia o boot por causa de leitura ruim).
 */
export function readState(dataDir: string): CircuitBreakerState {
  const file = stateFilePath(dataDir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CircuitBreakerState>;
    const attempt = Number(parsed.attempt);
    const timestamp = Number(parsed.timestamp);
    return {
      attempt: Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}

/** I/O — grava o estado no disco (cria o data dir se ausente). */
export function writeState(dataDir: string, state: CircuitBreakerState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(stateFilePath(dataDir), `${JSON.stringify(state)}\n`, 'utf8');
}

/**
 * I/O — reseta o contador (marca shutdown limpo / boot saudável). Chamado após
 * `app.listen` bem-sucedido e no shutdown gracioso.
 */
export function reset(dataDir: string, now: number = Date.now()): void {
  writeState(dataDir, { attempt: 0, timestamp: now });
}

/** Sleep utilitário. */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Opções do orquestrador de boot. */
export interface CircuitBreakerBootOptions {
  /** Data dir onde `circuit-breaker.json` vive. */
  dataDir: string;
  /** Janela de recuperação (ms) — ver `nextAttemptState`. */
  windowMs: number;
  /** Circuit-breaker habilitado. Se `false`, é um no-op (não lê/grava/dorme). */
  enabled: boolean;
  /** Logger opcional (default `console`). */
  log?: (message: string) => void;
}

/**
 * Orquestra a fase de backoff ANTES do bootstrap: lê o estado, computa a próxima
 * tentativa, dorme o backoff correspondente e persiste o estado sujo incrementado.
 * Retorna o novo estado (ou `INITIAL_STATE` se desabilitado).
 */
export async function applyBootBackoff(
  options: CircuitBreakerBootOptions,
): Promise<CircuitBreakerState> {
  if (!options.enabled) return { ...INITIAL_STATE };
  const log = options.log ?? ((m: string) => console.log(m));
  const now = Date.now();
  const prev = readState(options.dataDir);
  // O estado persistido só é "sujo" (attempt > 0) quando o boot anterior NÃO
  // chamou `reset()`. Portanto, um `attempt > 0` lido do disco já indica que o
  // shutdown limpo NÃO aconteceu.
  const cleanShutdown = prev.attempt <= 0;
  const next = nextAttemptState(prev, cleanShutdown, now, options.windowMs);
  const backoffSeconds = computeBackoffSeconds(next.attempt);

  writeState(options.dataDir, next);

  if (backoffSeconds > 0) {
    log(
      `[circuit-breaker] boot anterior sem shutdown limpo (attempt=${next.attempt}); ` +
        `aguardando ${backoffSeconds}s antes de prosseguir para throttle de crash-loop.`,
    );
    await sleep(backoffSeconds * 1000);
  }

  return next;
}
