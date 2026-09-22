/**
 * DTOs e entidades de domínio do Kanban-AI.
 *
 * Estes tipos descrevem o CONTRATO trafegado entre api e web. Não são os modelos
 * Prisma (que podem divergir em detalhes de persistência), mas devem manter
 * compatibilidade estrutural com o schema.
 *
 * Fonte da verdade: docs/reference/kanban.html.
 */

import type {
  BlockKind,
  CardType,
  ExecState,
  IterationPhase,
  LoopProfileId,
  StoryPoints,
  ValidationStrategy,
} from './enums';

/**
 * Dono responsável por destravar um card bloqueado (EP-BLOCK / US-BLOCK2).
 * Um `agentId` => auto-notify por wake; o literal `'board'` => needs_attention humano.
 */
export type BlockedOwner = string | 'board';

/**
 * Descriptor typed exigido ao mover um card para blocked (US-BLOCK2). `owner`
 * roteia o unblock (agent => wake `issue_unblock`; `'board'` => needsHuman);
 * `action` descreve em prosa curta o que precisa acontecer para destravar.
 */
export interface BlockedDescriptor {
  owner: BlockedOwner;
  action: string;
}

/** Item de checklist (usado no DOD). */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/** Comentário resumido (ex.: da AI ao final de uma iteração). */
export interface Comment {
  id: string;
  authorId: string | null;
  text: string;
  ts: number;
}

/** Entrada de log de atividade do card. */
export interface Activity {
  id: string;
  text: string;
  ts: number;
}

/**
 * Fluxo/área do código afetada por uma story. A iteração final de validação
 * usa esta lista para saber onde fazer teste de mesa.
 */
export interface AffectedFlow {
  id: string;
  name: string;
  files: string[];
  note: string;
}

/**
 * "Handoff" que uma iteração deixa para a próxima: o que fazer a seguir e onde.
 */
export interface IterationHandoff {
  state: ExecState | 'blocked' | 'done';
  nextStep: string;
  targets: {
    files: string[];
    dodIds: string[];
  };
}

/**
 * Entrada do diário de iterações de uma task. Deve ser minuciosa — a próxima
 * iteração lê `detail` para continuar o trabalho; `summary` é o resumo curto.
 */
export interface Iteration {
  id: string;
  index: number;
  ts: number;
  agentId: string | null;
  phase: IterationPhase;
  /** Registro minucioso do que foi feito (lido pela próxima iteração). */
  detail: string;
  /** Resumo curto para exibição. */
  summary: string;
  /** IDs de itens de DOD marcados nesta iteração. */
  dodTouched: string[];
  /** Unified diff (git diff HEAD) do worktree ao fim da iteração; '' se nada mudou. */
  diff: string;
  handoff: IterationHandoff;
}

/** Contexto de AI de uma story: o que o agent precisa saber para trabalhar. */
export interface AiContext {
  summary: string;
  /** Repositório-alvo (path local ou URL remota) que o agent deve modificar. */
  project: string;
  notes: string;
}

/** Label do board (pode mapear para um loop profile). */
export interface Label {
  id: string;
  name: string;
  color: string;
  loopProfileId: LoopProfileId | null;
}

/** Assignee = agent autônomo (não humano). */
export interface Assignee {
  id: string;
  name: string;
  /** Modelo/agent preferido para este assignee (ex.: 'opus', 'gpt'). */
  model: string | null;
  priority?: number | null;
  startInPlanMode: boolean;
  /** "AGENTS.md" do agent: instruções/prompt de sistema que guiam o loop. */
  instructions: string;
}

/**
 * Modelo de AI disponivel para o login atual (catalogo exposto pelo backend
 * em GET /agents/models). `id` e o identificador passado ao Copilot CLI.
 */
export interface AgentModel {
  id: string;
  label: string;
}

/**
 * US-OBS4 — vendor/kind de um adapter de agent plugável no loop engine.
 * `copilot-cli` é o DEFAULT (não-regressão). `mock` é o runner determinístico
 * usado em dev/testes. `claude`/`codex`/`gemini` são vendors futuros que reusam
 * o `CliAdapter` (comando/flags/parse próprios). Ver ADR-0036.
 */
export type AgentAdapterKind =
  | 'copilot-cli'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'mock'
  // US-F3.4 — runner sobre @tanstack/ai (endpoint OpenAI-compatível).
  | 'tanstack';

/**
 * US-OBS4 — descritor de um adapter exposto em `GET /agents/adapters` para a UI
 * listar/selecionar o adapter ativo.
 *
 * INVARIANTE DE SEGREDO: `available` é um booleano derivado da PRESENÇA do
 * binário/credencial no ambiente — NUNCA expõe a credencial/token em si. Nenhum
 * campo deste descritor pode carregar valor de segredo.
 */
