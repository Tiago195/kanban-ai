/**
 * Contrato plugável de execução de um agent autônomo.
 *
 * A implementação v1 é `CopilotCliRunner`, que invoca a Copilot CLI como
 * subprocesso. Outras implementações (SDK, API remota) podem ser plugadas sem
 * mexer no orquestrador.
 */
import type { IterationPhase, StructuredEvidence } from '@kanban-ai/shared';

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
   * Id de sessão da Copilot CLI (`--session-id`). Injetado como
   * `COPILOT_SESSION_ID` no env do subprocesso pelo runner real. Dá **memória
   * conversacional** entre invocações one-shot e torna o HITL **resiliente a
   * restart** da API: o turno que retoma após a resposta humana resume a MESMA
   * sessão persistida em `~/.copilot/session-state/<id>/`. Reusamos o `taskId`
   * (UUID) como id. Ver ADR-0022. O runner mock ignora este campo.
   */
  cliSessionId?: string;
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
  /**
   * DOD proposto pela AI na fase de ANÁLISE. Quando a task ainda não tem
   * checklist, o orchestrator cria os `DodItem`s a partir desta lista (um item
   * por string, na ordem). Ignorado se a task já tiver DOD. É assim que o DOD
   * nasce no fluxo com AI real (no artifact ele já vinha pré-populado).
   */
  proposedDod?: string[];
  /**
   * Fluxos afetados que a AI declarou ter tocado nesta iteração. É a **própria
   * AI** quem os registra (ela sabe onde mexeu) — o orchestrator persiste esta
   * lista na story para alimentar a validação final. Opcional: iterações que
   * ainda não sabem os fluxos devolvem `[]`/omitido.
   */
  affectedFlows?: { name: string; files: string[]; note?: string }[];
  /**
   * US-A4 — Aprendizados que o agent quer PERSISTIR na memória em colmeia
   * (ADR-0027). Cada item vira/atualiza um neurônio `.md`. O orchestrator
   * consome esta lista ao fechar a iteração (US-A3): grava via MemoryWriteService.
   * `path` é o neurônio-alvo (ex.: `modules/<modulo>.md`); `summary` é o texto
   * do aprendizado; `scope` (opcional) é uma dica do módulo/escopo. Opcional e
   * retrocompatível: ausência = nenhum aprendizado reportado.
   */
  learnings?: { path: string; summary: string; scope?: string }[];
  /** O que a próxima iteração deve fazer. */
  nextStep: string;
  /** Sinaliza que o trabalho terminou (gate para validação final). */
  done: boolean;
  /**
   * #6: evidência de que a AI verificou o próprio trabalho antes de `done`.
   * Aceita string livre (legado, ex.: "npm test: 12 passed") OU a forma
   * ESTRUTURADA e verificável (`StructuredEvidence`). Quando
   * `AGENT_REQUIRE_STRUCTURED_EVIDENCE=true`, o gate de `done` só fecha se a
   * evidência for verificável (`isVerifiableEvidence`). Persistida junto do
   * `detail` da iteração para rastreabilidade.
   */
  evidence?: string | StructuredEvidence;
  /**
   * Telemetria de tokens do turno, reportada pelo runner quando a CLI a expõe
   * (parseada do rodapé de stats do Copilot CLI). `inputTokens` = tokens de
   * entrada; `outputTokens` = tokens de saída. O orchestrator persiste estes
   * valores por iteração e soma nas métricas do loop (LoopMetricsPanel).
   * Ausentes (undefined) quando o runner/CLI não reporta.
   */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * US-OBS2-5 (fatia mínima ex-OBS2-3) — proveniência de USO: identifica o
   * PROVIDER que produziu esta telemetria de tokens (ex.: 'copilot', 'mock'),
   * para que a contabilidade de tokens possa, no futuro, ser atribuída por
   * provider. Opcional/retrocompatível: ausente = sem atribuição (zero mudança
   * de comportamento). NÃO implica CostEvent/executionSegments (deferido).
   */
  provider?: string;
  /**
   * BUG-A7: erro FATAL de infraestrutura (spawn falhou, modelo indisponível,
   * não autenticado, crash da CLI). Quando presente, esta "iteração" NÃO
   * representa trabalho da AI: o orchestrator deve escalar a humano e PARAR o
   * loop (fail-fast), em vez de contá-la como iteração normal (que queimaria o
   * cap) ou como `done` (que fecharia a task por engano).
   */
  fatalError?: string;
}

/** Interface plugável do runner. */
export interface AgentRunner {
  readonly id: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

/** Token de injeção do runner ativo. */
export const AGENT_RUNNER = 'AGENT_RUNNER';
