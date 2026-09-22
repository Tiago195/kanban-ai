import { Logger } from '@nestjs/common';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
} from './agent-runner.interface';
import {
  ControlBlockLineFilter,
  finalizeTurn,
} from './tanstack-marker-protocol';
import {
  buildIterationJsonSchema,
  finalizeSchemaTurn,
  type IterationSchemaOptions,
} from './tanstack-output-schema';
import type { AppConfig } from '../../../shared/config/config';

/**
 * US-F3.4 — `AgentRunner` implementado sobre o **TanStack AI** (`@tanstack/ai`).
 *
 * Primeiro runner do EP-F3 que NÃO spawna subprocesso: fala com um endpoint
 * OpenAI-compatível via `openaiCompatibleText` (`@tanstack/ai-openai/compatible`)
 * e consome o `chat()` como stream de eventos AG-UI.
 *
 * US-F3.9 — o MESMO runner passa a servir os kinds `claude`/`codex`/`gemini`
 * com o adapter OFICIAL de cada vendor (ver `TANSTACK_VENDORS` abaixo): o que
 * muda por vendor é só a construção do adapter (módulo, factory, credencial,
 * overrides de modelo/endpoint) — streaming/abort/idle/HITL/schema/usage são o
 * caminho único já fixado pelas F3.4–F3.8.
 *
 * US-F3.5 — o resultado da iteração vem de `outputSchema` (JSON Schema gerado
 * de um schema Zod; ver tanstack-output-schema.ts): o modelo emite um OBJETO
 * validado, não um bloco de texto. O protocolo de marcadores da US-F3.4
 * (tanstack-marker-protocol.ts) permanece como FALLBACK para respostas que não
 * são JSON (endpoint que ignora `response_format`) — é o que preserva a
 * paridade fixada no oráculo da US-F3.2 para o caminho degradado.
 *
 * Obrigações do contrato (mesmas do `CopilotCliRunner`, por outro meio):
 *  - streaming  → TEXT_MESSAGE_CONTENT vira `onChunk` kind 'output' (linha a
 *    linha, com supressão dos blocos de controle, como o bridge faz);
 *    REASONING/THINKING viram kind 'thought'.
 *  - abort      → `input.signal` aborta o fetch via AbortController e rejeita
 *    `Error('aborted')` (mesma mensagem do runner Copilot).
 *  - idle       → timeout de inatividade do stream (`streamIdleTimeoutMs`),
 *    mesma mensagem de erro do runner Copilot.
 *  - HITL       → bloco KANBAN_QUESTION bloqueia em `input.onQuestion` (modelo
 *    one-shot: a resposta é reinjetada via handoff na próxima iteração).
 *    US-F3.6 (ADR-0042): decidido MANTER este desenho (variante `question` do
 *    schema) em vez do interrupt nativo do TanStack — o interrupt só nasce de
 *    middleware/`needsApproval` (nunca da resposta do modelo) e só atravessa
 *    restart persistindo o histórico AG-UI, duplicando o que o par
 *    pergunta+resposta em `AgentMessage` + prompt auto-suficiente já cobrem.
 *  - fatalError → RUN_ERROR/exceção de transporte vira `fatalError` (BUG-A7:
 *    infra quebrada ≠ iteração normal; o orchestrator para o loop).
 *  - provider   → 'tanstack' na telemetria; tokens somados por `onUsage`
 *    (US-F3.7 — todas as chamadas ao provider, não só o RUN_FINISHED terminal;
 *    ver createTokenAccounting).
 *
 * SELEÇÃO/CONFIG: ativo somente com `AGENT_ADAPTER=tanstack` (desligado por
 * padrão — o default do processo segue `mock`, ADR-0014). Endpoint/modelo via
 * `TANSTACK_BASE_URL`/`TANSTACK_MODEL`; credencial opcional `TANSTACK_API_KEY`
 * lida do env aqui (nunca armazenada em config nem logada).
 *
 * CJS × ESM: `@tanstack/ai` é ESM-only (exports sem condição `require`) e a API
 * é CJS (`module: CommonJS`) — `require()` falha com ERR_PACKAGE_PATH_NOT_EXPORTED
 * mesmo no Node 22. Carregamos via `import()` dinâmico embrulhado em `new
 * Function` para o tsc não rebaixar o `import()` para `require()` (mesmo padrão
 * recomendado pelo NestJS para deps ESM-only). Efeito colateral desejado: o
 * módulo ESM só é carregado no PRIMEIRO `run()` — quem não usa o adapter não
 * paga nada.
 */