export interface AgentAdapterDescriptor {
  kind: AgentAdapterKind;
  /** Nome amigável para exibição na UI. */
  displayName: string;
  /** `true` no adapter que é o default efetivo do loop (copilot-cli). */
  isDefault: boolean;
  /** Binário/credencial presentes no ambiente (booleano; sem expor o segredo). */
  available: boolean;
}

/** Perfil de loop: define fases e estratégia de validação por tipo de trabalho. */
export interface LoopProfile {
  id: LoopProfileId;
  name: string;
  builtin: boolean;
  description: string;
  phases: IterationPhase[];
  validation: ValidationStrategy;
  firstStep: string;
}

/** Coluna do board (stories) ou do mini-kanban (tasks). */
export interface Column {
  id: string;
  title: string;
  wipLimit: number | null;
  protected?: boolean;
  cardIds: string[];
}

/** Campos comuns a todos os cards. */
export interface CardBase {
  id: string;
  key: string;
  type: CardType;
  title: string;
  description: string;
  parentId: string | null;
  blocked: boolean;
  everInProgress: boolean;
  /**
   * "Needs human": levantado quando o loop engine desiste após esgotar as
   * tentativas de validação de uma task (ver `AGENT_MAX_VALIDATION_FAILURES`).
   * É um FLAG/badge derivado — não uma coluna nem um estado novo (ver ADR-0018).
   */
  needsHuman: boolean;
  /** Motivo do `needsHuman` (título do problema que esgotou as tentativas). */
  needsHumanReason: string | null;
  /**
   * EP-BLOCK / US-BLOCK1 — taxonomia typed do bloqueio corrente. `null`/ausente =
   * bloqueio genérico (comportamento pré-BLOCK, retrocompatível). Ver `BlockKind`.
   */
  blockKind?: BlockKind | null;
  /**
   * EP-BLOCK / US-BLOCK2 — descriptor typed do bloqueio corrente (`{ owner, action }`).
   * `null`/ausente = prose-only (sem descriptor) => needs_attention humano. Ver
   * `BlockedDescriptor`.
   */
  blockedDescriptor?: BlockedDescriptor | null;
  /** Modelo de AI escolhido explicitamente para este card. null = herda do pai. */
  model: string | null;
  /**
   * Modelo efetivo apos resolver a cascata (task → story → epic → board).
   * Sempre preenchido pelo backend para exibicao na UI.
   */
  resolvedModel: string | null;
  labelIds: string[];
  assigneeIds: string[];
  /**
   * US-COLAB1 — tenant do card. `null`/ausente = card global (retrocompatível).
   * Rótulo opaco de isolamento de escopo no board (sem auth no v1, ADR-0009);
   * o isolamento é cooperativo, não uma fronteira de segurança.
   */
  tenantId?: string | null;
  /** Definition of Done — único checklist do v1. */
  dod: ChecklistItem[];
  comments: Comment[];
  activity: Activity[];
  createdAt: number;
}

export interface EpicCard extends CardBase {
  type: 'epic';
  points: StoryPoints | null;
}

export interface StoryCard extends CardBase {
  type: 'story';
  points: StoryPoints | null;
  aiContext: AiContext;
  affectedFlows: AffectedFlow[];
}

export interface TaskCard extends CardBase {
  type: 'task';
  points: null;
  /** Coluna do mini-kanban em que a task está. */
  taskColId: string | null;
  loopType: LoopProfileId | string;
  execState: ExecState;
  iterations: Iteration[];
  /** Task de origem, quando esta foi derivada de uma falha de validação. */
  derivedFrom: string | null;
  /** Tasks que precisam terminar antes desta. */
  dependsOn: string[];
}

export type Card = EpicCard | StoryCard | TaskCard;

/** Papel de uma mensagem no chat/transcript do agent. */
export type AgentChatRole = 'ai' | 'user' | 'system';

/**
 * Mensagem do transcript/chat de uma task. Acumula o streaming da AI, as
 * respostas do humano (HITL) e avisos de sistema.
 *
 * É **persistida** no backend (model `AgentMessage`) e reidratada ao abrir a
 * task; o buffer reativo do front (agentChatStore) é apenas o espelho ao vivo.
 */
export interface AgentChatMessage {
  id: string;
  role: AgentChatRole;
  /** Para mensagens da AI: distingue raciocínio de saída/ação. */
  kind?: 'thought' | 'output';
  /** Fase da iteração à qual a mensagem pertence, quando conhecida. */
  phase?: IterationPhase;
  text: string;
  /** Vincula a pergunta (role=ai) e a resposta (role=user) do mesmo par HITL. */
  questionId?: string;
  /** Opções de resposta rápida da pergunta HITL (quick replies), quando houver. */
  options?: string[];
  ts: number;
}

