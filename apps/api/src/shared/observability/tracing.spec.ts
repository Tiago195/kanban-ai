import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveTracingConfig,
  initTracing,
  __resetTracingForTests,
  DEFAULT_SERVICE_NAME,
  OTEL_ENDPOINT_ENV,
  type OtelModules,
} from './tracing';

function makeLog(): {
  log: { warn: (m: string) => void; log: (m: string) => void };
  warns: string[];
  logs: string[];
} {
  const warns: string[] = [];
  const logs: string[] = [];
  return {
    log: { warn: (m) => warns.push(m), log: (m) => logs.push(m) },
    warns,
    logs,
  };
}

test('resolveTracingConfig: sem endpoint → disabled, zero overhead', () => {
  const cfg = resolveTracingConfig({});
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.endpoint, '');
  assert.strictEqual(cfg.serviceName, DEFAULT_SERVICE_NAME);
});

test('resolveTracingConfig: endpoint em branco (só espaços) → disabled', () => {
  const cfg = resolveTracingConfig({ [OTEL_ENDPOINT_ENV]: '   ' });
  assert.strictEqual(cfg.enabled, false);
});

test('resolveTracingConfig: endpoint presente → enabled + service name custom', () => {
  const cfg = resolveTracingConfig({
    [OTEL_ENDPOINT_ENV]: 'http://collector:4318/v1/traces',
    OTEL_SERVICE_NAME: 'my-svc',
  });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.endpoint, 'http://collector:4318/v1/traces');
  assert.strictEqual(cfg.serviceName, 'my-svc');
});

test('initTracing: no-op quando OTEL endpoint não está setado (sem import OTel)', async () => {
  __resetTracingForTests();
  const prev = process.env[OTEL_ENDPOINT_ENV];
  delete process.env[OTEL_ENDPOINT_ENV];

  const { log, warns, logs } = makeLog();
  let imported = false;

  const started = await initTracing({
    log,
    importOtel: async () => {
      imported = true;
      throw new Error('não deveria importar quando desligado');
    },
  });

  assert.strictEqual(started, false, 'não deve iniciar quando desligado');
  assert.strictEqual(imported, false, 'não deve chamar o import dinâmico do OTel');
  assert.strictEqual(warns.length, 0, 'não deve logar warnings quando desligado');
  assert.strictEqual(logs.length, 0, 'não deve logar nada quando desligado');

  if (prev !== undefined) process.env[OTEL_ENDPOINT_ENV] = prev;
});

test('initTracing: pacote ausente (import lança) → loga UMA vez e não quebra', async () => {
  __resetTracingForTests();
  const prev = process.env[OTEL_ENDPOINT_ENV];
  process.env[OTEL_ENDPOINT_ENV] = 'http://collector:4318/v1/traces';

  const { log, warns, logs } = makeLog();

  const started = await initTracing({
    log,
    importOtel: async () => {
      throw new Error("Cannot find module '@opentelemetry/sdk-node'");
    },
  });

  assert.strictEqual(started, false, 'falha graciosa retorna false, não lança');
  assert.strictEqual(warns.length, 1, 'deve logar exatamente UM warning');
  assert.match(warns[0], /Tracing OTel desabilitado/);
  assert.strictEqual(logs.length, 0);

  if (prev === undefined) delete process.env[OTEL_ENDPOINT_ENV];
  else process.env[OTEL_ENDPOINT_ENV] = prev;
});

test('initTracing: ramo habilitado com SDK mockado inicia e é idempotente', async () => {
  __resetTracingForTests();
  const prev = process.env[OTEL_ENDPOINT_ENV];
  process.env[OTEL_ENDPOINT_ENV] = 'http://collector:4318/v1/traces';

  const { log, warns, logs } = makeLog();

  let startCount = 0;
  let autoInstrCfg: Record<string, unknown> | undefined;

  const fakeOtel: OtelModules = {
    NodeSDK: class {
      constructor(_cfg: Record<string, unknown>) {}
      start(): void {
        startCount += 1;
      }
      async shutdown(): Promise<void> {}
    },
    OTLPTraceExporter: class {
      constructor(_cfg: Record<string, unknown>) {}
    },
    getNodeAutoInstrumentations: (cfg: Record<string, unknown>) => {
      autoInstrCfg = cfg;
      return {};
    },
    Resource: class {
      attrs: Record<string, unknown>;
      constructor(attrs: Record<string, unknown>) {
        this.attrs = attrs;
      }
    },
    ATTR_SERVICE_NAME: 'service.name',
  };

  const started = await initTracing({ log, importOtel: async () => fakeOtel });
  assert.strictEqual(started, true);
  assert.strictEqual(startCount, 1, 'sdk.start deve ser chamado uma vez');
  assert.strictEqual(warns.length, 0);
  assert.strictEqual(logs.length, 1, 'deve logar a habilitação uma vez');

  // fs/dns/net devem estar desligados no escopo API-side.
  assert.deepStrictEqual(autoInstrCfg?.['@opentelemetry/instrumentation-fs'], {
    enabled: false,
  });
  assert.deepStrictEqual(autoInstrCfg?.['@opentelemetry/instrumentation-dns'], {
    enabled: false,
  });
  assert.deepStrictEqual(autoInstrCfg?.['@opentelemetry/instrumentation-net'], {
    enabled: false,
  });

  // Idempotência: segunda chamada não reinicia o SDK.
  const again = await initTracing({ log, importOtel: async () => fakeOtel });
  assert.strictEqual(again, true);
  assert.strictEqual(startCount, 1, 'não deve reiniciar o SDK numa segunda chamada');

  __resetTracingForTests();
  if (prev === undefined) delete process.env[OTEL_ENDPOINT_ENV];
  else process.env[OTEL_ENDPOINT_ENV] = prev;
});