/**
 * Superfície mínima tipada dos módulos ESM carregados dinamicamente. Tipamos
 * localmente (em vez de `typeof import(...)`) por dois motivos: o subpath
 * `@tanstack/ai-openai/compatible` não resolve types sob `moduleResolution:
 * Node` (sem `typesVersions`), e o pacote é pre-1.0 — depender só da superfície
 * que consumimos isola a API instável.
 */
interface TanStackStreamChunk {
  type: string;
  delta?: string;
  message?: string;
  usage?: unknown;
  /** US-F3.5 — eventos CUSTOM (ex.: structured-output.complete). */
  name?: string;
  value?: unknown;
  /** US-F3.5 — código do RUN_ERROR (ex.: structured-output-parse-failed). */
  code?: string;
}
type TanStackChatFn = (
  options: Record<string, unknown>,
) => AsyncIterable<TanStackStreamChunk>;
/**
 * Factory de adapter carregada por vendor. Duas assinaturas convivem atrás do
 * mesmo tipo frouxo (tipagem local, ver comentário acima):
 *  - default `tanstack`: `openaiCompatibleText(model, { baseURL, apiKey })`;
 *  - vendors US-F3.9: `create*Chat(model, apiKey, config?)` (chave explícita).
 */
type AdapterFactoryFn = (...args: unknown[]) => unknown;
interface TanStackEsm {
  chat: TanStackChatFn;
  factory: AdapterFactoryFn;
}

/**
 * US-F3.9 — vendors de API servidos pelo MESMO `TanStackRunner`, cada um com o
 * adapter OFICIAL do seu wire (ADR-0036: `claude`/`codex`/`gemini` deixam de
 * cair no default com warning).
 *
 * Mapeamento decidido nesta história:
 *  - `claude` → `@tanstack/ai-anthropic` (`createAnthropicChat`): o wire da
 *    Anthropic é próprio (Messages API/SSE), o `openaiCompatibleText` não fala
 *    esse formato.
 *  - `codex`  → `@tanstack/ai-openai` (`createOpenaiChat`, Responses API), JÁ
 *    instalado. O kind foi declarado como "OpenAI Codex" = **API da OpenAI**
 *    (o registry checa OPENAI_API_KEY/CODEX_API_KEY desde o ADR-0036); o
 *    harness `@tanstack/ai-codex` embrulha a **CLI** do Codex (binário local +
 *    login ChatGPT) — outra coisa, fora do escopo. Responses API (e não chat
 *    completions) porque os modelos codex (gpt-*-codex) só existem nela.
 *  - `gemini` → `@tanstack/ai-gemini` (`createGeminiChat`): wire nativo do
 *    Google GenAI (structured output nativo por responseSchema; o endpoint
 *    "OpenAI-compatível" do Google é um shim beta e amarraria o kind à config
 *    do tanstack).
 *
 * Todos retornam `supportsCombinedToolsAndSchema` conforme o modelo (F3.8:
 * isso decide a qualidade do structured output); quando `false`, o engine cai
 * na finalização separada — os dois caminhos já são contabilizados pelo
 * `onUsage` (US-F3.7).
 *
 * Credencial: lida do env NA HORA do run (nunca armazenada em config/logs); as
 * envs e a ordem ESPELHAM `isAdapterAvailable` do registry (invariante de
 * segredo: lá só se checa PRESENÇA).
 */
export type TanStackVendorKind = 'claude' | 'codex' | 'gemini';