/** Pergunta pendente (HITL) associada a uma task aguardando resposta. */
export interface PendingQuestion {
  taskId: string;
  questionId: string;
  prompt: string;
  options?: string[];
  ts: number;
}

/** Estado completo de um board. */
export interface BoardState {
  id: string;
  title: string;
  /** Modelo de AI default do quadro — raiz da cascata de heranca. */
  defaultModel: string | null;
  columns: Column[];
  taskColumns: Column[];
  cards: Record<string, Card>;
  labels: Label[];
  assignees: Assignee[];
  loopProfiles: Record<string, LoopProfile>;
  seq: number;
}

/** Métrica agregada de uma task dentro de uma story (linha da tabela perTask). */
export interface LoopTaskMetrics {
  taskId: string;
  key: string;
  title: string;
  execState: string;
  iterations: number;
}

/**
 * #8: métricas agregadas do loop de uma story. Retornadas por
 * `Orchestrator.computeStoryMetrics` e expostas via
 * `GET /cards/:id/loop/metrics`. Contrato COMPARTILHADO entre api e web.
 */
export interface LoopMetrics {
  storyId: string;
  taskCount: number;
  iterationCount: number;
  /** Média de iterações por task (proxy de esforço). */
  avgIterationsPerTask: number;
  /** Fração de iterações que derivaram uma task de correção (validação falhou). */
  derivedTaskRate: number;
  /** Fração de iterações com desfecho `ok`. */
  okIterationRate: number;
  /** Duração média por iteração (ms), quando instrumentada. */
  avgDurationMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  perTask: LoopTaskMetrics[];
}

/**
 * Resultado de UM check verificável rodado pela AI antes de fechar a task
 * (ex.: `npm test`, `npm run lint`). Faz parte da evidência estruturada.
 */
export interface EvidenceCheck {
  /** Nome do check (ex.: "test", "lint", "build" ou comando). */
  name: string;
  /** Se o check passou. Um `done` verificável exige ao menos um `passed=true`. */
  passed: boolean;
  /** Saída/resumo do check (opcional, truncável). */
  output?: string;
}

/**
 * Evidência ESTRUTURADA que a AI anexa ao concluir a task (gate de `done` mais
 * forte — substitui a string livre quando `AGENT_REQUIRE_STRUCTURED_EVIDENCE`).
 * É verificável: `checks` traz os comandos rodados e seus resultados;
 * `filesChanged` lista os arquivos tocados. Contrato COMPARTILHADO entre api e
 * web. A string livre legada continua aceita (retrocompat).
 */
export interface StructuredEvidence {
  /** Checks verificáveis rodados pela AI (test/lint/build/...). */
  checks: EvidenceCheck[];
  /** Arquivos alterados nesta conclusão (opcional). */
  filesChanged?: string[];
  /** Nota livre adicional (opcional). */
  note?: string;
}

/**
 * Uma iteração é considerada com evidência VERIFICÁVEL quando é estruturada e
 * possui ao menos um check com `passed=true`. String livre nunca é verificável.
 */
export function isVerifiableEvidence(
  evidence: string | StructuredEvidence | null | undefined,
): evidence is StructuredEvidence {
  return (
    !!evidence &&
    typeof evidence === 'object' &&
    Array.isArray((evidence as StructuredEvidence).checks) &&
    (evidence as StructuredEvidence).checks.some((c) => c && c.passed === true)
  );
}

/**
 * US-ROB1 — Classe do resultado de uma conclusão de task. Determina QUAL
 * artefato mínimo verificável é exigido para fechar. Deriva-se do desfecho da
 * iteração + do que a AI reivindicou.
 *
 *  - 'code-change'  → houve edição de código nesta conclusão.
 *  - 'test-green'   → o entregável é uma suíte verde.
 *  - 'flow-artifact'→ o entregável são arquivos de affectedFlows.
 */
export type ResultClass = 'code-change' | 'test-green' | 'flow-artifact';

/** US-ROB1 — Sinais objetivos para avaliar o artefato mínimo por classe. */
export interface MinimumArtifactInput {
  /** Classe reivindicada/derivada desta conclusão. */
  resultClass: ResultClass;
  /** Evidência estruturada anexada pela AI (ou string livre legada). */
  evidence: string | StructuredEvidence | null | undefined;
  /** Diff do worktree NESTA iteração (já capturado pelo orquestrador). */
  diff: string;
  /** true quando TODOS os arquivos de affectedFlows existem no cwd (verifyFlowFiles). */
  flowFilesPresent: boolean;
}

