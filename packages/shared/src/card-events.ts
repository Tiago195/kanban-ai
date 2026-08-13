/**
 * US-OBS2-2 — Contrato do LOG TIPADO DE EVENTOS DE CARD (`CardEvent`).
 *
 * Diferente do modelo `Activity` (texto livre, legível por humano), o `CardEvent`
 * é um log **append-only** e **estruturado** de transições do card: cada linha
 * carrega um `kind` tipado + um `payload` JSON. Ele COEXISTE com `Activity` — não
 * o substitui — e serve de fonte para replay/tail incremental (webhook/consumidor
 * externo faz polling por `since=<eventId>`) e para a tool MCP `list_card_events`.
 *
 * Os `kind` espelham as transições que já emitem eventos WS em
 * `apps/api/src/modules/cards/cards.service.ts` (card criado/atualizado/movido,
 * story entrou em In Progress, status derivado do epic). NÃO reintroduz
 * DOR/acceptance (ADR-0007): é apenas observabilidade.
 */

/**
 * Tipos de transição registrados no log. Espelham os eventos WS emitidos hoje:
 * - `card_created`             → `card.created`
 * - `card_updated`             → `card.updated`
 * - `card_moved`               → `card.moved`
 * - `story_entered_in_progress`→ `story.entered_in_progress`
 * - `epic_status_derived`      → `epic.status.derived`
 */
export const CARD_EVENT_KINDS = [
  'card_created',
  'card_updated',
  'card_moved',
  'story_entered_in_progress',
  'epic_status_derived',
] as const;

/** União tipada dos `kind` de `CardEvent`. */
export type CardEventKind = (typeof CARD_EVENT_KINDS)[number];

/** Payload de `card_created`. */
export interface CardCreatedEventPayload {
  type: 'epic' | 'story' | 'task';
  key: string;
  parentId: string | null;
}

/** Payload de `card_updated` — os campos efetivamente alterados no PATCH. */
export interface CardUpdatedEventPayload {
  fields: string[];
}

/** Payload de `card_moved`. */
export interface CardMovedEventPayload {
  fromColumnId: string | null;
  toColumnId: string;
  /** true quando o move ocorreu no mini-kanban de tasks. */
  isTaskBoard: boolean;
}

/** Payload de `story_entered_in_progress`. */
export interface StoryEnteredInProgressEventPayload {
  columnId: string;
}

/** Payload de `epic_status_derived`. */
export interface EpicStatusDerivedEventPayload {
  status: 'todo' | 'inprogress' | 'done';
  done: number;
  total: number;
}

/** Mapa `kind → payload` para consumidores que queiram estreitar por `kind`. */
export interface CardEventPayloadByKind {
  card_created: CardCreatedEventPayload;
  card_updated: CardUpdatedEventPayload;
  card_moved: CardMovedEventPayload;
  story_entered_in_progress: StoryEnteredInProgressEventPayload;
  epic_status_derived: EpicStatusDerivedEventPayload;
}

/**
 * Uma linha do log append-only de eventos de card, como exposta pela API e pelo
 * MCP. `payload` é um objeto JSON estruturado cujo formato depende do `kind`
 * (ver {@link CardEventPayloadByKind}); permanece `unknown` no shape genérico
 * para que consumidores possam estreitar por `kind` sem cast forçado.
 */
export interface CardEventDTO {
  id: string;
  cardId: string;
  kind: CardEventKind;
  payload: unknown;
  /** Instante do evento em ISO 8601 (serializado a partir de `DateTime`). */
  ts: string;
}
