import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, realpathSync, readlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AgentModel } from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';

/** Subconjunto do ModelInfo do copilot-sdk que nos interessa. */
interface SdkModelInfo {
  id: string;
  name?: string;
}

/** Superficie minima do CopilotClient do copilot-sdk usada aqui. */
interface SdkCopilotClient {
  start(): Promise<void>;
  listModels(): Promise<SdkModelInfo[]>;
  stop(): Promise<unknown>;
}
/** Superficie minima do RuntimeConnection do copilot-sdk usada aqui. */
interface SdkRuntimeConnection {
  forStdio(options: { path: string }): unknown;
}
interface SdkModule {
  CopilotClient: new (options?: unknown) => SdkCopilotClient;
  RuntimeConnection?: SdkRuntimeConnection;
}

/**
 * Catalogo de modelos de AI disponiveis para o login atual do Copilot CLI.
 *
 * O Copilot CLI NAO expoe um comando nao-interativo dedicado para listar
 * modelos (o `/model` e TUI). Porem o pacote instalado do Copilot CLI embute o
 * **copilot-sdk**, cujo `CopilotClient.listModels()` retorna exatamente o mesmo
 * catalogo do menu `/model` — incluindo os modelos custom da org (ex.: os
 * `uol-inc/*` e `uol-universo-online/*`). A lista e **descoberta
 * automaticamente** por ai, sem configuracao manual e para qualquer login.
 *
 * O SDK e localizado a partir do binario `copilot` resolvido no PATH (ele vive
 * em `<pkg>/copilot-sdk/index.js`), entao nao adicionamos dependencia npm.
 *
 * IMPORTANTE (auth): a descoberta roda em um processo filho nao-interativo, que
 * normalmente NAO consegue reusar o login do CLI (o token fica so em memoria do
 * processo interativo, nao no credential store acessivel ao filho). Para a
 * descoberta funcionar, exponha um token no ambiente da API — precedencia:
 * COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN (v2 PAT com permissao
 * "Copilot Requests", ou OAuth token do app Copilot/gh com acesso a Copilot).
 * Sem token valido, cai no fallback embutido (ou nos overrides abaixo).
 *
 * IMPORTANTE (versao da CLI): o copilot-sdk, por padrao, spawna a CLI *bundled*
 * no pacote npm — que costuma ser uma versao mais antiga e pode REJEITAR PATs
 * fine-grained na validacao do token. Por isso apontamos o SDK para o binario
 * NATIVO da plataforma (<pkg>/node_modules/@github/copilot-<plat>-<arch>/copilot),
 * a mesma CLI que o usuario roda, via RuntimeConnection.forStdio.
 *
 * Ordem de precedencia na resolucao:
 *   1. env AGENT_MODELS (JSON: [{"id","label"}, ...] ou ["id", ...]) — override;
 *   2. arquivo ~/.copilot/models.json (mesmo formato) — override manual;
 *   3. descoberta automatica via copilot-sdk (`CopilotClient.listModels()`);
 *   4. fallback embutido (ids validados) — so quando tudo acima falha.
 *
 * O default do CLI vem de ~/.copilot/settings.json ("model"), usado para marcar
 * qual e o primeiro/preferido quando presente.
 */
@Injectable()
export class ModelsService implements OnModuleInit {
  private readonly logger = new Logger(ModelsService.name);
  private cache: AgentModel[] | null = null;
  private discovering: Promise<AgentModel[] | null> | null = null;