/**
 * US-ROB1 — porta de completude por CLASSE de resultado. Complementa (NÃO
 * substitui) `isVerifiableEvidence`: uma conclusão só é aceita se o artefato
 * MÍNIMO da sua classe existir de fato.
 *
 *  - 'code-change'  → diff não-vazio nesta conclusão.
 *  - 'test-green'   → evidência verificável com ≥1 check de teste passed=true.
 *  - 'flow-artifact'→ arquivos de affectedFlows presentes no worktree.
 *
 * Determinística e pura (testável sem I/O). Retorna null quando o artefato
 * mínimo está presente, ou um problema acionável quando falta.
 */
export function minimumArtifactSatisfied(
  input: MinimumArtifactInput,
): { title: string; description: string } | null {
  switch (input.resultClass) {
    case 'code-change':
      return input.diff.trim().length > 0
        ? null
        : {
            title: 'conclusão sem diff verificável',
            description:
              'A conclusão foi classificada como mudança de código (code-change) ' +
              'mas o diff do worktree está VAZIO. Edite de fato os arquivos antes de fechar.',
          };
    case 'test-green': {
      const evidenceOk =
        isVerifiableEvidence(input.evidence) &&
        input.evidence.checks.some(
          (c) => /test|spec/i.test(c.name) && c.passed === true,
        );
      return evidenceOk
        ? null
        : {
            title: 'conclusão sem teste verde verificável',
            description:
              'A conclusão exige um teste verde (test-green) mas não há EvidenceCheck ' +
              'de teste com passed:true. Rode a suíte e reporte o resultado em `evidence`.',
          };
    }
    case 'flow-artifact':
      return input.flowFilesPresent
        ? null
        : {
            title: 'arquivos de fluxo declarados ausentes',
            description:
              'A conclusão referencia affectedFlows cujos arquivos não existem no ' +
              'worktree. Crie os arquivos declarados ou corrija a lista de fluxos.',
          };
  }
}

// ─────────────────────────────────────────────────────────────
// US-OBS1 — Read-model agregado da frota (GET /dashboard)
//
// Contratos COMPARTILHADOS api↔web. São read-only e NUNCA carregam segredos
// (path do repo-alvo `aiProject`, env, credenciais ou transcript bruto).
// ─────────────────────────────────────────────────────────────

/** Contagem de cards por coluna do board (frota). Compartilhado api↔web. */
export interface FleetColumnCount {
  column: string;   // um valor de BOARD_COLUMNS
  epics: number;
  stories: number;
  tasks: number;
  total: number;
}

/** Story em "In Progress" sem progresso recente (heurística de staleness). */
export interface FleetStaleStory {
  storyId: string;
  key: string;                 // US-...
  title: string;
  execState: string;           // ExecState em runtime (pode vir 'blocked-dep')
  lastIterationAt: string | null; // ISO; null se nunca iterou
  staleMinutes: number;        // minutos desde a última iteração (ou entrada In Progress)
}

/** Burn/cost agregado da frota. NUNCA inclui segredos (path/env/token). */
export interface FleetCostSummary {
  activeStories: number;       // stories com loop ativo (In Progress)
  totalIterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  derivedTaskRate: number;     // média ponderada por iterações
  okIterationRate: number;     // média ponderada por iterações
}

/** Resposta de GET /dashboard. Read-model agregado, sem segredos. */
export interface FleetDashboard {
  generatedAt: string;         // ISO
  columns: FleetColumnCount[]; // ordenado como BOARD_COLUMNS
  staleStories: FleetStaleStory[];
  cost: FleetCostSummary;
}

// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// US-OBS3 (ADR-0037) — Review inline por linha + auto-commit/PR opcional
// ─────────────────────────────────────────────────────────────

/**
 * US-OBS3 — Comentário de review por LINHA, persistido e vinculado a um card
 * (task ou story) e, opcionalmente, à iteração que o originou. É tratado como
 * OBSERVABILIDADE/evidência — NÃO reintroduz DOR/acceptance nem cria um novo
 * checklist obrigatório (o único gate de conclusão continua sendo o DOD, ver
 * ADR-0007). Contrato COMPARTILHADO entre api e web.
 */
