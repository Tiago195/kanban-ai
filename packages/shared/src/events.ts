/**
 * Contrato de eventos WebSocket entre api (emissor) e web (consumidor).
 *
 * Todos os eventos formam uma união discriminada pelo campo `type`. A api emite;
 * a web reage sem precisar de F5. Nomes derivam dos eventos do artifact de
 * referência (emit(...)) mais os previstos no plano.
 */

import type { AgentSessionState, ExecState } from './enums';
import type { AffectedFlow, Card, Iteration } from './domain';
import type { BacklogProposal } from './backlog-chat';

/** Status derivado de um epic a partir das stories filhas. */
export type EpicDerivedStatus = 'todo' | 'inprogress' | 'done';

/** Um card mudou de coluna (drag-and-drop no board ou no mini-kanban). */
export interface CardMovedEvent {
  type: 'card.moved';
  cardId: string;
  /** Id do card pai (story de uma task, epic de uma story) ou null. */
  parentId: string | null;
  fromColumnId: string | null;
  toColumnId: string;
  /** true quando o move ocorreu no mini-kanban de tasks. */
  isTaskBoard: boolean;
}

/** Um card foi criado. */
export interface CardCreatedEvent {
  type: 'card.created';
  card: Card;
}

/** Um card (e seus descendentes) foi excluído. */
export interface CardDeletedEvent {
  type: 'card.deleted';
  cardId: string;
  /** Pai do card excluído (para a UI reagir no mini-kanban/epic). */
  parentId: string | null;
  /** Ids de todos os cards removidos, incluindo o próprio e descendentes. */
  deletedIds: string[];
}

/** Campos de um card foram atualizados (título, descrição, points, aiContext). */
export interface CardUpdatedEvent {
  type: 'card.updated';
  cardId: string;
  card: Card;
}

/** Uma label foi anexada a um card. */
export interface LabelAttachedEvent {
  type: 'label.attached';
  cardId: string;
  labelId: string;
}

/** Uma label foi removida de um card. */
export interface LabelDetachedEvent {
  type: 'label.detached';
  cardId: string;
  labelId: string;
}

/** Um assignee foi anexado a um card. */
export interface AssigneeAttachedEvent {
  type: 'assignee.attached';
  cardId: string;
  assigneeId: string;
}

/** Um assignee foi removido de um card. */
export interface AssigneeDetachedEvent {
  type: 'assignee.detached';
  cardId: string;
  assigneeId: string;
}

/** Os affectedFlows de uma story mudaram (criação/remoção). */
export interface FlowChangedEvent {
  type: 'flow.changed';
  cardId: string;
  flows: AffectedFlow[];
}

/**
 * O status derivado de um epic mudou (recomputado a partir das stories filhas
 * após um move). A web usa isto para atualizar a sidebar de epics sem F5.
 */
export interface EpicStatusDerivedEvent {
  type: 'epic.status.derived';
  epicId: string;
  status: EpicDerivedStatus;
  done: number;
  total: number;
}

/** Estado de execução de uma task mudou. */
export interface TaskStateChangedEvent {
  type: 'task.state.changed';
  taskId: string;
  execState: ExecState;
}

/** Um item de DOD foi marcado/desmarcado. */
export interface DodCheckedEvent {
  type: 'dod.checked';
  cardId: string;
  itemId: string;
  done: boolean;
}

/**
 * O DOD de uma task foi criado/populado (ex.: na fase de análise do loop, quando
 * a task ainda não tinha checklist). A UI deve recarregar o card para exibir os
 * novos itens.
 */
export interface DodCreatedEvent {
  type: 'dod.created';
  cardId: string;
  /** Quantidade de itens criados nesta operação. */
  count: number;
}

/** Uma nova iteração foi anexada ao diário de uma task. */
export interface IterationAppendedEvent {
  type: 'iteration.appended';
  taskId: string;
  iteration: Iteration;
}

/** Uma story entrou em "In Progress" — dispara o loop engine. */
export interface StoryEnteredInProgressEvent {
  type: 'story.entered_in_progress';
  storyId: string;
}

/** Uma task derivada foi criada por uma validação que encontrou problema. */
export interface TaskDerivedEvent {
  type: 'task.derived';
  originTaskId: string;
  derivedTaskId: string;
}

/** O estado de uma sessão de agent mudou (running/idle/dead). */
export interface AgentSessionStateChangedEvent {
  type: 'agent.session.state_changed';
  storyId: string;
  sessionId: string;
  state: AgentSessionState;
}

/** Loop automático iniciado para uma story. */
export interface AutoStartedEvent {
  type: 'auto.started';
  storyId: string;
}

/** Loop automático parado para uma story. */
export interface AutoStoppedEvent {
  type: 'auto.stopped';
  storyId: string;
  mode: 'graceful' | 'hard';
}

/**
 * Um chunk incremental do "pensamento"/saída da AI durante uma iteração.
 * Emitido em tempo real enquanto o runner (Copilot CLI) produz stdout.
 * NÃO deve invalidar cache no front — é acumulado num buffer reativo.
 */
