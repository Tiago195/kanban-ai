import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AgentAdapterDescriptor, AgentAdapterKind } from '@kanban-ai/shared';
import type { AgentRunner } from './agent-runner.interface';
import { CopilotCliRunner } from './copilot-cli.runner';
import { MockAgentRunner } from './mock-agent.runner';
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
 * PR-3 do plano: os vendors `claude`/`codex`/`gemini` reusam o `CliAdapter`
 * (comando/flags/parse próprios) e serão plugados 1 por PR. Nesta fatia eles são
 * DECLARADOS como descritores (para a UI listar), mas ainda NÃO têm runner
 * dedicado — resolver um kind não-wired cai no default (`copilot-cli`), com log.
 */
@Injectable()
export class AgentAdapterRegistry {
  private readonly logger = new Logger(AgentAdapterRegistry.name);
  /** Runners wired nesta fatia, indexados por kind. */
  private readonly runners: Partial<Record<AgentAdapterKind, AgentRunner>>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    copilotCli: CopilotCliRunner,
    mock: MockAgentRunner,
  ) {
    this.runners = {
      'copilot-cli': copilotCli,
      mock,
      // claude/codex/gemini: PR-3 (reusam CliAdapter). Não-wired ainda.
    };
  }

  /**
   * Resolve o `AgentRunner` de um `kind`. Kinds ainda não-wired
   * (claude/codex/gemini) ou desconhecidos caem no default `copilot-cli`
   * (não-regressão), com um warning para rastreabilidade.
   */
  resolve(kind: AgentAdapterKind): AgentRunner {
    const runner = this.runners[kind];
    if (runner) return runner;
    this.logger.warn(
      `adapter "${kind}" ainda não tem runner wired — usando default "${DEFAULT_AGENT_ADAPTER}"`,
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
    return AGENT_ADAPTER_KINDS.map((kind) => ({
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