export interface ReviewComment {
  id: string;
  /** Card alvo (task ou story). */
  cardId: string;
  /** Iteração que originou o comentário (opcional). */
  iterationId: string | null;
  /** Caminho relativo no repo-alvo. */
  filePath: string;
  /** Linha 1-based no arquivo pós-diff. */
  line: number;
  /** Corpo do comentário (markdown). */
  body: string;
  /** Autor: `agent:<runnerId>` | `human:<id>`. */
  author: string;
  /** Se o comentário foi resolvido. */
  resolved: boolean;
  /** ISO timestamp de criação. */
  createdAt: string;
  /** ISO timestamp da última atualização. */
  updatedAt: string;
}

/** US-OBS3 — payload para criar um comentário de review por linha. */
export interface ReviewCommentInput {
  cardId: string;
  iterationId?: string | null;
  filePath: string;
  line: number;
  body: string;
  author: string;
}

/**
 * US-OBS3 — Desfecho do auto-commit/PR OPCIONAL (opt-in, default OFF).
 *
 * O commit é feito pelo ENGINE (nunca pelo agent, ver ADR-0008) e SÓ ocorre
 * dentro de um worktree ISOLADO (ADR-0035) após a validação verde (todos os
 * `EvidenceCheck` verificáveis com `passed=true`, ver `isVerifiableEvidence`).
 * Quando pulado, `committed=false` e `skippedReason` explica o porquê.
 */
export interface CommitOutcome {
  /** true só quando o engine efetivamente commitou no worktree isolado. */
  committed: boolean;
  /** SHA do commit criado (presente só se `committed=true`). */
  commitSha?: string;
  /** Branch de execução onde o commit foi feito. */
  branch?: string;
  /** URL do PR aberto (presente só se `AGENT_AUTO_PR` e o PR foi aberto). */
  prUrl?: string;
  /**
   * Motivo do skip quando `committed=false`:
   *  - 'disabled'              → opt-in desligado (default).
   *  - 'not-verified'          → evidência não é verificável (algum check
   *                              faltando/`passed=false`).
   *  - 'no-isolated-worktree'  → não há worktree isolado (US-OBS2/ADR-0035);
   *                              nunca commitamos direto no repo-alvo.
   *  - 'commit-failed'         → o git do engine falhou (best-effort).
   *  - 'nothing-to-commit'     → worktree sem mudanças.
   *  - 'held-for-human'        → US-HARD4: o gate guardado SEGUROU a ação (hold)
   *                              e escalou para HITL (`needsHuman`) em vez de
   *                              commitar às cegas.
   *  - 'denied'                → US-HARD4: o gate guardado NEGOU a ação
   *                              (fail-closed).
   */
  skippedReason?:
    | 'disabled'
    | 'not-verified'
    | 'no-isolated-worktree'
    | 'commit-failed'
    | 'nothing-to-commit'
    | 'held-for-human'
    | 'denied';
}

// ─────────────────────────────────────────────────────────────
// EP-PROJECT / US-PROJ1 — Project (repo git clonado & gerenciado)
// ─────────────────────────────────────────────────────────────

/** Tipo de autenticação do repositório git do Project. Ver US-PROJ3. */
export type ProjectAuthKind = 'none' | 'https' | 'ssh';

/** Estado do clone gerenciado do Project. Ver US-PROJ2. */
export type ProjectCloneState = 'pending' | 'cloning' | 'ready' | 'failed';

/**
 * EP-F1 / US-F1.3 — Estado do build do grafo de conhecimento (graphify) do
 * Project. Espelha o ciclo do `cloneState`: `pending` (ainda não construído) →
 * `building` (POST /build em andamento no sidecar) → `ready` (graph.json no
 * lugar, `graphBuiltAt` gravado) | `failed` (ver `graphLastError`).
 */
export type ProjectGraphState = 'pending' | 'building' | 'ready' | 'failed';

/**
 * DTO público de leitura de um Project. Ortogonal à hierarquia Epic→Story→Task
 * (associado ao Board, raiz da cascata de repo-alvo).
 *
 * NUNCA expõe o conteúdo de `credentialRef` nem o `localPath` absoluto do clone
 * (evita vazar layout do FS do servidor / segredos).
 */
export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  authKind: ProjectAuthKind;
  cloneState: ProjectCloneState;
  lastError: string | null;
  lastSyncedAt: string | null; // ISO
  // US-F1.3 — estado do build do grafo de conhecimento (graphify) do Project.
  graphState: ProjectGraphState;
  graphBuiltAt: string | null; // ISO; null = grafo nunca construído
  graphLastError: string | null; // legível; só preenchido em graphState='failed'
  tenantId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Payload de criação de um Project. */
export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  defaultBranch?: string | null;
  authKind?: ProjectAuthKind;
  credentialRef?: string | null; // ver US-PROJ3
  tenantId?: string | null;
}

// ─────────────────────────────────────────────────────────────
// EP-PROJECT / US-PROJ7 — Project Explorer + Memory Viewer (SÓ leitura)
// ─────────────────────────────────────────────────────────────

