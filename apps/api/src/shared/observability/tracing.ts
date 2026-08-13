import { Logger } from '@nestjs/common';

/**
 * US-OBS2-1 — OpenTelemetry tracing **opt-in**, exclusivo do processo da API,
 * com **custo zero quando desligado**.
 *
 * ── Escopo (LIMITE IMPORTANTE) ──────────────────────────────────────────────
 * Este bootstrap instrumenta APENAS o que roda DENTRO do processo Node da API:
 * HTTP (server/client), Fastify e PG. As instrumentações `fs`/`dns`/`net` ficam
 * DESLIGADAS (ruído sem valor para nós).
 *
 * O trabalho real do loop engine acontece em SUBPROCESSOS `copilot` spawnados
 * (`ai-engine/runners/copilot-cli.runner.ts` via `child_process`; orquestração
 * via `execFile`). Esses subprocessos NÃO compartilham o SDK OTel deste
 * processo — portanto NÃO há trace fim-a-fim "board→spawn→...". O que
 * conseguimos é a árvore de spans do lado da API (requisição HTTP →
 * handler Nest → query PG), o que já cobre o objetivo desta story.
 *
 * ── Gating & overhead zero ──────────────────────────────────────────────────
 * A ativação é decidida SÓ pela presença de `OTEL_EXPORTER_OTLP_ENDPOINT`.
 * Quando ausente, `initTracing` retorna imediatamente e NENHUM pacote OTel é
 * carregado (o `import()` dinâmico vive DENTRO do ramo habilitado). Assim, com a
 * feature desligada, não há require de SDK, nenhum monkey-patch de módulos e
 * nenhum timer — literalmente custo zero.
 *
 * ── Degradação graciosa ─────────────────────────────────────────────────────
 * Se os pacotes OTel não estiverem instalados (o `import()` lança) ou a init
 * falhar por qualquer motivo, logamos UMA vez (`warn`) e seguimos o boot. Tracing
 * NUNCA derruba a API.
 */

const LOGGER_CONTEXT = 'Tracing';

/** Variável de ambiente que, quando presente e não-vazia, liga o tracing. */
export const OTEL_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/** Nome de serviço default reportado nos spans. */
export const DEFAULT_SERVICE_NAME = 'kanban-ai-api';

/**
 * Config resolvida do tracing. `enabled` é derivado exclusivamente da presença
 * de um endpoint OTLP não-vazio (mesma convenção opt-in do restante do config).
 */
export interface TracingConfig {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
}

/**
 * Decisão de gating PURA (testável sem side-effects): resolve a config de
 * tracing a partir de um mapa de env (default `process.env`). NÃO importa nem
 * inicializa nada — só interpreta as variáveis.
 */
export function resolveTracingConfig(
  env: NodeJS.ProcessEnv = process.env,
): TracingConfig {
  const endpoint = (env[OTEL_ENDPOINT_ENV] ?? '').trim();
  const serviceName =
    (env.OTEL_SERVICE_NAME ?? '').trim() || DEFAULT_SERVICE_NAME;
  return {
    enabled: endpoint.length > 0,
    endpoint,
    serviceName,
  };
}

/**
 * Injeção mínima para testar o ramo habilitado sem carregar os pacotes OTel
 * reais nem falar com um collector. Em produção o default usa `import()`.
 */
export interface TracingDeps {
  /** Importador dinâmico do SDK; default = `import()` real. */
  importOtel?: () => Promise<OtelModules>;
  /** Logger injetável (default = Nest `Logger`). */
  log?: Pick<Logger, 'warn' | 'log'>;
}

/**
 * Superfície mínima dos módulos OTel que consumimos. Mantida frouxa de
 * propósito: só precisamos construir o NodeSDK e registrar o shutdown.
 */
export interface OtelModules {
  NodeSDK: new (cfg: Record<string, unknown>) => {
    start: () => void;
    shutdown: () => Promise<void>;
  };
  OTLPTraceExporter: new (cfg: Record<string, unknown>) => unknown;
  getNodeAutoInstrumentations: (cfg: Record<string, unknown>) => unknown;
  Resource: new (attrs: Record<string, unknown>) => unknown;
  ATTR_SERVICE_NAME: string;
}

/**
 * Importador real dos pacotes OTel. Isolado numa função para (a) manter o
 * `import()` dentro do ramo habilitado e (b) permitir mock nos testes.
 */
async function importOtelDefault(): Promise<OtelModules> {
  const [sdkNode, exporter, autoInstr, resources, semconv] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);
  return {
    NodeSDK: (sdkNode as { NodeSDK: OtelModules['NodeSDK'] }).NodeSDK,
    OTLPTraceExporter: (exporter as { OTLPTraceExporter: OtelModules['OTLPTraceExporter'] })
      .OTLPTraceExporter,
    getNodeAutoInstrumentations: (
      autoInstr as { getNodeAutoInstrumentations: OtelModules['getNodeAutoInstrumentations'] }
    ).getNodeAutoInstrumentations,
    Resource: (resources as { Resource: OtelModules['Resource'] }).Resource,
    ATTR_SERVICE_NAME: (semconv as { ATTR_SERVICE_NAME: string }).ATTR_SERVICE_NAME,
  };
}

let started = false;

/**
 * Inicializa o tracing OTel se (e somente se) `OTEL_EXPORTER_OTLP_ENDPOINT`
 * estiver presente. Idempotente. Deve ser chamada ANTES de `NestFactory.create`
 * (e antes de qualquer módulo instrumentado — HTTP/Fastify/pg) para que o
 * auto-instrument consiga aplicar os patches.
 *
 * @returns `true` se o SDK foi iniciado; `false` se desligado ou se falhou de
 * forma graciosa (nunca lança).
 */
export async function initTracing(deps: TracingDeps = {}): Promise<boolean> {
  if (started) return true;

  const log = deps.log ?? new Logger(LOGGER_CONTEXT);
  const cfg = resolveTracingConfig();

  // Overhead zero: sem endpoint → nenhum pacote OTel é sequer importado.
  if (!cfg.enabled) return false;

  try {
    const importOtel = deps.importOtel ?? importOtelDefault;
    const otel = await importOtel();

    const exporter = new otel.OTLPTraceExporter({ url: cfg.endpoint });

    const sdk = new otel.NodeSDK({
      resource: new otel.Resource({
        [otel.ATTR_SERVICE_NAME]: cfg.serviceName,
      }),
      traceExporter: exporter,
      instrumentations: [
        otel.getNodeAutoInstrumentations({
          // Escopo API-side apenas: HTTP + Fastify + PG. Instrumentações
          // ruidosas e sem valor para nós ficam DESLIGADAS.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
        }),
      ],
    });

    sdk.start();
    started = true;

    // Shutdown gracioso: coexiste com os handlers de sinal do main.ts (usamos
    // `once` para não acumular listeners e não clobberar os existentes).
    const shutdown = (): void => {
      void sdk.shutdown().catch((err) => {
        log.warn(
          `Falha ao encerrar o tracing OTel: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    log.log(
      `Tracing OTel habilitado (serviço="${cfg.serviceName}", endpoint="${cfg.endpoint}").`,
    );
    return true;
  } catch (err) {
    // Pacotes ausentes ou init com falha: loga UMA vez e segue o boot.
    log.warn(
      `Tracing OTel desabilitado por falha de inicialização (pacotes ausentes ou erro de setup): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/** Reseta o estado interno — uso EXCLUSIVO de testes. */
export function __resetTracingForTests(): void {
  started = false;
}
