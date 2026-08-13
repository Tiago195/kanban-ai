/**
 * Contrato de eventos WebSocket entre api (emissor) e web (consumidor).
 *
 * Todos os eventos formam uma união discriminada pelo campo `type`. A api emite;
 * a web reage sem precisar de F5. Nomes derivam dos eventos do artifact de
 * referência (emit(...)) mais os previstos no plano.
 */

import type { AgentSessionState, ExecState } from './enums';
import type {
  AffectedFlow,
  AgentId,
  Card,
  Iteration,
  Owner,
  ProjectCloneState,
  ReviewComment,
} from './domain';
import type { BacklogProposal, BacklogTaskProposal } from './backlog-chat';
import type { MemoryConflict, MemoryReviewItem } from './dtos';
import type { ReviewActionDTO } from './review-actions';

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

/**
 * A AI emitiu (ou atualizou via patch) a **proposta de tasks** de uma story
 * dentro do chat da story (ADR-0026). Carrega a versão corrente completa; o front
 * renderiza/atualiza a lista de tasks clicáveis in-place. Escopada por sessão de
 * story (`Card.backlogChatSessionId`).
 */
export interface BacklogTaskProposalEvent {
  type: 'backlog.task_proposal';
  sessionId: string;
  taskProposal: BacklogTaskProposal;
}

/**
 * O turno do chat de backlog TERMINOU (o subprocesso da CLI encerrou), sem
 * necessariamente ter emitido `proposal`/`question`. Marca o fim do streaming
 * daquele canal para que a UI possa desligar o indicador "ainda trabalhando".
 * Sem este evento, um turno que emite apenas `output` deixaria o `streaming`
 * ligado para sempre. Ver relatório de QA (BUG-01).
 */
export interface BacklogTurnDoneEvent {
  type: 'backlog.turn_done';
  sessionId: string;
  /** Canal (thread) cujo turno terminou: `main` ou `story:<id>`. */
  channel: string;
}

/**
 * Um neurônio (path da colmeia de memória) teve seu lock ADQUIRIDO — passou de
 * FREE para EDITING. A web usa isto para exibir o cadeado e o dono na UI de
 * memória sem F5. Payload mínimo: o `path` travado, o `headCommit` corrente do
 * path no instante do lock e o `owner` que passou a segurá-lo.
 */
export interface MemoryLockedEvent {
  type: 'memory.locked';
  /** Path do neurônio travado (ver `Neuron.path`). */
  path: string;
  /** `headCommit` corrente do path no instante do lock (ver `Neuron.headCommit`). */
  headCommit: string;
  /** Dono que adquiriu o lock (AI-id ou humano-id; ver `Owner`). */
  owner: Owner;
}

/**
 * Um neurônio teve seu lock LIBERADO — passou de EDITING (ou REVIEW) de volta
 * para FREE. A web usa isto para retirar o cadeado e o dono na UI de memória sem
 * F5. Payload mínimo: o `path` liberado, o `headCommit` corrente do path no
 * instante da liberação e o `owner` que segurava o lock até então.
 */
export interface MemoryReleasedEvent {
  type: 'memory.released';
  /** Path do neurônio liberado (ver `Neuron.path`). */
  path: string;
  /** `headCommit` corrente do path no instante da liberação (ver `Neuron.headCommit`). */
  headCommit: string;
  /** Dono que segurava o lock até a liberação (AI-id ou humano-id; ver `Owner`). */
  owner: Owner;
}

/**
 * O conteúdo de um neurônio foi ATUALIZADO (novo commit gravado via write/CAS)
 * enquanto o lock seguia com o holder. A web usa isto para recarregar o conteúdo
 * exibido e avançar o `headCommit` sem F5. Payload mínimo: o `path` atualizado, o
 * NOVO `headCommit` resultante da mutação e o `agentId` que a produziu.
 */
export interface MemoryUpdatedEvent {
  type: 'memory.updated';
  /** Path do neurônio atualizado (ver `Neuron.path`). */
  path: string;
  /** NOVO `headCommit` resultante da mutação (ver `Neuron.headCommit`). */
  headCommit: string;
  /** Agent que produziu a atualização (ver `AgentId`). */
  agentId: AgentId;
}