/**
 * Projeção de LEITURA de um neurônio da colmeia do Project
 * (`<clone>/.hive/**.md` — a fonte da verdade desde a US-F2.3). É o "mapa do
 * que a AI sabe" exibido no Project Explorer.
 *
 * US-F2.3 — os campos de coordenação do substrato git
 * (`lockState`/`holder`/`stale`/`archivedAt`) saíram do contrato: arquivo
 * simples não tem lease nem arquivamento (ADR-0027, emenda US-F2.10).
 */
export interface MemoryNeuronSummary {
  path: string; // ex.: 'modules/cards.md' (relativo ao .hive/)
  title: string;
  tags: string[]; // do frontmatter v2 (ou da linha `tags:` no legado v1)
  summary: string;
  updatedAt: string; // ISO (frontmatter `updated`, senão mtime do arquivo)
}

/**
 * Detalhe de um neurônio: summary + o markdown completo. US-F2.3 — sem
 * `headCommit`: arquivo simples não tem git.
 */
export interface MemoryNeuronDetail extends MemoryNeuronSummary {
  content: string; // markdown completo
}

/**
 * Visão do repositório clonado exibida no explorer (aba "Repositório"). Combina
 * o estado persistido do `Project` (`cloneState`/`lastSyncedAt`) com metadados
 * lidos do clone via `isomorphic-git` (`defaultBranch`/`headCommit`) e os módulos
 * detectados (`detectModules(localPath)`). Campos de git são `null` enquanto o
 * clone ainda não existe.
 */
export interface ProjectRepoInfo {
  defaultBranch: string | null;
  headCommit: string | null;
  lastSyncedAt: string | null; // ISO
  cloneState: ProjectCloneState;
  modules: string[]; // de detectModules(localPath)
}

/**
 * US-CTX2 (EP-CTX / Hermes N7) — snapshot ESTRUTURADO de handoff que uma task
 * grava ao fechar (`done`). NÃO é um checklist (invariante 4): é contexto que o
 * PRÓXIMO trabalho (dependente que auto-inicia via M3) recebe para começar
 * assertivo. Todos os campos são opcionais (retrocompatível: metadata ausente =
 * comportamento atual). Ver ADR-0040 e docs/specs/ep-ctx.md §4.1.
 */
export interface CompletionMetadata {
  /** Arquivos alterados pela task (caminhos relativos ao repo-alvo). */
  changed_files?: string[];
  /** Como o resultado foi verificado (ex.: "build+lint+test verdes", comandos). */
  verification?: string;
  /** Dependências/decisões que o próximo trabalho precisa conhecer. */
  dependencies?: string[];
  /** Notas de retry — o que já se tentou e não funcionou. */
  retry_notes?: string;
  /** Risco residual conhecido deixado para o próximo. */
  residual_risk?: string;
}

// ─────────────────────────────────────────────────────────────
// EP-F4 / US-F4.1 — Projeção do grafo de conhecimento por Project
// ─────────────────────────────────────────────────────────────

/**
 * US-F4.1 — modo da projeção devolvida por `GET /projects/:id/graph`. O CORTE
 * é decidido no SERVIDOR (o grafo real tem ~3500 nós / ~6300 arestas — cru no
 * browser é inútil e pesado):
 *  - `overview` (default, sem params): os N nós mais conectados (god nodes) +
 *    as arestas ENTRE eles — o esqueleto do sistema;
 *  - `focus` (`?focus=<id|label>`): vizinhança BFS do nó (profundidade
 *    `depth`, 1..3) — é assim que o usuário navega/expande;
 *  - `community` (`?community=<id>`): os nós de UMA comunidade;
 *  - `search` (`?search=<termo>`): nós cujo label/arquivo casa com o termo
 *    (sem arestas — alimenta typeahead/busca, o resultado vira um `focus`).
 */
export type GraphProjectionMode = 'overview' | 'focus' | 'community' | 'search';

/** US-F4.1 — nó da projeção. `id` é ESTÁVEL entre respostas (é o id do
 * graph.json) — a US-F4.2 usa como chave de layout e a US-F4.3 liga
 * `sourceFile` → arquivo → card. */
export interface GraphProjectionNode {
  id: string;
  label: string;
  /** `file_type` do graphify: 'code' | 'document' | 'concept' | ... */
  type: string;
  /** Path repo-relativo do arquivo de origem (US-F4.3: nó → arquivo → card). */
  sourceFile: string | null;
  community: number | null;
  communityName: string | null;
  /** Grau no grafo COMPLETO (não no subgrafo) — dimensiona o nó na UI. */
  degree: number;
}