interface VendorSpec {
  /** Envs de credencial aceitas, em ordem de precedência. */
  credEnvs: readonly string[];
  /** Env de override do modelo (senão vale o modelo por-card do input). */
  modelEnv: string;
  /** Env de override do endpoint (proxy corporativo / fake dos specs). */
  baseUrlEnv: string;
  /** Módulo ESM do adapter oficial do vendor. */
  module: string;
  /** Nome da factory `create*Chat(model, apiKey, config?)`. */
  factoryName: string;
  /** Como o override de endpoint entra no config da factory (chave difere por SDK). */
  baseUrlConfig: (baseUrl: string) => Record<string, unknown>;
  /** US-F3.10 — padrão dos ids de modelo DESTE vendor (detecção de mismatch). */
  modelIdPattern: RegExp;
  /** US-F3.10 — exemplo legível de id válido, para a mensagem de erro. */
  modelIdHint: string;
}

export const TANSTACK_VENDORS: Record<TanStackVendorKind, VendorSpec> = {
  claude: {
    credEnvs: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    modelEnv: 'CLAUDE_MODEL',
    baseUrlEnv: 'CLAUDE_BASE_URL',
    module: '@tanstack/ai-anthropic',
    factoryName: 'createAnthropicChat',
    baseUrlConfig: (baseURL) => ({ baseURL }),
    modelIdPattern: /^claude[-.]/i,
    modelIdHint: 'claude-sonnet-4-5',
  },
  codex: {
    credEnvs: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    modelEnv: 'CODEX_MODEL',
    baseUrlEnv: 'CODEX_BASE_URL',
    module: '@tanstack/ai-openai',
    factoryName: 'createOpenaiChat',
    baseUrlConfig: (baseURL) => ({ baseURL }),
    modelIdPattern: /^(gpt-|o\d|codex|chatgpt)/i,
    modelIdHint: 'gpt-5.1-codex',
  },
  gemini: {
    credEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnv: 'GEMINI_MODEL',
    baseUrlEnv: 'GEMINI_BASE_URL',
    module: '@tanstack/ai-gemini',
    factoryName: 'createGeminiChat',
    // GoogleGenAIOptions: o endpoint vai em httpOptions.baseUrl (não baseURL).
    baseUrlConfig: (baseUrl) => ({ httpOptions: { baseUrl } }),
    modelIdPattern: /^gemini-/i,
    modelIdHint: 'gemini-2.5-pro',
  },
};

/**
 * US-F3.10 — aliases de modelo do DOMÍNIO (mundo Copilot/board: 'opus',
 * 'sonnet'…, incluindo o default do processo AGENT_DEFAULT_MODEL='opus').
 * Nenhum deles é id válido em API de vendor — mismatch garantido.
 */
const DOMAIN_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'auto', 'gpt']);

/**
 * US-F3.10 — detecção PURA de modelo × vendor incompatível (débito da F3.9).
 *
 * Só acusa mismatch CERTO — nunca chuta sobre id desconhecido:
 *  - modelo vazio → issue (vendor de API exige um id);
 *  - alias do domínio ('opus', 'sonnet'…) → issue (seria 404 no provider);
 *  - id no formato do catálogo Copilot/org (contém '/') → issue;
 *  - id que casa o padrão de OUTRO vendor (ex.: 'gemini-2.5-pro' no claude) →
 *    issue;
 *  - id que casa o padrão do PRÓPRIO vendor, ou id neutro/desconhecido → null
 *    (indeterminado: o provider é quem valida — validar mais que isso exigiria
 *    manter um catálogo vivo por vendor, com risco de drift e falso positivo).
 *
 * Retorna `null` quando ok/indeterminado, ou a PRIMEIRA linha legível do erro.
 */
export function vendorModelIssue(
  vendor: TanStackVendorKind,
  model: string,
): string | null {
  const spec = TANSTACK_VENDORS[vendor];
  const id = model.trim();
  if (!id) {
    return `O vendor "${vendor}" exige um id de modelo e nenhum foi resolvido.`;
  }
  if (spec.modelIdPattern.test(id)) return null;
  if (DOMAIN_MODEL_ALIASES.has(id.toLowerCase())) {
    return (
      `O modelo "${id}" é um alias do domínio (catálogo do board/Copilot), ` +
      `não um id da API do vendor "${vendor}".`
    );
  }
  if (id.includes('/')) {
    return (
      `O modelo "${id}" tem formato do catálogo Copilot/org, ` +
      `não um id da API do vendor "${vendor}".`
    );
  }
  const other = (Object.keys(TANSTACK_VENDORS) as TanStackVendorKind[]).find(
    (k) => k !== vendor && TANSTACK_VENDORS[k].modelIdPattern.test(id),
  );
  if (other) {
    return `O modelo "${id}" parece um id do vendor "${other}", não de "${vendor}".`;
  }
  return null; // indeterminado: deixa o provider decidir
}