  /** Timeout da descoberta via CLI. Configuravel por AGENT_MODELS_DISCOVERY_TIMEOUT_MS. */
  private readonly discoveryTimeoutMs = Number(
    process.env.AGENT_MODELS_DISCOVERY_TIMEOUT_MS ?? 120_000,
  );

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Fallback embutido: usado apenas se todas as fontes acima falharem. */
  private static readonly FALLBACK: AgentModel[] = [
    {
      id: 'uol-inc/AWS_Bedrock/anthropic.claude-opus-4-8',
      label: 'Claude Opus 4.8 BR',
    },
    { id: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ];

  /**
   * Dispara a descoberta automatica no boot para popular o cache antes da
   * primeira requisicao HTTP (sem bloquear o boot).
   */
  onModuleInit(): void {
    void this.ensureDiscovered();
  }

  /**
   * Lista os modelos disponiveis. Enquanto a descoberta assincrona nao termina,
   * responde com overrides sincronos (env/arquivo) ou o fallback embutido —
   * assim o endpoint nunca bloqueia. O cache e substituido pela lista completa
   * assim que a descoberta conclui.
   */
  list(): AgentModel[] {
    if (this.cache) return this.cache;

    // Overrides sincronos tem prioridade e nao exigem a descoberta.
    const override = this.readOverrides();
    if (override) {
      this.cache = this.withCliDefaultFirst(override);
      return this.cache;
    }

    // Ainda descobrindo: responde com fallback e dispara a descoberta.
    void this.ensureDiscovered();
    return this.withCliDefaultFirst([...ModelsService.FALLBACK]);
  }

  /** Id do modelo default do quadro quando o board nao tem um definido. */
  defaultModelId(): string {
    const fromSettings = this.readCliDefault();
    if (fromSettings) return fromSettings;
    const list = this.list();
    return list[0]?.id ?? ModelsService.FALLBACK[0].id;
  }

  /** True se `id` esta no catalogo conhecido. */
  isKnown(id: string | null | undefined): boolean {
    if (!id) return false;
    return this.list().some((m) => m.id === id);
  }

  /** Overrides sincronos (env AGENT_MODELS, depois ~/.copilot/models.json). */
  private readOverrides(): AgentModel[] | null {
    const fromEnv = this.parse(process.env.AGENT_MODELS, 'env AGENT_MODELS');
    if (fromEnv?.length) return fromEnv;
    const fromFile = this.readFile();
    if (fromFile?.length) return fromFile;
    return null;
  }

  /**
   * Garante que a descoberta rode uma unica vez; ao concluir, popula o cache
   * com a lista completa (ou mantem o fallback se falhar).
   */
  private async ensureDiscovered(): Promise<void> {
    if (this.cache) return;

    // Overrides substituem a descoberta.
    const override = this.readOverrides();
    if (override) {
      this.cache = this.withCliDefaultFirst(override);
      return;
    }

    if (!this.discovering) {
      this.discovering = this.discoverViaCli();
    }
    const discovered = await this.discovering;
    this.discovering = null;

    if (discovered?.length) {
      this.cache = this.withCliDefaultFirst(discovered);
      this.logger.log(
        `catalogo de modelos (descoberto via CLI): ${this.cache.length} modelo(s) [${this.cache
          .map((m) => m.id)
          .join(', ')}]`,
      );
    } else if (!this.cache) {
      // Nao fixa o cache aqui: mantem o fallback "volatil" para permitir nova
      // tentativa em requisicoes futuras (ex.: CLI ainda inicializando).
      this.logger.warn(
        'descoberta de modelos via CLI falhou; usando fallback embutido',
      );
    }
  }

  /**
   * Descobre os modelos disponiveis via copilot-sdk (`CopilotClient.listModels`).
   * Retorna o mesmo catalogo do menu `/model`, incluindo modelos custom da org.
   * Funciona para qualquer login autenticado no Copilot CLI.
   */
  private async discoverViaCli(): Promise<AgentModel[] | null> {
    let sdk: SdkModule;
    try {
      sdk = await this.loadSdk();
    } catch (e) {
      this.logger.warn(
        `copilot-sdk indisponivel para descoberta de modelos: ${(e as Error).message}`,
      );
      return null;
    }

    let client: SdkCopilotClient | null = null;
    let timer: NodeJS.Timeout | null = null;
    try {
      // O subprocesso do SDK precisa autenticar para listar modelos. Em um
      // processo filho (nao-interativo) o auto-login pelo credential store
      // frequentemente NAO funciona, entao passamos um token explicito quando
      // disponivel no ambiente (mesma precedencia do `copilot login`:
      // COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN). Sem token, tentamos o
      // auto-login (useLoggedInUser) como best-effort.
      const token = this.resolveGithubToken();

      // O copilot-sdk, por padrao, spawna a CLI *bundled* no pacote npm
      // (frequentemente uma versao antiga que rejeita PATs fine-grained na
      // validacao do token). A CLI *nativa* (binario da plataforma em
      // node_modules/@github/copilot-<plat>-<arch>/copilot) e a mesma que o
      // usuario roda e autentica o PAT corretamente. Quando encontramos esse
      // binario, forcamos o SDK a usa-lo via RuntimeConnection.forStdio.
      const nativeCli = this.resolveNativeCliPath();
      const connection =
        nativeCli && typeof sdk.RuntimeConnection?.forStdio === 'function'
          ? sdk.RuntimeConnection.forStdio({ path: nativeCli })
          : undefined;

      const options: Record<string, unknown> = {};
      if (token) options.gitHubToken = token;
      if (connection) options.connection = connection;
      client = new sdk.CopilotClient(options);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout ${this.discoveryTimeoutMs}ms`)),
          this.discoveryTimeoutMs,
        );
      });

      const c = client;
      const run = (async (): Promise<AgentModel[] | null> => {
        await c.start();
        const models = await c.listModels();
        return this.mapSdkModels(models);
      })();

      return await Promise.race([run, timeout]);
    } catch (e) {
      const msg = (e as Error).message;
      const authHint = /not authenticated/i.test(msg)
        ? ' (defina COPILOT_GITHUB_TOKEN, GH_TOKEN ou GITHUB_TOKEN no ambiente da API para habilitar a descoberta)'
        : '';
      this.logger.warn(`erro ao descobrir modelos via SDK: ${msg}${authHint}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      if (client) {
        try {
          await client.stop();
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /** Converte ModelInfo[] do SDK em AgentModel[], filtrando o pseudo "auto". */
  private mapSdkModels(models: SdkModelInfo[]): AgentModel[] | null {
    const mapped = models
      .filter((m) => m && typeof m.id === 'string' && m.id && m.id !== 'auto')
      .map((m): AgentModel => ({ id: m.id, label: m.name?.trim() || m.id }));
    return mapped.length ? mapped : null;
  }

  /**
   * Carrega o copilot-sdk embutido no pacote do binario `copilot` resolvido no
   * PATH (`<pkg>/copilot-sdk/index.js`). O SDK e ESM, entao usamos import()
   * dinamico. Cacheia o modulo resolvido.
   */
  private async loadSdk(): Promise<SdkModule> {
    const sdkPath = this.resolveSdkPath();
    // O SDK e ESM. Sob `module: CommonJS`, o TS reescreveria `import()` para
    // `require()` (ERR_REQUIRE_ESM). Usamos um dynamic import "cru" via Function
    // para preservar o import() nativo do runtime.
    const dynamicImport = new Function(
      'p',
      'return import(p);',
    ) as (p: string) => Promise<unknown>;
    const url = pathToFileURL(sdkPath).href;
    const mod = (await dynamicImport(url)) as SdkModule;
    if (typeof mod.CopilotClient !== 'function') {
      throw new Error('CopilotClient nao encontrado no copilot-sdk');
    }
    return mod;
  }

  /**
   * Resolve um token GitHub/Copilot do ambiente para autenticar a descoberta
   * via SDK. Mesma ordem de precedencia do `copilot login`.
   */
  private resolveGithubToken(): string | null {
    const candidates = [
      process.env.COPILOT_GITHUB_TOKEN,
      process.env.GH_TOKEN,
      process.env.GITHUB_TOKEN,
    ];
    for (const t of candidates) {
      const v = t?.trim();
      if (v) return v;
    }
    return null;
  }

  /**
   * Localiza o index.js do copilot-sdk a partir do binario `copilot`.
   * Tenta multiplos layouts para ser robusto a symlinks/wrappers:
   *   - <realpath(bin)>/../copilot-sdk/index.js  (bin no diretorio do pacote)
   *   - resolve o pacote @github/copilot subindo a arvore ate node_modules.
   */
  private resolveSdkPath(): string {
    const command = this.config.agent.cliCommand || 'copilot';
    const binPath = this.whichSync(command);
    if (!binPath) {
      throw new Error(`binario '${command}' nao encontrado no PATH`);
    }

    // realpathSync pode falhar (bin inexistente/permissao); protege e usa o
    // proprio binPath como base nesse caso. Alem disso, lemos o alvo do symlink
    // manualmente (readlinkSync) como reforco, pois em alguns ambientes o
    // realpathSync nao resolve o link como esperado.
    let resolvedBin = binPath;
    try {
      resolvedBin = realpathSync(binPath);
    } catch {
      /* usa binPath cru */
    }

    const candidates = this.sdkPathCandidates(binPath, resolvedBin);
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new Error(
      `copilot-sdk nao encontrado; tentado: ${candidates.join(', ')}`,
    );
  }

  /**
   * Gera candidatos de localizacao do copilot-sdk. Combina varias estrategias
   * para ser robusto a symlinks/wrappers e a ambientes onde o realpath do PATH
   * nao resolve como esperado (ex.: API spawnada pelo loop engine):
   *   - a partir do binario resolvido (realpath) e do binario cru;
   *   - lendo o alvo do symlink manualmente (readlinkSync);
   *   - a partir do prefixo de instalacao do Node (process.execPath), que no
   *     nvm aponta para <prefix>/lib/node_modules/@github/copilot/...
   */
  private sdkPathCandidates(binPath: string, resolvedBin: string): string[] {
    const out: string[] = [];
    const push = (p: string): void => {
      if (p && !out.includes(p)) out.push(p);
    };
    const SDK = ['copilot-sdk', 'index.js'];

    // Reune bases plausiveis onde o pacote @github/copilot pode estar.
    const bases = new Set<string>();
    bases.add(dirname(resolvedBin));
    bases.add(dirname(binPath));

    // Alvo do symlink resolvido manualmente (reforco ao realpathSync).
    try {
      let link = readlinkSync(binPath);
      if (!link.startsWith('/')) link = join(dirname(binPath), link);
      bases.add(dirname(link));
    } catch {
      /* nao e symlink ou falhou: ignora */
    }

    // Prefixo do Node: <prefix>/bin/node -> pacotes globais em
    // <prefix>/lib/node_modules. Cobre o layout do nvm mesmo quando o PATH
    // aponta para outro `copilot`.
    try {
      const nodePrefix = dirname(dirname(process.execPath)); // .../vX
      push(
        join(nodePrefix, 'lib', 'node_modules', '@github', 'copilot', ...SDK),
      );
    } catch {
      /* ignora */
    }

    // Para cada base, tenta o sdk irmao e sobe a arvore procurando o pacote.
    for (const base of bases) {
      push(join(base, ...SDK));
      let dir = base;
      for (let i = 0; i < 10; i++) {
        push(join(dir, '@github', 'copilot', ...SDK));
        push(join(dir, 'node_modules', '@github', 'copilot', ...SDK));
        if (dir.endsWith(join('@github', 'copilot'))) {
          push(join(dir, ...SDK));
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return out;
  }

  /**
   * Localiza o binario NATIVO da CLI do Copilot (o mesmo que o usuario roda),
   * que autentica o token corretamente. O pacote npm @github/copilot embute a
   * CLI como binario de plataforma em:
   *   <pkg>/node_modules/@github/copilot-<platform>-<arch>/copilot
   * Retorna null se nao encontrar (ai o SDK usa sua CLI bundled como fallback).
   */
  private resolveNativeCliPath(): string | null {
    let sdkPath: string;
    try {
      sdkPath = this.resolveSdkPath();
    } catch {
      return null;
    }
    // <pkg>/copilot-sdk/index.js -> <pkg>
    const pkgDir = dirname(dirname(sdkPath));
    const plat = this.nativePlatformTags();
    const arch = process.arch; // ex.: x64, arm64
    const binName = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
    for (const p of plat) {
      const candidate = join(
        pkgDir,
        'node_modules',
        '@github',
        `copilot-${p}-${arch}`,
        binName,
      );
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Tags de plataforma do pacote nativo (musl antes de glibc no Linux). */
  private nativePlatformTags(): string[] {
    if (process.platform === 'linux') return ['linuxmusl', 'linux'];
    if (process.platform === 'win32') return ['win32'];
    if (process.platform === 'darwin') return ['darwin'];
    return [process.platform];
  }

  /** Equivalente a `which`: resolve o caminho absoluto do binario no PATH. */
  private whichSync(command: string): string | null {
    // Caminho absoluto/relativo explicito: usa direto se existir.
    if (command.includes('/') || command.includes('\\')) {
      return existsSync(command) ? command : null;
    }
    const finder = process.platform === 'win32' ? 'where' : 'which';
    try {
      const out = execFileSync(finder, [command], { encoding: 'utf8' });
      const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
      return first ? first.trim() : null;
    } catch {
      return null;
    }
  }

  private readFile(): AgentModel[] | null {
    const path = join(homedir(), '.copilot', 'models.json');
    if (!existsSync(path)) return null;
    try {
      return this.parse(readFileSync(path, 'utf8'), path);
    } catch (e) {
      this.logger.warn(`falha ao ler ${path}: ${(e as Error).message}`);
      return null;
    }
  }

  private parse(raw: string | undefined, source: string): AgentModel[] | null {
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as unknown;
      if (!Array.isArray(data)) return null;
      const models = data
        .map((item): AgentModel | null => {
          if (typeof item === 'string') return { id: item, label: item };
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            const id = typeof o.id === 'string' ? o.id : null;
            if (!id) return null;
            const label = typeof o.label === 'string' ? o.label : id;
            return { id, label };
          }
          return null;
        })
        .filter((m): m is AgentModel => m !== null);
      return models.length ? models : null;
    } catch (e) {
      this.logger.warn(`falha ao parsear ${source}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Le o modelo default do Copilot CLI em ~/.copilot/settings.json. */
  private readCliDefault(): string | null {
    const path = join(homedir(), '.copilot', 'settings.json');
    if (!existsSync(path)) return null;
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return typeof o.model === 'string' ? o.model : null;
    } catch {
      return null;
    }
  }

  /**
   * Garante que o default do CLI (se conhecido) apareca primeiro na lista, e o
   * inclui caso nao esteja presente.
   */
  private withCliDefaultFirst(models: AgentModel[]): AgentModel[] {
    const def = this.readCliDefault();
    if (!def) return models;
    const existing = models.find((m) => m.id === def);
    const rest = models.filter((m) => m.id !== def);
    // Se o default nao veio da fonte, tenta um label amigavel do fallback.
    const fromFallback = ModelsService.FALLBACK.find((m) => m.id === def);
    const head = existing ?? fromFallback ?? { id: def, label: def };
    return [head, ...rest];
  }
}