/** US-F4.1 — aresta da projeção (só entre nós presentes em `nodes`). */
export interface GraphProjectionEdge {
  source: string;
  target: string;
  /** Tipo de relação do graphify: 'calls' | 'imports' | 'describes' | ... */
  relation: string;
}

/** US-F4.1 — resumo de UMA comunidade do grafo COMPLETO (drill-down da UI). */
export interface GraphCommunitySummary {
  id: number;
  name: string | null;
  size: number;
}

/** US-F4.1 — projeção do grafo com o corte já aplicado no servidor. */
export interface GraphProjection {
  ok: true;
  mode: GraphProjectionMode;
  /** Id resolvido do nó focado (modo `focus`); null = seed não resolveu. */
  focus: string | null;
  nodes: GraphProjectionNode[];
  edges: GraphProjectionEdge[];
  /** Todas as comunidades do grafo COMPLETO, maiores primeiro. */
  communities: GraphCommunitySummary[];
  /** Tamanho do grafo COMPLETO — a UI mostra "exibindo X de Y". */
  totalNodes: number;
  totalEdges: number;
  /** true = o corte estourou o teto de nós/arestas e a resposta foi truncada. */
  truncated: boolean;
}

/**
 * US-F4.1 — falha VISÍVEL (mesma filosofia das US-F2.5/F2.10: nunca mascarar):
 * grafo não-`ready`, sidecar fora do ar ou integração desligada viram
 * `{ok:false}` tipado com o estado e um erro legível — nunca um 500 opaco.
 */
export interface GraphProjectionUnavailable {
  ok: false;
  graphState: ProjectGraphState;
  error: string;
}

/** US-F4.1 — resposta de `GET /projects/:id/graph`. */
export type GraphProjectionResponse = GraphProjection | GraphProjectionUnavailable;

/**
 * US-F4.3 — como o vínculo arquivo → card foi estabelecido:
 *  - `affected-flow`: um `AffectedFlow` do card (declarado pela IA ou derivado
 *    do blast radius, US-F2.7) cita o arquivo em `files[]`;
 *  - `iteration`: uma iteração do card entregou o arquivo em `handoffFiles`.
 */
export type GraphFileCardVia = 'affected-flow' | 'iteration';

/** US-F4.3 — card do board que tocou um arquivo do grafo (nó → arquivo → card). */
export interface GraphFileCard {
  id: string;
  boardId: string;
  key: string;
  type: CardType;
  title: string;
  /** Story pai quando o card é uma task (a UI abre a story junto). */
  parentId: string | null;
  /** Vias (dedupadas) pelas quais o vínculo existe. */
  via: GraphFileCardVia[];
  /** Nomes dos fluxos afetados que citam o arquivo (via `affected-flow`). */
  flowNames: string[];
}

/**
 * US-F4.3 — resposta de `GET /projects/:id/graph/file-cards?file=...`.
 * `cards: []` é resultado VÁLIDO e esperado (o board pode nunca ter tocado o
 * arquivo) — a UI mostra estado vazio honesto, nunca esconde o painel.
 */
export interface GraphFileCardsResponse {
  file: string;
  cards: GraphFileCard[];
}

/**
 * US-F5.4 — Wiki do graphify (base de conhecimento navegável derivada do
 * grafo): `index.md` + um artigo por comunidade + artigos de god node,
 * gerados no sidecar (`POST /wiki` do wrapper) após cada build do grafo.
 */
export interface ProjectWikiArticleSummary {
  /** Nome do arquivo sem `.md` — a chave de leitura (`?slug=`). */
  slug: string;
  /** Primeiro heading nível 1 do artigo (fallback: o slug). */
  title: string;
}

/** US-F5.4 — resposta de `GET /projects/:id/wiki` (índice da wiki). */
export interface ProjectWikiIndex {
  ok: true;
  /** false = wiki ainda não gerada (grafo não pronto / geração pendente). */
  generated: boolean;
  generatedAt: string | null;
  articles: ProjectWikiArticleSummary[];
}

/** US-F5.4 — resposta de `GET /projects/:id/wiki/article?slug=...`. */
export interface ProjectWikiArticle {
  ok: true;
  slug: string;
  title: string;
  /** Markdown completo do artigo (renderizado com o markdown lite da F4.2). */
  content: string;
}

/**
 * US-F5.4 — falha VISÍVEL (mesma filosofia da US-F4.1): sidecar fora,
 * integração desligada ou artigo inexistente viram `{ok:false}` com erro
 * legível — nunca 500 opaco nem tela vazia muda.
 */
export interface ProjectWikiUnavailable {
  ok: false;
  error: string;
}