/** `import()` dinâmico protegido do downlevel do tsc (module: CommonJS). */
const dynamicImport = new Function('s', 'return import(s)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

/**
 * Runner TanStack. NÃO é provider do Nest: o `AgentAdapterRegistry` o instancia
 * LAZY no primeiro `resolve('tanstack')` — com `AGENT_ADAPTER` ausente/mock,
 * esta classe nunca é instanciada (prova 1 da US-F3.4).
 */
export class TanStackRunner implements AgentRunner {
  /** US-F3.9 — id do runner = kind servido ('tanstack' ou o vendor). */
  readonly id: string;
  /** US-F3.5 — o buildPrompt NÃO ensina o formato de marcador para este runner. */
  readonly structuredOutput = true;
  private readonly logger = new Logger(TanStackRunner.name);
  /** Cache do carregamento ESM (uma vez por processo). */
  private esm?: Promise<TanStackEsm>;

  constructor(
    private readonly config: AppConfig,
    /** US-F3.9 — vendor de API; ausente = default OpenAI-compatível (F3.4). */
    private readonly vendor?: TanStackVendorKind,
  ) {
    this.id = vendor ?? 'tanstack';
  }

  private loadEsm(): Promise<TanStackEsm> {
    // US-F3.9 — o módulo/factory do vendor entram no MESMO carregamento lazy
    // da F3.4: quem não usa o adapter não paga o import ESM.
    const spec = this.vendor ? TANSTACK_VENDORS[this.vendor] : undefined;
    const module = spec?.module ?? '@tanstack/ai-openai/compatible';
    const factoryName = spec?.factoryName ?? 'openaiCompatibleText';
    this.esm ??= Promise.all([
      dynamicImport('@tanstack/ai'),
      dynamicImport(module),
    ]).then(([core, vendorMod]) => ({
      chat: core.chat as TanStackChatFn,
      factory: vendorMod[factoryName] as AdapterFactoryFn,
    }));
    return this.esm;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (input.signal?.aborted) throw new Error('aborted');

    const spec = this.vendor ? TANSTACK_VENDORS[this.vendor] : undefined;
    const { baseUrl, model: tanstackModel } = this.config.agent.tanstack ?? {
      baseUrl: '',
      model: '',
    };
    // US-F3.9 — credencial do vendor lida do env na hora do run (nunca em
    // config/log). Ausente = erro FATAL de config (BUG-A7), como o
    // TANSTACK_BASE_URL ausente abaixo — sem tocar a rede.
    let vendorApiKey = '';
    if (spec) {
      vendorApiKey =
        spec.credEnvs
          .map((name) => process.env[name]?.trim() ?? '')
          .find((v) => v.length > 0) ?? '';
      if (!vendorApiKey) {
        const envs = spec.credEnvs.join(' ou ');
        return {
          detail:
            `Credencial do vendor "${this.vendor}" não configurada. ` +
            `Defina ${envs} no ambiente da API.`,
          summary: `erro ao iniciar runner ${this.vendor}`,
          dodTouched: [],
          nextStep: `Configurar ${envs} no ambiente da API.`,
          done: false,
          provider: this.id,
          fatalError: `config: credencial ausente (${envs})`,
        };
      }
    } else if (!baseUrl) {
      // Infra não configurada = erro FATAL (BUG-A7): escala a humano e para o
      // loop em vez de queimar iterações com um endpoint inexistente.
      return {
        detail:
          'TANSTACK_BASE_URL não configurado. O adapter tanstack precisa de um ' +
          'endpoint OpenAI-compatível (ex.: http://host:porta/v1).',
        summary: 'erro ao iniciar TanStack runner',
        dodTouched: [],
        nextStep: 'Configurar TANSTACK_BASE_URL (e TANSTACK_MODEL) no ambiente da API.',
        done: false,
        provider: 'tanstack',
        fatalError: 'config: TANSTACK_BASE_URL ausente',
      };
    }

    // Modelo: override explícito do adapter (TANSTACK_MODEL / <VENDOR>_MODEL)
    // vence; senão o modelo resolvido por-card (que no provider precisa ser um
    // id real do vendor, não um alias do domínio).
    const configModel = spec
      ? (process.env[spec.modelEnv]?.trim() ?? '')
      : tanstackModel;
    const model = configModel || input.model;

    // US-F3.10 — fecha o débito da F3.9: um modelo por-card RECONHECIDAMENTE
    // incompatível com o vendor (alias do domínio como 'opus', ou id de OUTRO
    // vendor) vira erro FATAL legível AQUI, antes de tocar rede/ESM — em vez de
    // um 404 opaco do provider no meio do loop. O override <VENDOR>_MODEL é
    // escolha explícita do operador e NÃO passa por esta checagem (ele já vence
    // o modelo por-card de qualquer forma).
    if (this.vendor && spec && !configModel) {
      const issue = vendorModelIssue(this.vendor, model);
      if (issue) {
        return {
          detail:
            `${issue} Corrija o campo model do card (ou dos pais/board) para um ` +
            `id do vendor (ex.: ${spec.modelIdHint}), ou defina ${spec.modelEnv} ` +
            'no ambiente da API para forçar um modelo fixo.',
          summary: `modelo incompatível com o vendor ${this.vendor}`,
          dodTouched: [],
          nextStep: `Ajustar o modelo do card para um id do vendor ${this.vendor} (ex.: ${spec.modelIdHint}).`,
          done: false,
          provider: this.id,
          fatalError: `config: modelo "${model}" incompatível com o vendor ${this.vendor}`,
        };
      }
    }

    const { chat, factory } = await this.loadEsm();
    // US-F3.9 — constrói o adapter do vendor (chave explícita; endpoint só se
    // houver override — produção fala com o endpoint oficial do SDK).
    const vendorBaseUrl = spec ? (process.env[spec.baseUrlEnv]?.trim() ?? '') : '';
    const adapter = spec
      ? factory(
          model,
          vendorApiKey,
          vendorBaseUrl ? spec.baseUrlConfig(vendorBaseUrl) : undefined,
        )
      : factory(model, {
          baseURL: baseUrl,
          // Credencial opcional: endpoints locais/fake não exigem chave, mas o
          // client OpenAI exige string não-vazia. Nunca logada/armazenada.
          apiKey: process.env.TANSTACK_API_KEY || 'tanstack-no-key',
        });
    this.logger.log(
      `chat: adapter=${this.id}${spec ? '' : ` baseURL=${baseUrl}`} ` +
        `modelo=${model || '(default)'} phase=${input.phase}`,
    );

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort);

    // Timeout de inatividade do stream — mesma obrigação (e mensagem) do
    // CopilotCliRunner: se o provider ficar mudo além do limite, abortamos.
    const idleMs = this.config.agent.streamIdleTimeoutMs;
    let idleTimedOut = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, idleMs);
    };

    let text = '';
    let errText = '';
    let failed = false;
    // US-F3.7 — fallback: usage do chunk RUN_FINISHED terminal. Só é usado
    // quando o middleware onUsage não viu NENHUM evento (defesa contra um bump
    // da dependência que pare de disparar o hook). Ver comentário no
    // createTokenAccounting sobre por que o terminal sozinho conta errado.
    let usage: { inputTokens?: number; outputTokens?: number } = {};
    // US-F3.7 — contabilidade primária: soma de TODOS os eventos onUsage
    // (iterações do agent loop E a finalização do structured output).
    const accounting = createTokenAccounting();
    /** US-F3.5 — objeto final do `structured-output.complete` (quando o modelo casou JSON). */
    let structured: { object: unknown; raw: string } | undefined;
    const filter = new ControlBlockLineFilter((line) =>
      input.onChunk?.({ kind: 'output', delta: line }),
    );
    // US-F3.5 — com outputSchema os deltas TEXT_MESSAGE_CONTENT são JSON cru:
    // não podem vazar como 'output' (mesmo espírito da supressão dos blocos de
    // controle). Sniffer: primeira carga não-whitespace começando com '{' =
    // resposta estruturada → suprime; senão é prosa (endpoint que ignorou o
    // response_format) → streama pelo filtro de marcadores, como na US-F3.4.
    let streamMode: 'unknown' | 'json' | 'prose' = 'unknown';
    let sniffBuf = '';
    const pushOutput = (delta: string) => {
      if (streamMode === 'json') return;
      if (streamMode === 'prose') {
        filter.push(delta);
        return;
      }
      sniffBuf += delta;
      const head = sniffBuf.trimStart();
      if (head.length === 0) return;
      streamMode = head.startsWith('{') ? 'json' : 'prose';
      if (streamMode === 'prose') filter.push(sniffBuf);
      sniffBuf = '';
    };

    // US-F3.5 — condições por-iteração que moldam o schema (R3/R6-shape).
    const schemaOpts: IterationSchemaOptions = {
      proposeDod: input.proposeDod === true,
      structuredEvidence: this.config.agent.requireStructuredEvidence === true,
    };

    try {
      const stream = chat({
        adapter,
        messages: [{ role: 'user', content: input.prompt }],
        // US-F3.5 — JSON Schema PLANO (não o schema Zod: o conversor do
        // TanStack 0.52 exige Zod 4.2+; validamos nós mesmos no fechamento).
        // `stream: true` explícito: com outputSchema, sem ele o chat() vira
        // Promise e perderíamos streaming/idle/abort (conferido no .d.ts 0.52).
        outputSchema: buildIterationJsonSchema(schemaOpts),
        stream: true,
        abortController: controller,
        // Correlação AG-UI com a sessão da task (não dá memória conversacional
        // — o handoff/lastro do prompt segue sendo a memória, como no one-shot
        // do Copilot; a US-F3.6/ADR-0042 avaliou e DESCARTOU a sessão/interrupt
        // nativos — a retomada pós-restart continua vindo do banco + prompt).
        ...(input.cliSessionId ? { threadId: input.cliSessionId } : {}),
        // US-F3.7 — middleware de contabilidade de token (onUsage).
        middleware: [accounting.middleware],
        // Sem console noise nos specs/produção.
        debug: false,
      });

      resetIdle();
      for await (const chunk of stream) {
        resetIdle();
        switch (chunk.type) {
          case 'TEXT_MESSAGE_CONTENT': {
            const delta = chunk.delta ?? '';
            text += delta;
            pushOutput(delta);
            break;
          }
          // US-F3.5 — evento terminal do structured output: carrega o objeto
          // (já des-alargado de nulls pelo TanStack) e o texto JSON cru. No
          // caminho streaming o TanStack NÃO valida contra o schema — a
          // validação Zod (com o superRefine done⇒evidence) roda no
          // finalizeSchemaTurn abaixo.
          case 'CUSTOM': {
            if (chunk.name === 'structured-output.complete') {
              const v = chunk.value as { object?: unknown; raw?: string } | undefined;
              if (v && v.object !== undefined) {
                structured = { object: v.object, raw: typeof v.raw === 'string' ? v.raw : '' };
              }
            }
            break;
          }
          // Canal de raciocínio (deprecado THINKING_* e o novo REASONING_*):
          // vira chunk 'thought' — o Copilot não tem esse canal (lá o 'thought'
          // é heartbeat/prosa não-JSON); aqui é raciocínio real do modelo.
          case 'THINKING_TEXT_MESSAGE_CONTENT':
          case 'REASONING_MESSAGE_CONTENT': {
            if (chunk.delta) {
              input.onChunk?.({ kind: 'thought', delta: chunk.delta });
            }
            break;
          }
          case 'RUN_FINISHED': {
            usage = extractUsage(chunk.usage);
            break;
          }
          case 'RUN_ERROR': {
            // US-F3.5 — RUN_ERROR `structured-output-*` (parse do JSON falhou
            // etc.) NÃO é falha de infra: o modelo respondeu, só não casou o
            // JSON. Cai no fallback de marcador com `failed=false`, preservando
            // a paridade da US-F3.4 (inclusive os degenerados do oráculo).
            if (chunk.code?.startsWith('structured-output-')) {
              this.logger.warn(
                `structured output não materializou (${chunk.code}): ${chunk.message ?? ''} — fallback de marcador`,
              );
              break;
            }
            // Equivalente ao exit != 0 do subprocesso: registramos e deixamos o
            // finalizeTurn decidir entre iteração inconclusa e fatalError.
            failed = true;
            errText = chunk.message ?? 'RUN_ERROR sem mensagem';
            this.logger.warn(`RUN_ERROR do TanStack: ${errText}`);
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      // Abort (stop hard) NUNCA vira fatalError — propaga como no Copilot.
      if (input.signal?.aborted && !idleTimedOut) throw new Error('aborted');
      if (idleTimedOut) throw new Error(`stream idle timeout (${idleMs}ms)`);
      // Exceção inesperada do transporte = infra quebrada (espírito do
      // main().catch do bridge): fatalError, não iteração normal.
      const message = err instanceof Error ? err.message : String(err);
      return {
        detail: `Erro inesperado no TanStack runner: ${message}`,
        summary: 'erro no TanStack runner',
        dodTouched: [],
        nextStep: '',
        done: false,
        provider: this.id,
        fatalError: `${this.id}: ${message}`.slice(0, 240),
      };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      input.signal?.removeEventListener('abort', onAbort);
    }

    // O abort encerra o stream SEM lançar (comportamento observado do chat());
    // detectamos pelos sinais após o loop.
    if (input.signal?.aborted) throw new Error('aborted');
    if (idleTimedOut) throw new Error(`stream idle timeout (${idleMs}ms)`);

    filter.flush();

    // US-F3.5 — caminho principal: objeto estruturado validado pelo schema Zod.
    // Sem objeto (resposta não-JSON/endpoint não-conforme), o protocolo de
    // marcadores da US-F3.4 continua valendo como fallback (paridade F3.2).
    const finalization = structured
      ? finalizeSchemaTurn(structured.object, structured.raw, schemaOpts)
      : finalizeTurn(text, errText, failed);
    const { question, result } = finalization;
    if (structured) {
      const issues = (finalization as { schemaIssues?: string[] }).schemaIssues;
      if (issues?.length) {
        this.logger.warn(`resultado rejeitado pelo schema da iteração: ${issues.join(' | ')}`);
      }
      // O transcript não vê os deltas de JSON (suprimidos acima); emitimos o
      // summary como a linha de 'output' do turno para a UI não ficar muda.
      input.onChunk?.({ kind: 'output', delta: result.summary });
    }
    if (question) {
      if (!input.onQuestion) {
        this.logger.warn(`pergunta ignorada (sem onQuestion): ${question.prompt}`);
      } else {
        // HITL bloqueante (mesma semântica do CopilotCliRunner no modelo
        // one-shot): aguarda a resposta humana; ela é reinjetada no prompt da
        // PRÓXIMA iteração via handoff. Rejeição (timeout/abort do HITL)
        // propaga e encerra a iteração, como no runner Copilot.
        await input.onQuestion({
          id: `q-${Date.now()}`,
          prompt: question.prompt,
          options: question.options,
        });
      }
    }

    // Backfill de telemetria (paridade com o backfill do rodapé no Copilot).
    // US-F3.7 — a soma do onUsage é a fonte primária (cobre TODAS as chamadas
    // ao provider, não só a última); o usage do RUN_FINISHED terminal fica como
    // fallback para o caso do hook não ter disparado nenhuma vez. Só cria a
    // chave quando há valor (ausência = campo ausente, como no bridge).
    const totals = accounting.events > 0 ? accounting.totals() : usage;
    if (result.inputTokens === undefined && totals.inputTokens !== undefined) {
      result.inputTokens = totals.inputTokens;
    }
    if (result.outputTokens === undefined && totals.outputTokens !== undefined) {
      result.outputTokens = totals.outputTokens;
    }
    // US-F3.9 — telemetria por kind servido ('tanstack' ou o vendor).
    result.provider = this.id;
    return result;
  }
}

/**
 * US-F3.7 — Contabilidade de token por `onUsage`.
 *
 * POR QUÊ o middleware, e não o `usage` do RUN_FINISHED terminal: fixado na
 * spec de caracterização (tanstack.runner.usage.spec.ts) contra o TanStack
 * 0.52 —
 *  - num run multi-iteração (agent loop com tool calls), o `usage` do
 *    RUN_FINISHED público (e o `info.usage` do onFinish) reflete SOMENTE a
 *    ÚLTIMA chamada ao provider — as iterações anteriores somem da conta;
 *  - no caminho de finalização separada do structured output, o `info.usage`
 *    terminal reflete o agent loop e NÃO o passo de finalização (num run sem
 *    tools ele é `undefined`);
 *  - `onUsage` dispara UMA vez por chamada ao provider que reporta usage —
 *    iterações do agent loop E a finalização (`ctx.phase==='structuredOutput'`)
 *    — e o engine normaliza a forma array (SpecTokenUsage) para `TokenUsage`
 *    antes do hook. A SOMA dos eventos é o total correto.
 *
 * MODO NATIVO COMBINADO (o caso do `openaiCompatibleText` hoje — a F3.5
 * confirmou `supportsCombinedToolsAndSchema() → true`): o JSON estruturado sai
 * de uma iteração normal do agent loop, sem chamada extra de finalização. Num
 * run sem tools isso significa UMA chamada e soma == terminal; a divergência
 * aparece assim que houver mais de uma chamada (tools, F3.3/F3.10) ou um
 * adapter sem suporte nativo (finalização separada, F3.8+).
 */
export interface TokenAccounting {
  /** Middleware `ChatMiddleware`-shaped para passar no `chat()`. */
  middleware: Record<string, unknown>;
  /** Quantos eventos onUsage com tokens foram vistos. */
  events: number;
  /** Soma acumulada; campo ausente = nenhum evento reportou aquele lado. */
  totals(): { inputTokens?: number; outputTokens?: number };
}

export function createTokenAccounting(): TokenAccounting {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const acc: TokenAccounting = {
    events: 0,
    totals: () => ({
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    }),
    middleware: {
      name: 'us-f3.7-token-accounting',
      // Hook sequencial e aguardado pelo engine; nunca lança (só aritmética
      // sobre valores já validados pelo extractUsage).
      onUsage: (_ctx: unknown, usage: unknown) => {
        const u = extractUsage(usage);
        if (u.inputTokens === undefined && u.outputTokens === undefined) return;
        acc.events += 1;
        if (u.inputTokens !== undefined) {
          inputTokens = (inputTokens ?? 0) + u.inputTokens;
        }
        if (u.outputTokens !== undefined) {
          outputTokens = (outputTokens ?? 0) + u.outputTokens;
        }
      },
    },
  };
  return acc;
}

/**
 * Extrai tokens de um `usage` do TanStack. Aceita as DUAS formas do wire
 * AG-UI (`RUN_FINISHED.usage: Array<SpecTokenUsage> | TokenUsage`):
 *  - objeto `TokenUsage` (promptTokens/completionTokens) — o que o endpoint
 *    compatível emite e o que o onUsage entrega (já normalizado pelo engine);
 *  - US-F3.7 — array `SpecTokenUsage` (inputTokens/outputTokens por entrada),
 *    débito deixado pela F3.4: aparece em streams re-serializados pelo spec
 *    AG-UI; soma as entradas válidas. Ausência de campo = campo ausente.
 * Exportada para a spec fixar as duas formas.
 */
export function extractUsage(usage: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!usage || typeof usage !== 'object') return {};
  const out: { inputTokens?: number; outputTokens?: number } = {};
  if (Array.isArray(usage)) {
    for (const item of usage) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.inputTokens === 'number' && Number.isFinite(rec.inputTokens)) {
        out.inputTokens = (out.inputTokens ?? 0) + rec.inputTokens;
      }
      if (typeof rec.outputTokens === 'number' && Number.isFinite(rec.outputTokens)) {
        out.outputTokens = (out.outputTokens ?? 0) + rec.outputTokens;
      }
    }
    return out;
  }
  const rec = usage as Record<string, unknown>;
  if (typeof rec.promptTokens === 'number' && Number.isFinite(rec.promptTokens)) {
    out.inputTokens = rec.promptTokens;
  }
  if (
    typeof rec.completionTokens === 'number' &&
    Number.isFinite(rec.completionTokens)
  ) {
    out.outputTokens = rec.completionTokens;
  }
  return out;
}
