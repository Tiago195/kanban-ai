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
