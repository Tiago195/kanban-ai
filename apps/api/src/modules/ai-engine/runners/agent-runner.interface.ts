/**
 * Contrato plugável de execução de um agent autônomo.
 *
 * A implementação v1 é `CopilotCliRunner`, que invoca a Copilot CLI como
 * subprocesso. Outras implementações (SDK, API remota) podem ser plugadas sem
 * mexer no orquestrador.
 */
import type { IterationPhase } from '@kanban-ai/shared';

/** Contexto de domínio da task/story para o runner mock gerar conteúdo coerente. */
export interface AgentRunContext {
  taskTitle: string;
  /** Projeto-alvo (aiContext.project da story pai). */
  project: string;
  /** Notas de efeitos colaterais (aiContext.notes da story pai). */
  notes: string;
  /** Nomes dos fluxos afetados da story pai. */
  flowNames: string[];
  /** Arquivos vinculados aos fluxos afetados. */
  files: string[];
}

/**
 * Chunk incremental emitido pelo runner durante a execução (streaming ao vivo).
 * O orchestrator repassa cada chunk para o WebSocket como `agent.chunk`.
 */
export interface AgentChunk {
  /** Raciocínio interno (thought) ou saída/ação (output). */
  kind: 'thought' | 'output';
  /** Fragmento de texto. */
  delta: string;
}

/**
 * Pergunta que o runner faz ao humano (HITL). O orchestrator emite
 * `agent.question`, coloca a sessão em `awaiting-input` e resolve a Promise
 * retornada por `onQuestion` quando o humano responde (via endpoint → stdin).
 */
export interface AgentQuestion {
  /** Id estável da pergunta (gerado pelo runner ou adapter). */
  id: string;
  prompt: string;
  /** Opções sugeridas de resposta, quando a CLI as fornecer. */
  options?: string[];
}

/** Entrada de uma execução de iteração. */
export interface AgentRunInput {
  /** Diretório de trabalho isolado (git worktree) do repo-alvo. */
  cwd: string;
  /** Modelo/agent a usar (opus, gpt, ...). */
  model: string;
  /** Fase do loop para esta iteração. */
  phase: IterationPhase;
  /** Prompt/handoff construído a partir do diário da task. */
  prompt: string;
  /** Contexto de domínio (usado pelo runner mock; a CLI real usa `prompt`/`cwd`). */
  context?: AgentRunContext;
  /** Cancelamento cooperativo (stop hard/abort). */
  signal?: AbortSignal;
  /**
   * Callback de streaming: chamado a cada chunk de stdout produzido pelo runner.
   * O mock emite alguns chunks fake; a CLI real emite conforme o parser.
   */
  onChunk?: (chunk: AgentChunk) => void;
  /**
   * Callback de HITL: chamado quando o runner faz uma pergunta. Deve resolver
   * com a resposta do humano. O mock nunca chama isto. O orchestrator fornece a
   * implementação que emite `agent.question` e aguarda a resposta via endpoint.
   */
  onQuestion?: (question: AgentQuestion) => Promise<string>;
}

/** Resultado de uma execução de iteração. */
export interface AgentRunResult {
  /** Registro minucioso para a próxima iteração ler. */
  detail: string;
  /** Resumo curto (vira comentário). */
  summary: string;
  /** DOD ids que a iteração considera concluídos. */
  dodTouched: string[];
  /** O que a próxima iteração deve fazer. */
  nextStep: string;
  /** Sinaliza que o trabalho terminou (gate para validação final). */
  done: boolean;
}

/** Interface plugável do runner. */
export interface AgentRunner {
  readonly id: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

/** Token de injeção do runner ativo. */
export const AGENT_RUNNER = 'AGENT_RUNNER';
