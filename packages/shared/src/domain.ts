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
  CardType,
  ExecState,
  IterationPhase,
  LoopProfileId,
  NeuronLockState,
  StoryPoints,
  ValidationStrategy,
} from './enums';

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
export type AgentAdapterKind = 'copilot-cli' | 'claude' | 'codex' | 'gemini' | 'mock';

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

/**
 * Identidade ESTÁVEL de um agent da colmeia, derivada da sessão + story em que
 * ele trabalha. É o handle que amarra tudo o que um agent faz na memória viva:
 * o `holder` de um lock de edição, o autor de uma mutação e o namespace do ramo
 * efêmero de escrita (`mem/ai/<sessao>/<path>`).
 *
 * Convenção de forma (ver ADR-0027): `ai:<sessao>` para agents autônomos. Como a
 * sessão é ancorada na story, dois passos do loop na MESMA story compartilham o
 * mesmo `AgentId` — é isso que torna a identidade "estável" entre iterações, e
 * não um id novo a cada `spawn`.
 *
 * É apenas o CONTRATO da identidade (uma string com convenção de prefixo); a
 * derivação real (sessão+story → id) e qualquer autorização vivem na Camada 2,
 * fora deste pacote.
 *
 * @example 'ai:sess_9f3a' // agent autônomo de uma sessão ligada a uma story
 */
export type AgentId = string;

/**
 * Dono (holder) de um lock de edição de neurônio na colmeia. Identifica QUEM
 * detém o lease `EDITING`/`REVIEW` — pode ser um agent de AI ou um humano.
 *
 * Convenção de forma (ver ADR-0027): `ai:<id>` para agents autônomos (o mesmo
 * handle estável do `AgentId`, derivado de sessão+story) e `human:<id>` para
 * pessoas. O prefixo distingue a natureza do dono sem exigir um campo extra.
 *
 * É apenas o CONTRATO do identificador (uma string com convenção de prefixo);
 * autenticação e autorização vivem na Camada 2, fora deste pacote. Nos eventos e
 * no índice, `null` significa que o neurônio está `FREE` (sem dono).
 *
 * @example 'ai:sess_9f3a'   // lock detido por um agent autônomo
 * @example 'human:u_1287'   // lock detido por um humano
 */
export type Owner = string;

/**
 * Neuron — unidade de memória versionada da colmeia (ver ADR-0027).
 *
 * Um neurônio é um documento markdown granular por assunto (feature, endpoint,
 * convenção aprendida, beco sem saída). A fonte da verdade do `content` é o git
 * da Camada 1; este shape é a projeção type-safe consumida por api+web+mcp
 * (Camada 2 — índice + locks). Sem lógica: só o contrato.
 */
export interface Neuron {
  /**
   * Identidade LÓGICA e única do neurônio — o arquivo `.md` versionado, nomeado
   * pelo assunto (ex.: 'apps/api/src/modules/cards', 'endpoints/cards.create').
   * É a CHAVE fina de tudo: leitura, aquisição de lock e nome do ramo efêmero
   * de escrita (`mem/ai/<sessao>/<path>`). Distingue-se de `module`: `path` é a
   * identidade granular do documento; `module` é o agrupamento grosso a que ele
   * pertence. (Ver ADR-0027.)
   */
  path: string;
  /**
   * Conteúdo do neurônio em markdown. É uma PROJEÇÃO (cache) do arquivo `.md` no
   * `headCommit`; a fonte da verdade do texto é o git da Camada 1, não este campo.
   */
  content: string;
  /**
   * SHA do commit HEAD do neurônio no git da Camada 1 — a FONTE DA VERDADE da
   * versão. Índice (Postgres) e eventos WS são projeções derivadas e
   * reindexáveis do git; por isso o git nunca fica "atrás" (no pior caso, à
   * frente). Comparar `headCommit` com o `baseCommit` que o holder leu é o que
   * detecta escrita _stale_ no write. (Ver ADR-0027.)
   */
  headCommit: string;
  /**
   * Módulo/escopo GROSSO a que o neurônio pertence (ex.: 'cards', 'ai-engine').
   * Ao contrário de `path` (identidade fina do documento), `module` agrupa
   * neurônios para fins de escopo de edição e arbitragem — uma proposta "fora do
   * escopo" do autor pode encaminhar o neurônio a REVIEW. (Ver ADR-0027.)
   */
  module: string;
  /** Estado do lock de edição (ver `NeuronLockState`, US-114). */
  lockState: NeuronLockState;
  /** Dono atual do lock (AI-id ou humano-id; ver `Owner`); null quando FREE. */
  owner: Owner | null;
  /**
   * `baseCommit` do lock ativo: o `headCommit` que o holder LEU no `acquire`;
   * null quando FREE. É a âncora do COMPARE-AND-SWAP: o holder envia este SHA no
   * `write` e o serviço compara com o `headCommit` ATUAL do path. Se forem iguais
   * (não divergiu), o write procede; se o `headCommit` mudou (outro holder fechou
   * uma mutação no meio), o `baseCommit` está _stale_ e o serviço responde 409
   * anti-stale — quem protege contra _lost-update_ é este CAS, não o lock (que é
   * advisory/presença). (Ver ADR-0027.)
   */
  baseCommit: string | null;
  /** Epoch ms da última atualização do neurônio. */
  updatedAt: number;
}

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
   */
  skippedReason?:
    | 'disabled'
    | 'not-verified'
    | 'no-isolated-worktree'
    | 'commit-failed'
    | 'nothing-to-commit';
}

// ─────────────────────────────────────────────────────────────
// EP-PROJECT / US-PROJ1 — Project (repo git clonado & gerenciado)
// ─────────────────────────────────────────────────────────────

/** Tipo de autenticação do repositório git do Project. Ver US-PROJ3. */
export type ProjectAuthKind = 'none' | 'https' | 'ssh';

/** Estado do clone gerenciado do Project. Ver US-PROJ2. */
export type ProjectCloneState = 'pending' | 'cloning' | 'ready' | 'failed';

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
 * Estado do lock advisory de um neurônio — reexportado de `enums.ts`
 * (`MemoryLockState = 'FREE' | 'EDITING' | 'REVIEW'`) para as projeções do
 * Project Explorer. NÃO redefinir aqui (evita ambiguidade no `export *`).
 */
import type { MemoryLockState } from './enums';

/**
 * Projeção de LEITURA de um neurônio da colmeia (espelha `MemoryIndex`), SEM os
 * campos internos de coordenação (`leaseId`/`activeBranch`/`baseCommit`/…). É o
 * "mapa do que a AI sabe" exibido no Project Explorer. `tags` já vem
 * desserializado do JSON persistido.
 */
export interface MemoryNeuronSummary {
  path: string; // ex.: 'modules/cards.md'
  title: string;
  tags: string[]; // já desserializado do JSON
  summary: string;
  lockState: MemoryLockState;
  holder: string | null;
  stale: boolean;
  archivedAt: string | null; // ISO
  updatedAt: string; // ISO
}

/** Detalhe de um neurônio: summary + o markdown completo (de GET /memory/read). */
export interface MemoryNeuronDetail extends MemoryNeuronSummary {
  content: string | null; // markdown completo
  headCommit: string; // SHA de origem do conteúdo
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
