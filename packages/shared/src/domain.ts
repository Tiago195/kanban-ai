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

/** Estado completo de um board. */
export interface BoardState {
  id: string;
  title: string;
  columns: Column[];
  taskColumns: Column[];
  cards: Record<string, Card>;
  labels: Label[];
  assignees: Assignee[];
  loopProfiles: Record<string, LoopProfile>;
  seq: number;
}