export type ProjectWikiIndexResponse = ProjectWikiIndex | ProjectWikiUnavailable;
export type ProjectWikiArticleResponse = ProjectWikiArticle | ProjectWikiUnavailable;

// ─────────────────────────────────────────────────────────────
// EP-UX / US-UX.3 — Painel da memória (o que o reflect aprendeu)
// ─────────────────────────────────────────────────────────────

/**
 * US-UX.3 — veredito de um nó no overlay `.graphify_learning.json` do
 * `graphify reflect` (US-F5.2): `preferred` (corroborado por ≥2 resultados
 * úteis), `tentative` (útil 1×, ainda não corroborado), `contested` (sinais
 * em conflito — a recência decide o `verdict`).
 */
export type ProjectLearningStatus = 'preferred' | 'tentative' | 'contested';

/** US-UX.3 — um sinal da trilha de proveniência de um nó aprendido. */
export interface ProjectLearningProvenance {
  /** A pergunta original que citou o nó. */
  q: string;
  date: string; // ISO
  /** 'useful' | 'corrected' (só esses entram na trilha do reflect). */
  outcome: string;
}

/** US-UX.3 — um nó do código com veredito de aprendizado. */
export interface ProjectLearningNode {
  id: string;
  status: ProjectLearningStatus;
  /** Veredito do contested ('useful' | 'dead end' | 'even'); null nos demais. */
  verdict: string | null;
  /** Score assinado com decaimento temporal (meia-vida 30d). */
  score: number;
  /** Nº de sinais positivos (o "N× útil" do placar). */
  uses: number;
  /** Nº de sinais negativos (só > 0 em contested). */
  neg: number;
  /** Data ISO do sinal mais recente. */
  last: string;
  label: string;
  /** Path repo-relativo do código que o aprendizado descreve. */
  sourceFile: string | null;
  /** true = o código MUDOU desde o aprendizado (code_fingerprint divergiu) —
   * suspeito, não falso; recomputado a cada leitura no sidecar. */
  stale: boolean;
  provenance: ProjectLearningProvenance[];
}

/** US-UX.3 — beco sem saída: "já tentamos, não levou a nada, não re-deduzir". */
export interface ProjectLearningDeadEnd {
  question: string;
  /** Nós citados pela tentativa (ids/labels crus do memory doc). */
  nodes: string[];
  date: string;
}

/** US-UX.3 — correção: resposta que o humano corrigiu, e qual era a certa. */
export interface ProjectLearningCorrection {
  question: string;
  correction: string;
  date: string;
}

/** US-UX.3 — resposta de `GET /projects/:id/learning`. */
export interface ProjectLearning {
  ok: true;
  /** false = reflect nunca rodou E não há memory docs (estado vazio honesto). */
  generated: boolean;
  generatedAt: string | null;
  /** Nº de memory docs em `<clone>/.hive/memory/`. */
  docs: number;
  nodes: ProjectLearningNode[];
  deadEnds: ProjectLearningDeadEnd[];
  corrections: ProjectLearningCorrection[];
}

/** US-UX.3 — falha VISÍVEL (mesma filosofia da wiki/grafo): nunca 500 opaco. */
export interface ProjectLearningUnavailable {
  ok: false;
  error: string;
}

export type ProjectLearningResponse = ProjectLearning | ProjectLearningUnavailable;

// ─────────────────────────────────────────────────────────────
// EP-UX / US-UX.4 — Estado do conhecimento por Project (card da lista)
// ─────────────────────────────────────────────────────────────

/**
 * US-UX.4 — resumo agregado do que a AI sabe de UM Project, devolvido em lote
 * por `GET /projects/summary` (uma tacada para a lista inteira — nunca N×4
 * requisições do browser). Cada faceta segue o padrão da casa (US-F4.1):
 * falha tipada `{ok:false, error}` visível, nunca 500 nem sumiço.
 */
export interface ProjectKnowledgeSummary {
  projectId: string;
  /** Grafo: contagens do grafo COMPLETO quando `ready`; senão o erro legível
   * (inclui "grafo ainda não construído" / "build falhou: …"). */
  graph:
    | { ok: true; nodes: number; edges: number }
    | { ok: false; graphState: ProjectGraphState; error: string };
  /** Wiki: `generated:false` = ainda não gerada (estado vazio honesto). */
  wiki:
    | { ok: true; generated: boolean; articles: number }
    | { ok: false; error: string };
  /** Memória: aprendizados = nós com veredito; `contested` destacado. */
  memory:
    | { ok: true; generated: boolean; docs: number; learnings: number; contested: number }
    | { ok: false; error: string };
}