/**
 * Um neurônio entrou em CONFLITO SEMÂNTICO — o merge 3-way não resolveu duas
 * verdades no mesmo trecho, levando o path de `EDITING` a `REVIEW`. A web usa
 * isto para sinalizar a disputa na UI de memória sem F5 (cadeado em REVIEW + os
 * dois lados a arbitrar). Payload: o `conflict` completo com os 2 lados
 * (`ours`/`theirs`) + `baseCommit` (ver `MemoryConflict`). Distingue-se do 409
 * anti-stale de _timing_ ({@link MemoryUpdatedEvent} não é emitido aqui; o CAS
 * sucedeu, mas o conteúdo colide).
 */
export interface MemoryConflictEvent {
  type: 'memory.conflict';
  /** Descrição da disputa: os 2 lados (`ours`/`theirs`) + `baseCommit` (ver `MemoryConflict`). */
  conflict: MemoryConflict;
}

/**
 * Um neurônio ENTROU NA FILA DE REVIEW — passou de `EDITING` a `REVIEW`
 * aguardando arbitragem (por conflito semântico ou proposta fora de escopo). A
 * web usa isto para exibir/atualizar a fila de revisão sem F5. Payload: o `item`
 * completo da fila (ver `MemoryReviewItem`), que carrega `path`, `baseCommit`,
 * `reason`, o `conflict` (quando houver) e quem arbitra.
 */
export interface MemoryReviewEvent {
  type: 'memory.review';
  /** Registro do que entrou em REVIEW e quem o arbitra (ver `MemoryReviewItem`). */
  item: MemoryReviewItem;
}

/** Keep-alive. */
export interface PingEvent {
  type: 'ping';
  ts: number;
}

/**
 * EP-PROJECT / US-PROJ2 — O estado do clone gerenciado de um `Project` mudou
 * (`pending → cloning → ready|failed`). A web usa isto para exibir o status do
 * clone (badge) sem F5. `error` só está presente quando `state='failed'` e
 * carrega uma mensagem LEGÍVEL (nunca um stacktrace cru). Ver
 * `ProjectWorkspaceService`.
 */
export interface ProjectCloneStateEvent {
  type: 'project.clone_state';
  projectId: string;
  state: ProjectCloneState;
  error?: string;
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

/**
 * Metadados de raiz de cascata do quadro mudaram (modelo default e/ou o
 * `Project` associado). `defaultModel` acompanha a cascata de modelo; `projectId`
 * (EP-PROJECT / US-PROJ6) acompanha a raiz de repo-alvo. Ambos são opcionais no
 * payload: um broadcast pode carregar só o que mudou (retrocompat com quem só
 * consumia `defaultModel`).
 */
export interface BoardUpdatedEvent {
  type: 'board.updated';
  boardId: string;
  defaultModel?: string | null;
  projectId?: string | null;
}

/**
 * US-OBS3 (ADR-0037) — Um comentário de review por linha foi adicionado a um
 * card. A UI reage invalidando a query de comentários do card. É observabilidade
 * (não reintroduz DOR/acceptance — ver ADR-0007).
 */
export interface ReviewCommentAddedEvent {
  type: 'review.comment_added';
  cardId: string;
  comment: ReviewComment;
}

/**
 * US-OBS2-4 — Um scan periódico sinalizou uma REVIEW ACTION (anomalia) para um
 * card. É VISÍVEL mas NÃO-INTRUSIVO: não move nem cancela a story. A UI exibe um
 * aviso discreto que o operador pode snoozar. Observabilidade — não reintroduz
 * DOR/acceptance (ADR-0007).
 */
export interface ReviewActionFlaggedEvent {
  type: 'review.action_flagged';
  cardId: string;
  action: ReviewActionDTO;
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
  | BacklogTaskProposalEvent
  | BacklogTurnDoneEvent
  | CommentCreatedEvent
  | ReviewCommentAddedEvent
  | ReviewActionFlaggedEvent
  | BoardUpdatedEvent
  | CardNeedsHumanEvent
  | MemoryLockedEvent
  | MemoryReleasedEvent
  | MemoryUpdatedEvent
  | MemoryConflictEvent
  | MemoryReviewEvent
  | ProjectCloneStateEvent
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
