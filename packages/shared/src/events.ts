/**
 * Contrato de eventos WebSocket entre api (emissor) e web (consumidor).
 *
 * Todos os eventos formam uma união discriminada pelo campo `type`. A api emite;
 * a web reage sem precisar de F5. Nomes derivam dos eventos do artifact de
 * referência (emit(...)) mais os previstos no plano.
 */

import type { AgentSessionState, ExecState } from './enums';
import type { Card, Iteration } from './domain';

/** Um card mudou de coluna (drag-and-drop no board ou no mini-kanban). */
export interface CardMovedEvent {
  type: 'card.moved';
  cardId: string;
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

/** Keep-alive. */
export interface PingEvent {
  type: 'ping';
  ts: number;
}

/** União discriminada de todos os eventos do servidor. */
export type ServerEvent =
  | CardMovedEvent
  | CardCreatedEvent
  | TaskStateChangedEvent
  | DodCheckedEvent
  | IterationAppendedEvent
  | StoryEnteredInProgressEvent
  | TaskDerivedEvent
  | AgentSessionStateChangedEvent
  | AutoStartedEvent
  | AutoStoppedEvent
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
