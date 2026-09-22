import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AgentAdapterDescriptor, AgentAdapterKind } from '@kanban-ai/shared';
import type { AgentRunner } from './agent-runner.interface';
import { CopilotCliRunner } from './copilot-cli.runner';
import { MockAgentRunner } from './mock-agent.runner';
import { TanStackRunner } from './tanstack.runner';
import {
  AGENT_ADAPTER_KINDS,
  APP_CONFIG,
  DEFAULT_AGENT_ADAPTER,
  type AppConfig,
} from '../../../shared/config/config';

/**
 * US-OBS4 — Registry de adapters multi-agente (ADR-0036).
 *
 * Mapeia cada `AgentAdapterKind` para o `AgentRunner` que o implementa e resolve
 * o runner ativo a partir de `config.agentAdapter` (env `AGENT_ADAPTER`),
 * mantendo `copilot-cli` como DEFAULT (não-regressão). O contrato `AgentRunner`
 * NÃO muda: o orchestrator segue injetando o token `AGENT_RUNNER` e chamando
 * `run(...)` — a escolha do vendor é resolvida aqui, atrás do token.
 *
 * `listDescriptors()` computa `available` a partir da PRESENÇA de binário/
 * credencial no ambiente — NUNCA expondo o valor do segredo (invariante).
 *
 * US-F3.9 — os vendors `claude`/`codex`/`gemini` são WIRED sobre o
 * `TanStackRunner` com o adapter oficial de cada um (ver `TANSTACK_VENDORS` em
 * tanstack.runner.ts; o plano original de reusar o `CliAdapter` foi superado
 * pelo caminho de API do EP-F3). O fallback ao default com warning fica SÓ
 * para kind desconhecido.
 */
@Injectable()
export class AgentAdapterRegistry {
  private readonly logger = new Logger(AgentAdapterRegistry.name);
  /** Runners wired nesta fatia, indexados por kind. */
  private readonly runners: Partial<Record<AgentAdapterKind, AgentRunner>>;
  /**
   * US-F3.4/US-F3.9 — a família TanStack (`tanstack` e os vendors
   * `claude`/`codex`/`gemini`) é instanciada LAZY no primeiro `resolve` de cada
   * kind (não são providers do Nest): com `AGENT_ADAPTER`
   * ausente/mock/copilot-cli nenhum é construído nem carrega pacote ESM.
   */
  private readonly tanstackFamily = new Map<AgentAdapterKind, TanStackRunner>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    copilotCli: CopilotCliRunner,
    mock: MockAgentRunner,
  ) {
    this.runners = {
      'copilot-cli': copilotCli,
      mock,
      // tanstack/claude/codex/gemini: lazy via tanstackFamily (US-F3.4/F3.9).
    };
  }

  /**
   * Resolve o `AgentRunner` de um `kind`. Desde a US-F3.9 todos os kinds do
   * catálogo têm runner; só um kind DESCONHECIDO cai no default `copilot-cli`
   * (não-regressão), com um warning para rastreabilidade.
   */
  resolve(kind: AgentAdapterKind): AgentRunner {
    // US-F3.4/F3.9 — lazy: só quem pede paga a instância (e o import ESM).
    if (
      kind === 'tanstack' ||
      kind === 'claude' ||
      kind === 'codex' ||
      kind === 'gemini'
    ) {
      let runner = this.tanstackFamily.get(kind);
      if (!runner) {
        runner = new TanStackRunner(
          this.config,
          kind === 'tanstack' ? undefined : kind,
        );
        this.tanstackFamily.set(kind, runner);
      }
      return runner;
    }
    const runner = this.runners[kind];
    if (runner) return runner;
    this.logger.warn(
      `adapter "${kind}" desconhecido — usando default "${DEFAULT_AGENT_ADAPTER}"`,
    );
    return this.runners[DEFAULT_AGENT_ADAPTER]!;
  }

  /** Resolve o runner ativo a partir da config (`AGENT_ADAPTER`). */
  resolveActive(): AgentRunner {
    return this.resolve(this.config.agentAdapter);
  }

  /**
   * Lista os descritores dos adapters conhecidos para a UI. `isDefault` marca o
   * adapter ATIVO efetivo; `available` deriva da presença de binário/credencial
   * SEM expor o segredo.
   */
  listDescriptors(): AgentAdapterDescriptor[] {
    const active = this.config.agentAdapter;
    // US-F3.8 — reavaliação do dark launch da F3.4: com o caminho Ollama
    // (endpoint OpenAI-compatível local, sem credencial) o adapter deixou de
    // ser inacessível — 'tanstack' aparece no catálogo quando é o ATIVO **ou**
    // quando há endpoint configurado (TANSTACK_BASE_URL → config). Sem endpoint
    // e sem estar ativo, segue invisível: quem não configurou não vê mudança
    // nenhuma (mesma filosofia do dark launch, agora condicionada à config em
    // vez de incondicional). Decidimos pela CONFIG (e não pelo env direto) para
    // o catálogo ser determinístico nos specs e derivado da mesma fonte que o
    // runner usa.
    const tanstackVisible =
      active === 'tanstack' || Boolean(this.config.agent.tanstack?.baseUrl);
    return AGENT_ADAPTER_KINDS.filter(
      (kind) => kind !== 'tanstack' || tanstackVisible,
    ).map((kind) => ({
      kind,
      displayName: DISPLAY_NAMES[kind],
      isDefault: kind === active,
      available: isAdapterAvailable(kind),
    }));
  }
}

/** Nomes amigáveis por kind (exibição na UI). */
const DISPLAY_NAMES: Record<AgentAdapterKind, string> = {
  'copilot-cli': 'GitHub Copilot CLI',
  claude: 'Anthropic Claude',
  codex: 'OpenAI Codex',
  gemini: 'Google Gemini',
  mock: 'Mock (determinístico)',
  tanstack: 'TanStack AI (OpenAI-compatível)',
};

/**
 * Deriva `available` da PRESENÇA de binário/credencial no ambiente, retornando
 * SEMPRE um booleano — nunca o valor do segredo (invariante US-OBS4).
 *
 * - `mock`: sempre disponível (sem dependência externa).
 * - `copilot-cli`: disponível se há um token de Copilot no ambiente
 *   (COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN) — a mesma precedência do
 *   catálogo de modelos. Presença de qualquer um => `true`.
 * - vendors: disponível se a env de credencial do vendor está presente e
 *   não-vazia (só checamos PRESENÇA, jamais lemos/retornamos o valor).
 *   US-F3.9: as MESMAS envs (e ordem) que o `TanStackRunner` lê para construir
 *   o adapter do vendor — em particular, `codex` é a **API da OpenAI**
 *   (OPENAI_API_KEY/CODEX_API_KEY), não o harness da CLI do Codex.
 */
export function isAdapterAvailable(kind: AgentAdapterKind): boolean {
  switch (kind) {
    case 'mock':
      return true;
    case 'copilot-cli':
      return hasAnyEnv(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
    case 'claude':
      return hasAnyEnv(['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY']);
    case 'codex':
      return hasAnyEnv(['OPENAI_API_KEY', 'CODEX_API_KEY']);
    case 'gemini':
      return hasAnyEnv(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    case 'tanstack':
      // US-F3.4: disponível quando há um endpoint configurado (não é segredo;
      // a credencial opcional TANSTACK_API_KEY nunca é lida/exposta aqui).
      return hasAnyEnv(['TANSTACK_BASE_URL']);
    default:
      return false;
  }
}

/** `true` se QUALQUER uma das envs está definida e não-vazia (só presença). */
function hasAnyEnv(names: string[]): boolean {
  return names.some((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
}