export interface AgentChunkEvent {
  type: 'agent.chunk';
  taskId: string;
  storyId: string;
  /** Índice da iteração em curso, se já conhecido. */
  iterationIndex?: number;
  /** Natureza do chunk: raciocínio interno ou saída/ação. */
  kind: 'thought' | 'output';
  /** Fragmento de texto a ser anexado ao transcript. */
  delta: string;
}

/**
 * A AI pausou e fez uma pergunta ao humano (HITL). A iteração fica em
 * `awaiting-input` até que a resposta seja enviada via endpoint dedicado.
 */
export interface AgentQuestionEvent {
  type: 'agent.question';
  taskId: string;
  storyId: string;
  questionId: string;
  prompt: string;
  /** Opções sugeridas de resposta, quando a CLI as fornecer. */
  options?: string[];
}

/** A pergunta pendente foi respondida — a iteração retoma. */
export interface AgentAnsweredEvent {
  type: 'agent.answered';
  taskId: string;
  questionId: string;
}

/**
 * Chunk incremental do chat de backlog (descoberta/redação da proposta).
 * Espelha `agent.chunk`, mas keyed por sessão de conversa.
 */
export interface BacklogChunkEvent {
  type: 'backlog.chunk';
  sessionId: string;
  /** Canal (thread) alvo: `main` ou `story:<id>`. Ver ADR-0023. */
  channel: string;
  role: 'ai' | 'system';
  kind?: 'thought' | 'output';
  delta: string;
}

/** A AI fez uma pergunta de refinamento (descoberta) e aguarda resposta. */
export interface BacklogQuestionEvent {
  type: 'backlog.question';
  sessionId: string;
  /** Canal (thread) onde a pergunta foi feita. Ver ADR-0023. */
  channel: string;
  questionId: string;
  prompt: string;
  options?: string[];
}

/** A pergunta de refinamento foi respondida — a conversa retoma. */
export interface BacklogAnsweredEvent {
  type: 'backlog.answered';
  sessionId: string;
  /** Canal (thread) da pergunta respondida. Ver ADR-0023. */
  channel: string;
  questionId: string;
}

/**
 * A AI emitiu (ou atualizou via patch) a proposta de backlog. Carrega a versão
 * corrente completa; o front renderiza/atualiza o cartão de proposta in-place.
 */
export interface BacklogProposalEvent {
  type: 'backlog.proposal';
  sessionId: string;
  proposal: BacklogProposal;
}

/** Keep-alive. */
export interface PingEvent {
  type: 'ping';
  ts: number;
}

/**
 * O loop engine desistiu de uma task após esgotar as tentativas de validação
 * (ver `AGENT_MAX_VALIDATION_FAILURES`). Em vez de derivar mais uma task-bug,
 * marca a task com `needsHuman` e para o auto-play da story (graceful). A UI
 * exibe o badge "Precisa de você". Ver ADR-0018 (HITL como flag, não coluna).
 */
export interface CardNeedsHumanEvent {
  type: 'card.needs_human';
  taskId: string;
  storyId: string;
  reason: string;
}

/** Um comentário foi criado num card (ex.: resumo de story escrito no épico). */
export interface CommentCreatedEvent {
  type: 'comment.created';
  cardId: string;
  /** Id do card pai, se houver (para a UI reagir no mini-kanban/epic). */
  parentId: string | null;
}

/** O modelo default do quadro mudou (afeta a cascata de herança). */
export interface BoardUpdatedEvent {
  type: 'board.updated';
  boardId: string;
  defaultModel: string | null;
}

/** União discriminada de todos os eventos do servidor. */
export type ServerEvent =
  | CardMovedEvent
  | CardCreatedEvent
  | CardDeletedEvent
  | CardUpdatedEvent
  | LabelAttachedEvent
  | LabelDetachedEvent
  | AssigneeAttachedEvent
  | AssigneeDetachedEvent
  | FlowChangedEvent
  | EpicStatusDerivedEvent
  | TaskStateChangedEvent
  | DodCheckedEvent
  | DodCreatedEvent
  | IterationAppendedEvent
  | StoryEnteredInProgressEvent
  | TaskDerivedEvent
  | AgentSessionStateChangedEvent
  | AutoStartedEvent
  | AutoStoppedEvent
  | AgentChunkEvent
  | AgentQuestionEvent
  | AgentAnsweredEvent
  | BacklogChunkEvent
  | BacklogQuestionEvent
  | BacklogAnsweredEvent
  | BacklogProposalEvent
  | CommentCreatedEvent
  | BoardUpdatedEvent
  | CardNeedsHumanEvent
  | PingEvent;

/** Nomes de eventos, úteis para type-guards e roteamento. */
export type ServerEventType = ServerEvent['type'];

/** Type-guard genérico por `type`. */
export function isEvent<T extends ServerEventType>(
  event: ServerEvent,
  type: T,
): event is Extract<ServerEvent, { type: T }> {
  return event.type === type;
}
