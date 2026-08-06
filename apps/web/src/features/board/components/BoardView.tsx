import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cleanChatText } from "@kanban-ai/shared";
import type { ExecState, StoryPoints } from "@kanban-ai/shared";

import { useCardAssignees } from "@/features/assignees";
import { ChatPanel, IterationDiffViewer, LoopMetricsPanel, useAgentChat, useAutoPlay, useLoopState, useStepLoop } from "@/features/ai-engine";
import type { ChatPanelMessage } from "@/features/ai-engine";
import { useAgentChatStore } from "@/features/ai-engine/services/agentChatStore";
import { useBoard, useCards, useCreateCard, useDeleteCard, useModels, useMoveCard, usePrimaryBoardId } from "@/features/board/hooks";
import { useBoardUiStore } from "@/features/board/services";
import { useCardLabels, LABEL_PALETTE } from "@/features/labels";
import { useCard, useDodMutations, useFlows, useUpdateCard } from "@/features/stories";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { showToast } from "@/shared/services/toastStore";
import type { ApiBoardColumn, ApiCardDetails, ApiCardSummary } from "@/shared/types";

const BOARD_COLUMNS = ["Backlog", "To Do", "In Progress", "Review", "Done"] as const;
const STORY_POINTS = [1, 2, 3, 5, 8, 13] as const;
const TASK_COLUMNS = ["To Do", "In Progress", "Review", "Done"] as const;

const AVATAR_PALETTE = ["#4c6ef5", "#22a06b", "#e5484d", "#f59e0b", "#8b5cf6", "#0ea5e9", "#ec4899", "#14b8a6"];

const EXEC_STATE_META: Record<ExecState, { label: string; cls: string }> = {
  idle: { label: "Ocioso", cls: "idle" },
  analyzing: { label: "Analisando", cls: "analyzing" },
  implementing: { label: "Implementando", cls: "implementing" },
  validating: { label: "Validando", cls: "validating" },
  "blocked-dep": { label: "Bloqueada (derivada)", cls: "blocked" },
  done: { label: "Concluída", cls: "done" },
};

const PHASE_META: Record<string, { label: string; emoji: string }> = {
  reproduce: { label: "Reproduzir", emoji: "🔁" },
  analysis: { label: "Análise", emoji: "🔎" },
  implementation: { label: "Implementação", emoji: "🛠️" },
  validation: { label: "Validação", emoji: "🧪" },
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function avatarColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function epicStatusLabel(status?: "todo" | "inprogress" | "done") {
  if (status === "done") return "DONE";
  if (status === "inprogress") return "IN PROGRESS";
  return "TODO";
}

function relativeTime(ts: number) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "agora";
  const m = Math.floor(s / 60);
  if (m < 60) return "há " + m + " min";
  const h = Math.floor(m / 60);
  if (h < 24) return "há " + h + " h";
  const dd = Math.floor(h / 24);
  if (dd < 7) return "há " + dd + " d";
  return new Date(ts).toLocaleDateString("pt-BR");
}

function getColumnFromOverId(
  overId: string,
  cards: ApiCardSummary[],
  activeCardId: string,
  fallback: (card: ApiCardSummary) => string | null,
) {
  if (overId.startsWith("column:")) return overId.slice(7);
  const overCard = cards.find((card) => card.id === overId);
  if (overCard) return fallback(overCard);
  const activeCard = cards.find((card) => card.id === activeCardId);
  return activeCard ? fallback(activeCard) : null;
}

/**
 * Estratégia de colisão robusta para board com colunas de altura variável
 * (inclusive vazias): prioriza o droppable sob o ponteiro; se não houver,
 * usa interseção de retângulos. Evita o bug em que colunas vazias — sem cards
 * para o `closestCenter` mirar — ficam impossíveis de receber um drop.
 */
const boardCollision: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  if (pointer.length > 0) return pointer;
  return rectIntersection(args);
};

/**
 * Registra a lista de uma coluna como droppable no dnd-kit (id `column:<id>`),
 * de modo que seja possível soltar um card mesmo quando a coluna está vazia.
 */
function ColumnDropZone({
  columnId,
  className,
  children,
}: {
  columnId: string;
  className: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "column:" + columnId });
  return (
    <div ref={setNodeRef} id={"column:" + columnId} className={className + (isOver ? " is-over" : "")}>
      {children}
    </div>
  );
}

function StoryCardContent({ card }: { card: ApiCardSummary }) {
  const hasDescription = Boolean(card.description && card.description.trim());
  return (
    <>
      <div className="card-top">
        <span className="type-badge story">STORY</span>
        <span className="card-key">{card.key}</span>
        {card.blocked ? <span className="blocked-flag">⛔</span> : null}
        {card.points != null ? <span className="points-badge">{card.points}</span> : null}
      </div>
      <div className="card-title">{card.title}</div>
      {hasDescription ? (
        <div className="card-meta">
          <span className="card-badge">📝</span>
        </div>
      ) : null}
    </>
  );
}

function StoryCard({ card, onOpen }: { card: ApiCardSummary; onOpen: (card: ApiCardSummary) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={"card type-story" + (card.blocked ? " blocked" : "") + (isDragging ? " dragging" : "")}
      onClick={() => onOpen(card)}
      {...attributes}
      {...listeners}
    >
      <StoryCardContent card={card} />
    </div>
  );
}

function StoryColumn({
  column,
  stories,
  isDropTarget,
  onOpenStory,
  onCreateStory,
}: {
  column: ApiBoardColumn;
  stories: ApiCardSummary[];
  isDropTarget?: boolean;
  onOpenStory: (card: ApiCardSummary) => void;
  onCreateStory: (columnId: string) => void;
}) {
  const points = stories.reduce((sum, story) => sum + (story.points ?? 0), 0);
  const overLimit = column.wipLimit != null && stories.length > column.wipLimit;
  const allowsCreate = column.title === "Backlog" || column.title === "To Do";

  return (
    <div className={"column" + (isDropTarget ? " drop-target" : "")}>
      <div className="column-header">
        <div className="column-title">{column.title}</div>
        <span className={"column-count" + (overLimit ? " over-limit" : "")}>{stories.length}</span>
        {points > 0 ? <span className="column-points">{points} pts</span> : null}
        {column.wipLimit != null ? (
          <span className="column-wip">
            {stories.length}/{column.wipLimit}
          </span>
        ) : null}
      </div>
      <SortableContext items={stories.map((story) => story.id)} strategy={verticalListSortingStrategy}>
        <ColumnDropZone columnId={column.id} className="card-list">
          {stories.map((story) => (
            <StoryCard key={story.id} card={story} onOpen={onOpenStory} />
          ))}
          {isDropTarget ? <div className="drop-placeholder" /> : null}
        </ColumnDropZone>
      </SortableContext>
      {allowsCreate ? (
        <button className="add-card-btn" onClick={() => onCreateStory(column.id)}>
          + Adicionar história
        </button>
      ) : null}
    </div>
  );
}

function MiniCardContent({ card, showPoints }: { card: ApiCardSummary; showPoints?: boolean }) {
  const awaiting = useAgentChatStore((s) => Boolean(s.byTask[card.id]?.pending));
  return (
    <>
      <div className="task-card-top">
        <span className="card-key">{card.key}</span>
        {showPoints && card.points != null ? <span className="points-badge">{card.points}</span> : null}
        {card.blocked ? <span>⛔</span> : null}
        {card.needsHuman ? (
          <span className="needs-human-badge" title={card.needsHumanReason ?? "Precisa de você"}>
            🙋 precisa de você
          </span>
        ) : null}
        {awaiting ? <span className="awaiting-badge" title="O agente aguarda sua resposta">✋</span> : null}
      </div>
      <div className="task-card-title">{card.title}</div>
    </>
  );
}

function MiniCard({
  card,
  onOpen,
  showPoints,
}: {
  card: ApiCardSummary;
  onOpen: (card: ApiCardSummary) => void;
  showPoints?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={"task-card" + (card.blocked ? " blocked" : "") + (isDragging ? " dragging" : "")}
      onClick={() => onOpen(card)}
      {...attributes}
      {...listeners}
    >
      <MiniCardContent card={card} showPoints={showPoints} />
    </div>
  );
}

function MiniKanban({
  boardId,
  columns,
  cards,
  fallbackColumn,
  onOpenCard,
  onAddCard,
  addLabel,
  allowAddOn,
}: {
  boardId: string;
  columns: ApiBoardColumn[];
  cards: ApiCardSummary[];
  fallbackColumn: (card: ApiCardSummary) => string | null;
  onOpenCard: (card: ApiCardSummary) => void;
  onAddCard?: (columnId: string) => void;
  addLabel?: string;
  allowAddOn?: (column: ApiBoardColumn) => boolean;
}) {
  const moveCard = useMoveCard();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColId, setOverColId] = useState<string | null>(null);
  const activeCard = activeId ? cards.find((card) => card.id === activeId) ?? null : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollision}
      onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
      onDragOver={(event: DragOverEvent) => {
        const overId = event.over ? String(event.over.id) : "";
        const draggingId = String(event.active.id);
        setOverColId(overId ? getColumnFromOverId(overId, cards, draggingId, fallbackColumn) : null);
      }}
      onDragCancel={() => {
        setActiveId(null);
        setOverColId(null);
      }}
      onDragEnd={(event: DragEndEvent) => {
        setActiveId(null);
        setOverColId(null);
        const activeId = String(event.active.id);
        const overId = event.over ? String(event.over.id) : "";
        if (!overId) return;
        const destination = getColumnFromOverId(overId, cards, activeId, fallbackColumn);
        if (!destination) return;
        const movedCard = cards.find((card) => card.id === activeId);
        moveCard.mutate({
          boardId,
          cardId: activeId,
          dto: { columnId: destination },
          parentId: movedCard?.parentId ?? null,
        });
      }}
    >
      <div className="task-board">
        {columns.map((column) => {
          const items = cards.filter((card) => fallbackColumn(card) === column.id);
          const canAdd = Boolean(onAddCard) && (allowAddOn ? allowAddOn(column) : true);
          const isDropTarget = overColId === column.id && activeId != null;
          return (
            <div key={column.id} className={"task-col" + (isDropTarget ? " drop-target" : "")}>
              <div className="task-col-head">
                <span className="task-col-title">{column.title}</span>
                <span className="task-col-count">{items.length}</span>
              </div>
              <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <ColumnDropZone columnId={column.id} className="task-list">
                  {items.map((item) => (
                    <MiniCard key={item.id} card={item} onOpen={onOpenCard} showPoints />
                  ))}
                  {isDropTarget ? <div className="drop-placeholder task" /> : null}
                </ColumnDropZone>
              </SortableContext>
              {canAdd ? (
                <button className="task-add" onClick={() => onAddCard?.(column.id)}>
                  {addLabel ?? "+ Adicionar"}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className={"task-card" + (activeCard.blocked ? " blocked" : "") + " dragging-overlay"}>
            <MiniCardContent card={activeCard} showPoints />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ChecklistSection({ card, boardId }: { card: ApiCardDetails; boardId: string }) {
  const [text, setText] = useState("");
  const { addDod, updateDod, removeDod } = useDodMutations();
  const done = card.dodItems.filter((item) => item.done).length;

  const commit = () => {
    const value = text.trim();
    if (!value) return;
    addDod.mutate({ boardId, cardId: card.id, dto: { text: value } });
    setText("");
  };

  return (
    <div className="modal-section">
      <div className="modal-section-title">
        Definition of Done (DOD)
        {card.dodItems.length ? (
          <span>
            {done}/{card.dodItems.length}
          </span>
        ) : null}
      </div>
      <div className="checklist">
        {card.dodItems.map((item) => (
          <div key={item.id} className="check-item">
            <input
              type="checkbox"
              checked={item.done}
              onChange={() =>
                updateDod.mutate({ boardId, cardId: card.id, itemId: item.id, dto: { done: !item.done } })
              }
            />
            <span className={"txt" + (item.done ? " done" : "")}>{item.text}</span>
            <button
              className="del-check"
              onClick={() => removeDod.mutate({ boardId, cardId: card.id, itemId: item.id })}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
      <div className="add-check-row">
        <input
          className="criteria-input"
          value={text}
          placeholder="Critério de concluído…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <button className="kb-btn kb-btn-ghost kb-btn-sm" onClick={commit}>
          + Adicionar
        </button>
      </div>
    </div>
  );
}

function LabelsSection({
  card,
  boardId,
  boardLabels,
}: {
  card: ApiCardDetails;
  boardId: string;
  boardLabels: Array<{ id: string; name: string; color: string }>;
}) {
  const { attachLabel, detachLabel, createLabel, deleteLabel } = useCardLabels();
  const selected = new Set(card.labels.map((entry) => entry.label.id));

  const handleAddLabel = () => {
    const name = window.prompt("Nome da nova label:");
    const trimmed = name?.trim();
    if (!trimmed) return;
    const color = LABEL_PALETTE[boardLabels.length % LABEL_PALETTE.length];
    createLabel.mutate(
      { boardId, cardId: card.id, name: trimmed, color },
      { onSuccess: () => showToast(`Label "${trimmed}" criada`) },
    );
  };

  const handleDeleteLabel = (label: { id: string; name: string }) => {
    if (!window.confirm(`Excluir a label "${label.name}" de TODO o board?`)) return;
    deleteLabel.mutate(
      { boardId, labelId: label.id },
      { onSuccess: () => showToast(`Label "${label.name}" excluída`) },
    );
  };

  return (
    <div className="modal-section">
      <div className="modal-section-title">Labels</div>
      <div className="label-editor">
        {boardLabels.map((label) => {
          const isSelected = selected.has(label.id);
          return (
            <span
              key={label.id}
              className={"label-option" + (isSelected ? " selected" : "")}
              onClick={() => {
                if (isSelected) {
                  detachLabel.mutate({ boardId, cardId: card.id, labelId: label.id });
                } else {
                  attachLabel.mutate({ boardId, cardId: card.id, labelId: label.id });
                }
              }}
            >
              <span className="swatch" style={{ background: label.color }} />
              <span>{label.name}</span>
              <button
                type="button"
                className="del"
                title="Excluir label do board"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteLabel(label);
                }}
              >
                🗑
              </button>
            </span>
          );
        })}
        <button type="button" className="kb-btn kb-btn-ghost kb-btn-sm" onClick={handleAddLabel}>
          + Nova label
        </button>
      </div>
    </div>
  );
}

function AssigneesSection({
  card,
  boardId,
  boardAssignees,
}: {
  card: ApiCardDetails;
  boardId: string;
  boardAssignees: Array<{ id: string; name: string; model: string | null }>;
}) {
  const { attachAssignee, detachAssignee } = useCardAssignees();
  const selected = new Set(card.assignees.map((entry) => entry.assignee.id));

  return (
    <div className="modal-section">
      <div className="modal-section-title">🤖 Agentes responsáveis</div>
      <div className="assignee-editor">
        {boardAssignees.map((assignee) => {
          const isSelected = selected.has(assignee.id);
          return (
            <span
              key={assignee.id}
              className={"assignee-option" + (isSelected ? " selected" : "")}
              onClick={() => {
                if (isSelected) {
                  detachAssignee.mutate({ boardId, cardId: card.id, assigneeId: assignee.id });
                } else {
                  attachAssignee.mutate({ boardId, cardId: card.id, assigneeId: assignee.id });
                }
              }}
            >
              <span className="mini-avatar" style={{ background: avatarColor(assignee.name) }}>
                {initials(assignee.name)}
              </span>
              <span>🤖 {assignee.name}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function CommentsSection({ card }: { card: ApiCardDetails }) {
  return (
    <div className="modal-section">
      <div className="modal-section-title">Comentários</div>
      <div className="comment-list">
        {card.comments
          .slice()
          .sort((a, b) => b.ts - a.ts)
          .map((comment) => (
            <div key={comment.id} className="comment">
              <span className="mini-avatar" style={{ background: avatarColor(comment.authorId ?? "AI") }}>
                {initials(comment.authorId ?? "AI")}
              </span>
              <div className="comment-body">
                <div>
                  <span className="comment-author">{comment.authorId ?? "AI"}</span>
                  <span className="comment-time">{relativeTime(comment.ts)}</span>
                </div>
                <div className="comment-text">{comment.text}</div>
              </div>
            </div>
          ))}
      </div>
      {/* <form className="comment-form" onSubmit={(event) => event.preventDefault()} title="Em breve — comentários manuais chegam com o AI engine">
        <input className="comment-input" placeholder="Escreva um comentário… (em breve)" autoComplete="off" disabled />
        <button className="btn btn-primary btn-sm" type="submit" disabled>
          Enviar
        </button>
      </form> */}
    </div>
  );
}

function ActivitySection({ card }: { card: ApiCardDetails }) {
  return (
    <div className="modal-section">
      <div className="modal-section-title">Atividade</div>
      <div className="activity-list">
        {card.activities.slice(0, 30).map((activity) => (
          <div key={activity.id} className="activity-item">
            <b>{activity.text}</b>
            <span className="activity-time">{relativeTime(activity.ts)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModalPanel({ level, children }: { level?: "epic" | "task"; children: ReactNode }) {
  const cls = level === "epic" ? "modal-panel lvl-epic" : level === "task" ? "modal-panel lvl-task" : "modal-panel";
  return (
    <div className={cls} onClick={(event) => event.stopPropagation()}>
      <div className="kb-modal">{children}</div>
    </div>
  );
}

function DangerZoneSection({
  boardId,
  card,
  onDeleted,
}: {
  boardId: string;
  card: ApiCardDetails;
  onDeleted: () => void;
}) {
  const deleteCard = useDeleteCard(boardId);
  const typeLabel = card.type === "epic" ? "épico" : card.type === "story" ? "história" : "task";
  const childCount = card.children?.length ?? 0;

  const onDelete = () => {
    const extra =
      childCount > 0 ? `\n\nIsto também remove ${childCount} card(s) filho(s) em cascata.` : "";
    const ok = window.confirm(`Excluir ${typeLabel} "${card.title}"?${extra}\n\nEsta ação não pode ser desfeita.`);
    if (!ok) return;
    deleteCard.mutate(
      { cardId: card.id, parentId: card.parentId },
      { onSuccess: () => onDeleted() },
    );
  };

  return (
    <div className="modal-section danger-zone">
      <div className="modal-section-title">Zona de perigo</div>
      <button className="kb-btn kb-btn-danger" onClick={onDelete} disabled={deleteCard.isPending}>
        {deleteCard.isPending ? "Excluindo…" : `🗑 Excluir ${typeLabel}`}
      </button>
      {childCount > 0 ? (
        <span className="danger-hint">Remove {childCount} card(s) filho(s) em cascata.</span>
      ) : null}
    </div>
  );
}

/**
 * Seletor de modelo de AI para um card (epic/story/task), com herança em
 * cascata. Exibe o modelo efetivo (resolvedModel) e sua origem (próprio vs.
 * herdado), e permite escolher um modelo específico ou "Herdar do pai".
 */
function CardModelSelector({
  boardId,
  card,
}: {
  boardId: string;
  card: ApiCardDetails;
}) {
  const modelsQuery = useModels();
  const updateCard = useUpdateCard();
  const models = modelsQuery.data?.models ?? [];
  const own = card.model ?? null;
  const resolved = card.resolvedModel ?? null;
  const inherited = own === null;

  const labelFor = (id: string | null): string => {
    if (!id) return "—";
    return models.find((m) => m.id === id)?.label ?? id;
  };

  const inheritLabel =
    card.type === "task"
      ? "Herdar (história → épico → quadro)"
      : card.type === "story"
        ? "Herdar (épico → quadro)"
        : "Herdar (quadro)";

  return (
    <div className="modal-section">
      <div className="modal-section-title">Modelo de AI</div>
      <select
        className="card-desc-input"
        value={own ?? ""}
        disabled={updateCard.isPending || modelsQuery.isLoading}
        onChange={(event) => {
          const value = event.target.value === "" ? null : event.target.value;
          updateCard.mutate({ boardId, cardId: card.id, dto: { model: value } });
        }}
      >
        <option value="">{inheritLabel}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <div className="modal-hint">
        {inherited ? (
          <>
            Herdado: <strong>{labelFor(resolved)}</strong>
          </>
        ) : (
          <>
            Definido neste card: <strong>{labelFor(resolved)}</strong>
          </>
        )}
      </div>
    </div>
  );
}

function EpicModal({
  boardId,
  epicId,
  boardColumns,
  stories,
  onOpenStory,
  onClose,
  onCreateStory,
}: {
  boardId: string;
  epicId: string;
  boardColumns: ApiBoardColumn[];
  stories: ApiCardSummary[];
  onOpenStory: (storyId: string) => void;
  onClose: () => void;
  onCreateStory: (columnId: string, parentId: string) => void;
}) {
  const { data: epic } = useCard(epicId);
  const updateCard = useUpdateCard();
  const flowColumns = boardColumns.filter((column) => !column.isTaskColumn).sort((a, b) => a.position - b.position);
  const epicStories = stories.filter((story) => story.parentId === epicId).sort((a, b) => a.position - b.position);
  const done = epic?.epicStatus?.done ?? 0;
  const total = epic?.epicStatus?.total ?? 0;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [aiProject, setAiProject] = useState("");
  const [aiNotes, setAiNotes] = useState("");

  useEffect(() => {
    if (!epic) return;
    setTitle(epic.title);
    setDescription(epic.description ?? "");
    setAiProject(epic.aiProject ?? "");
    setAiNotes(epic.aiNotes ?? "");
  }, [epic]);

  const saveEpic = () =>
    epic && updateCard.mutate({ boardId, cardId: epic.id, dto: { title, description } });
  const saveAiContext = () =>
    epic && updateCard.mutate({ boardId, cardId: epic.id, dto: { aiProject, aiNotes } });

  return (
    <ModalPanel level="epic">
      <div className="modal-header">
        <div className="modal-key-row">
          <span className="type-badge epic">EPIC</span>
          <span className="card-key">{epic?.key ?? ""}</span>
          {epic ? (
            <span className={"epic-status-inline status-" + (epic.epicStatus?.status ?? "todo")}>
              {epicStatusLabel(epic.epicStatus?.status)} · {done}/{total}
            </span>
          ) : null}
        </div>
        <div className="modal-title-row">
          <input
            className="card-title-input"
            value={title}
            placeholder="Título do épico"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveEpic}
            disabled={!epic}
          />
          <button className="modal-close" onClick={onClose} aria-label="Fechar épico">
            ✕
          </button>
        </div>
      </div>
      <div className="modal-body">
        <div className="modal-section">
          <div className="modal-section-title">Descrição</div>
          <textarea
            className="card-desc-input"
            rows={3}
            value={description}
            placeholder="Descreva o objetivo do épico…"
            onChange={(event) => setDescription(event.target.value)}
            onBlur={saveEpic}
            disabled={!epic}
          />
        </div>
        <div className="modal-section">
          <div className="modal-section-title">Projeto-alvo (repositório onde a AI trabalha)</div>
          <input
            className="card-desc-input"
            value={aiProject}
            placeholder="/caminho/para/o/repo-alvo ou URL do repositório"
            onChange={(event) => setAiProject(event.target.value)}
            onBlur={saveAiContext}
            disabled={!epic}
          />
          <div className="modal-hint">
            A AI cria uma branch/worktree isolada nesse repositório. As histórias
            herdam este projeto se não definirem o seu.
          </div>
        </div>
        <div className="modal-section">
          <div className="modal-section-title">Notas para a AI (contexto/escopo)</div>
          <textarea
            className="card-desc-input"
            rows={3}
            value={aiNotes}
            placeholder="Instruções, restrições e escopo para o agent…"
            onChange={(event) => setAiNotes(event.target.value)}
            onBlur={saveAiContext}
            disabled={!epic}
          />
        </div>
        {epic ? <CardModelSelector boardId={boardId} card={epic} /> : null}
        <div className="modal-section">
          <div className="modal-section-title">
            Histórias
            {total ? (
              <span>
                {done}/{total}
              </span>
            ) : null}
          </div>
          <MiniKanban
            boardId={boardId}
            columns={flowColumns}
            cards={epicStories}
            fallbackColumn={(card) => card.boardColumnId}
            onOpenCard={(card) => onOpenStory(card.id)}
            onAddCard={(columnId) => onCreateStory(columnId, epicId)}
            addLabel="+ História"
            allowAddOn={(column) => column.title === "Backlog" || column.title === "To Do"}
          />
        </div>
        {epic ? <CommentsSection card={epic} /> : null}
        {epic ? <ActivitySection card={epic} /> : null}
        {epic ? <DangerZoneSection boardId={boardId} card={epic} onDeleted={onClose} /> : null}
      </div>
    </ModalPanel>
  );
}

function CreateEpicModal({
  boardId,
  boardColumns,
  onClose,
  onCreated,
}: {
  boardId: string;
  boardColumns: ApiBoardColumn[];
  onClose: () => void;
  onCreated: (epicId: string) => void;
}) {
  const createCard = useCreateCard(boardId);
  const backlog = boardColumns.find((column) => column.title === "Backlog" && !column.isTaskColumn);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const canSubmit = title.trim().length > 0 && !createCard.isPending;

  const submit = () => {
    if (!canSubmit) return;
    createCard.mutate(
      {
        dto: {
          boardId,
          type: "epic",
          columnId: backlog?.id,
          title: title.trim(),
          description: description.trim() || undefined,
        },
      },
      {
        onSuccess: (card) => onCreated(card.id),
      },
    );
  };

  return (
    <div className="modal-layer" onClick={onClose}>
      <div className="modal-panel lvl-epic" onClick={(event) => event.stopPropagation()}>
        <div className="kb-modal">
          <div className="modal-header">
            <div className="modal-key-row">
              <span className="type-badge epic">EPIC</span>
              <span className="card-key">Novo épico</span>
            </div>
            <div className="modal-title-row">
              <input
                ref={titleRef}
                className="card-title-input"
                value={title}
                placeholder="Título do épico (obrigatório)"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            <div className="modal-section">
              <div className="modal-section-title">Descrição</div>
              <textarea
                className="card-desc-input"
                rows={4}
                value={description}
                placeholder="Descreva o objetivo do épico…"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="modal-section">
              <div className="field-row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button className="kb-btn kb-btn-ghost" onClick={onClose}>
                  Cancelar
                </button>
                <button className="kb-btn kb-btn-primary" onClick={submit} disabled={!canSubmit}>
                  {createCard.isPending ? "Criando…" : "Criar épico"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateStoryModal({
  boardId,
  boardColumns,
  columnId,
  parentId,
  onClose,
  onCreated,
}: {
  boardId: string;
  boardColumns: ApiBoardColumn[];
  columnId: string;
  parentId: string | null;
  onClose: () => void;
  onCreated: (storyId: string) => void;
}) {
  const createCard = useCreateCard(boardId);
  const creatableColumns = boardColumns.filter(
    (column) => !column.isTaskColumn && (column.title === "Backlog" || column.title === "To Do"),
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [points, setPoints] = useState<StoryPoints>(1);
  const [selectedColumn, setSelectedColumn] = useState<string>(columnId || creatableColumns[0]?.id || "");

  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const canSubmit = title.trim().length > 0 && Boolean(selectedColumn) && !createCard.isPending;

  const submit = () => {
    if (!canSubmit) return;
    createCard.mutate(
      {
        dto: {
          boardId,
          type: "story",
          parentId: parentId ?? undefined,
          columnId: selectedColumn,
          title: title.trim(),
          description: description.trim() || undefined,
          points,
        },
      },
      {
        onSuccess: (card) => onCreated(card.id),
      },
    );
  };

  return (
    <div className="modal-layer" onClick={onClose}>
      <div className="modal-panel lvl-story" onClick={(event) => event.stopPropagation()}>
        <div className="kb-modal">
          <div className="modal-header">
            <div className="modal-key-row">
              <span className="type-badge story">STORY</span>
              <span className="card-key">Nova história</span>
            </div>
            <div className="modal-title-row">
              <input
                ref={titleRef}
                className="card-title-input"
                value={title}
                placeholder="Título da história (obrigatório)"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            <div className="modal-section">
              <div className="field-row">
                <div className="field">
                  <label>Coluna</label>
                  <select
                    className="select-inline"
                    value={selectedColumn}
                    onChange={(event) => setSelectedColumn(event.target.value)}
                  >
                    {creatableColumns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Story points</label>
                  <select
                    className="select-inline"
                    value={points}
                    onChange={(event) => setPoints(Number(event.target.value) as StoryPoints)}
                  >
                    {[1, 2, 3, 5, 8, 13].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-section">
              <div className="modal-section-title">Descrição</div>
              <textarea
                className="card-desc-input"
                rows={4}
                value={description}
                placeholder="Como um <usuário>, quero <objetivo>, para <benefício>…"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="modal-section">
              <div className="field-row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button className="kb-btn kb-btn-ghost" onClick={onClose}>
                  Cancelar
                </button>
                <button className="kb-btn kb-btn-primary" onClick={submit} disabled={!canSubmit}>
                  {createCard.isPending ? "Criando…" : "Criar história"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateTaskModal({
  boardId,
  parentId,
  taskColumns,
  defaultColumnId,
  onClose,
  onCreated,
}: {
  boardId: string;
  parentId: string;
  taskColumns: ApiBoardColumn[];
  defaultColumnId: string | null;
  onClose: () => void;
  onCreated: (taskId: string) => void;
}) {
  const createCard = useCreateCard(boardId);
  const creatableColumns = taskColumns.filter((column) => column.title === "To Do" || column.title === "Backlog");
  const initialColumn = defaultColumnId ?? creatableColumns[0]?.id ?? null;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [columnId, setColumnId] = useState<string | null>(initialColumn);

  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const canSubmit = title.trim().length > 0 && Boolean(columnId) && !createCard.isPending;

  const submit = () => {
    if (!canSubmit || !columnId) return;
    createCard.mutate(
      {
        dto: {
          boardId,
          type: "task",
          parentId,
          columnId,
          title: title.trim(),
          description: description.trim() || undefined,
        },
      },
      {
        onSuccess: (card) => {
          onCreated(card.id);
          onClose();
        },
      },
    );
  };

  return (
    <div className="modal-layer depth-3" onClick={onClose}>
      <div className="modal-panel lvl-task" onClick={(event) => event.stopPropagation()}>
        <div className="kb-modal">
          <div className="modal-header">
            <div className="modal-key-row">
              <span className="type-badge task">TASK</span>
              <span className="card-key">Nova task</span>
            </div>
            <div className="modal-title-row">
              <input
                ref={titleRef}
                className="card-title-input"
                value={title}
                placeholder="Título da task (obrigatório)"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            <div className="modal-section">
              <div className="field-row">
                <div className="field">
                  <label>Coluna</label>
                  <select
                    className="select-inline"
                    value={columnId ?? ""}
                    onChange={(event) => setColumnId(event.target.value || null)}
                  >
                    {creatableColumns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="modal-section">
              <div className="modal-section-title">Descrição</div>
              <textarea
                className="card-desc-input"
                rows={4}
                value={description}
                placeholder="Descreva o que a task precisa entregar…"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="modal-section">
              <div className="field-row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button className="kb-btn kb-btn-ghost" onClick={onClose}>
                  Cancelar
                </button>
                <button className="kb-btn kb-btn-primary" onClick={submit} disabled={!canSubmit}>
                  {createCard.isPending ? "Criando…" : "Criar task"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StoryModal({
  boardId,
  storyId,
  boardColumns,
  boardLabels,
  boardAssignees,
  onOpenTask,
  onClose,
}: {
  boardId: string;
  storyId: string;
  boardColumns: ApiBoardColumn[];
  boardLabels: Array<{ id: string; name: string; color: string }>;
  boardAssignees: Array<{ id: string; name: string; model: string | null }>;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  const { data: story } = useCard(storyId);
  const updateCard = useUpdateCard();
  const { addFlow, removeFlow } = useFlows();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [points, setPoints] = useState("");
  const [aiProject, setAiProject] = useState("");
  const [aiNotes, setAiNotes] = useState("");
  const [flowName, setFlowName] = useState("");
  const [createTaskColumnId, setCreateTaskColumnId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!story) return;
    setTitle(story.title);
    setDescription(story.description ?? "");
    setPoints(story.points ? String(story.points) : "");
    setAiProject(story.aiProject ?? "");
    setAiNotes(story.aiNotes ?? "");
  }, [story]);

  if (!story) return null;

  const tasks = story.children.filter((child) => child.type === "task").sort((a, b) => a.position - b.position);
  const taskColumns = boardColumns
    .filter((column) => column.isTaskColumn)
    .filter((column) => TASK_COLUMNS.includes(column.title as (typeof TASK_COLUMNS)[number]))
    .sort((a, b) => a.position - b.position);

  const saveCard = () =>
    updateCard.mutate({
      boardId,
      cardId: story.id,
      dto: {
        title,
        description,
        points: points ? (Number(points) as StoryPoints) : null,
      },
    });

  const saveAiContext = () =>
    updateCard.mutate({ boardId, cardId: story.id, dto: { aiProject, aiNotes } });

  const addFlowItem = () => {
    const value = flowName.trim();
    if (!value) return;
    addFlow.mutate({ boardId, cardId: story.id, dto: { name: value, files: [] } });
    setFlowName("");
  };

  const createTask = () => {
    const todoColumn = taskColumns.find((column) => column.title === "To Do");
    setCreateTaskColumnId(todoColumn?.id ?? null);
  };

  return (
    <>
      <ModalPanel>
      <div className="modal-header">
        <div className="modal-key-row">
          <span className="type-badge story">STORY</span>
          <span className="card-key">{story.key}</span>
          {story.blocked ? <span className="blocked-flag">⛔ BLOQUEADO</span> : null}
          {story.points != null ? <span className="points-badge">{story.points}</span> : null}
        </div>
        <div className="modal-title-row">
          <input
            className="card-title-input"
            value={title}
            placeholder="Título da história"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveCard}
          />
          <button className="modal-close" onClick={onClose} aria-label="Fechar história">
            ✕
          </button>
        </div>
      </div>
      <div className="modal-body">
        <div className="modal-section">
          <div className="field-row">
            <div className="field">
              <label>Story Points</label>
              <select
                className="select-inline"
                value={points}
                onChange={(event) => {
                  setPoints(event.target.value);
                  updateCard.mutate({
                    boardId,
                    cardId: story.id,
                    dto: {
                      title,
                      description,
                      points: event.target.value ? (Number(event.target.value) as StoryPoints) : null,
                    },
                  });
                }}
              >
                <option value="">—</option>
                {STORY_POINTS.map((point) => (
                  <option key={point} value={String(point)}>
                    {point}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">Descrição</div>
          <textarea
            className="card-desc-input"
            rows={3}
            value={description}
            placeholder="Como um <usuário>, quero <objetivo>, para <benefício>…"
            onChange={(event) => setDescription(event.target.value)}
            onBlur={saveCard}
          />
        </div>

        <div className="modal-section">
          <div className="modal-section-title">Projeto-alvo (repositório onde a AI trabalha)</div>
          <input
            className="card-desc-input"
            value={aiProject}
            placeholder="Deixe vazio para herdar do épico, ou informe /caminho/do/repo"
            onChange={(event) => setAiProject(event.target.value)}
            onBlur={saveAiContext}
          />
          <div className="modal-hint">
            A AI cria uma branch/worktree isolada nesse repositório. Se vazio,
            herda o projeto-alvo do épico pai.
          </div>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">Notas para a AI (contexto/escopo)</div>
          <textarea
            className="card-desc-input"
            rows={3}
            value={aiNotes}
            placeholder="Instruções, restrições e escopo para o agent…"
            onChange={(event) => setAiNotes(event.target.value)}
            onBlur={saveAiContext}
          />
        </div>

        <CardModelSelector boardId={boardId} card={story} />

        <LabelsSection card={story} boardId={boardId} boardLabels={boardLabels} />
        <AssigneesSection card={story} boardId={boardId} boardAssignees={boardAssignees} />

        <div className="modal-section">
          <div className="modal-section-title">
            🌊 Fluxos afetados
            {story.affectedFlows.length ? <span>({story.affectedFlows.length})</span> : null}
          </div>
          <div className="flows-list">
            {story.affectedFlows.length === 0 ? (
              <div className="diary-empty">Nenhum fluxo mapeado. A validação final usa esta lista.</div>
            ) : null}
            {story.affectedFlows.map((flow) => (
              <div key={flow.id} className="flow-item">
                <div className="flow-top">
                  <span className="flow-name">{flow.name}</span>
                  <button
                    className="flow-del"
                    onClick={() => removeFlow.mutate({ boardId, cardId: story.id, flowId: flow.id })}
                  >
                    🗑
                  </button>
                </div>
                {flow.files.length ? <div className="flow-files">{flow.files.join(", ")}</div> : null}
              </div>
            ))}
          </div>
          <div className="add-check-row">
            <input
              className="criteria-input"
              value={flowName}
              placeholder="Nome do fluxo (ex.: Cadastro de caixa)…"
              onChange={(event) => setFlowName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addFlowItem();
                }
              }}
            />
            <button className="kb-btn kb-btn-ghost kb-btn-sm" onClick={addFlowItem}>
              + Adicionar fluxo
            </button>
          </div>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">
            Tasks
            {tasks.length ? (
              <span>
                {tasks.filter((task) => {
                  const doneColumn = taskColumns.find((column) => column.title === "Done");
                  return doneColumn ? task.taskColumnId === doneColumn.id : false;
                }).length}
                /{tasks.length}
              </span>
            ) : null}
            <button className="kb-btn kb-btn-ghost kb-btn-sm" style={{ marginLeft: "auto" }} onClick={createTask}>
              + Task
            </button>
          </div>
          <MiniKanban
            boardId={boardId}
            columns={taskColumns}
            cards={tasks}
            fallbackColumn={(card) => card.taskColumnId}
            onOpenCard={(card) => onOpenTask(card.id)}
            onAddCard={(columnId) => setCreateTaskColumnId(columnId)}
            addLabel="+ Task"
            allowAddOn={(column) => column.title === "To Do"}
          />
        </div>

        <div className="modal-section">
          <div className="modal-section-title">📊 Custo & qualidade do loop</div>
          <LoopMetricsPanel storyId={story.id} />
        </div>

        <ChecklistSection card={story} boardId={boardId} />
        <CommentsSection card={story} />
        <ActivitySection card={story} />
        <DangerZoneSection boardId={boardId} card={story} onDeleted={onClose} />
      </div>
    </ModalPanel>
      {createTaskColumnId !== undefined ? (
        <CreateTaskModal
          boardId={boardId}
          parentId={story.id}
          taskColumns={taskColumns}
          defaultColumnId={createTaskColumnId}
          onClose={() => setCreateTaskColumnId(undefined)}
          onCreated={(taskId) => onOpenTask(taskId)}
        />
      ) : null}
    </>
  );
}

function TaskLoopControls({ task, boardId }: { task: ApiCardDetails; boardId: string }) {
  const storyId = task.parentId;
  const { data: loopState } = useLoopState(storyId, Boolean(storyId));
  const stepLoop = useStepLoop(boardId);
  const { start, stop } = useAutoPlay(boardId);

  const running = loopState?.isAutoRunning ?? false;
  const execState = task.execState ?? "idle";
  const deps = task.dependsOn ?? [];
  const busy = stepLoop.isPending || start.isPending || stop.isPending;

  const onStep = () => {
    if (storyId) stepLoop.mutate(storyId);
  };
  const onToggleAuto = () => {
    if (!storyId) return;
    if (running) stop.mutate({ storyId, mode: "graceful" });
    else start.mutate(storyId);
  };

  return (
    <div className="modal-section">
      <div className="modal-section-title">🤖 Loop do agente</div>

      {task.loopType ? (
        <div className="ai-loop-type">
          Perfil de loop: <strong>{task.loopType}</strong>
        </div>
      ) : null}

      {task.derivedFromId ? (
        <div className="ai-derived">🔗 Task derivada de uma validação</div>
      ) : null}

      {deps.length > 0 ? (
        <div className="ai-deps">
          ⏳ Aguarda:{" "}
          {deps.map((dep, index) => (
            <span key={dep.dependsOn.id}>
              {dep.dependsOn.key}
              {dep.dependsOn.execState === "done" ? " ✓" : ""}
              {index < deps.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      ) : null}

      <div className="ai-exec-controls">
        <button
          className="btn btn-ghost btn-sm"
          onClick={onStep}
          disabled={!storyId || execState === "done" || busy}
        >
          ▶ Rodar 1 iteração
        </button>
        <button
          className={"btn btn-sm " + (running ? "btn-ghost" : "btn-primary")}
          onClick={onToggleAuto}
          disabled={!storyId || busy}
        >
          {running ? "⏸ Parar auto-play" : "⏩ Auto-play"}
        </button>
      </div>
    </div>
  );
}

/** Chat/transcript do agente (streaming + HITL) — shadcn puro, sem TanStack AI. */
function TaskChat({ task }: { task: ApiCardDetails }) {
  const storyId = task.parentId;
  const { messages, pending, isAnswering, answer } = useAgentChat(task.id, storyId);
  const streaming = useAgentChatStore((s) => Boolean(s.byTask[task.id]?.streaming));
  const thinking = streaming && !pending;

  // Mapeia o transcript do agente (domínio) para o shape genérico do ChatPanel,
  // resolvendo phase meta e o rótulo de "pensando" aqui — o painel é agnóstico.
  const panelMessages: ChatPanelMessage[] = messages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    text: msg.text,
    kind: msg.kind === "thought" ? "pensando" : undefined,
    phase: msg.phase ? PHASE_META[msg.phase] ?? null : null,
  }));

  const hasOptions = Boolean(pending?.options && pending.options.length > 0);

  return (
    <div className="modal-section">
      <div className="modal-section-title">💬 Conversa com o agente</div>
      <ChatPanel
        messages={panelMessages}
        pending={pending ? { options: pending.options } : null}
        thinking={thinking}
        busy={isAnswering}
        inputMode="when-pending"
        submitLabel="Responder"
        busyLabel="Enviando…"
        emptyState="Sem atividade ainda. Rode uma iteração para ver o agente pensar ao vivo."
        disabledPlaceholder="Disponível quando o agente perguntar"
        placeholder={hasOptions ? "Escolha acima ou escreva sua resposta…" : "Responda ao agente…"}
        onSend={answer}
        onQuickReply={answer}
      />
    </div>
  );
}

function TaskModal({
  boardId,
  taskId,
  boardLabels,
  boardAssignees,
  onClose,
}: {
  boardId: string;
  taskId: string;
  boardLabels: Array<{ id: string; name: string; color: string }>;
  boardAssignees: Array<{ id: string; name: string; model: string | null }>;
  onClose: () => void;
}) {
  const { data: task } = useCard(taskId);
  const updateCard = useUpdateCard();
  const chatPending = useAgentChatStore((s) => s.byTask[taskId]?.pending ?? null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
  }, [task]);

  if (!task) return null;

  const execState = task.execState ?? "idle";
  const execMeta = EXEC_STATE_META[execState] ?? EXEC_STATE_META.idle;

  const saveCard = () => updateCard.mutate({ boardId, cardId: task.id, dto: { title, description } });

  return (
    <ModalPanel level="task">
      <div className="modal-header">
        <div className="modal-key-row">
          <span className="type-badge task">TASK</span>
          <span className="card-key">{task.key}</span>
          {task.blocked ? <span className="blocked-flag">⛔ BLOQUEADO</span> : null}
          {task.needsHuman ? (
            <span className="needs-human-badge" title={task.needsHumanReason ?? "Precisa de você"}>
              🙋 precisa de você
            </span>
          ) : null}
          {chatPending ? <span className="awaiting-badge">✋ aguardando você</span> : null}
          <span className={"exec-badge st-" + execMeta.cls} style={{ marginLeft: "auto" }}>
            {execMeta.label}
          </span>
        </div>
        <div className="modal-title-row">
          <input
            className="card-title-input"
            value={title}
            placeholder="Título da task"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveCard}
          />
          <button className="modal-close" onClick={onClose} aria-label="Fechar task">
            ✕
          </button>
        </div>
      </div>
      <div className="modal-body">
        <div className="modal-section">
          <div className="modal-section-title">Descrição</div>
          <textarea
            className="card-desc-input"
            rows={3}
            value={description}
            placeholder="Descrição da task…"
            onChange={(event) => setDescription(event.target.value)}
            onBlur={saveCard}
          />
        </div>

        <LabelsSection card={task} boardId={boardId} boardLabels={boardLabels} />
        <AssigneesSection card={task} boardId={boardId} boardAssignees={boardAssignees} />
        <CardModelSelector boardId={boardId} card={task} />
        <ChecklistSection card={task} boardId={boardId} />

        <TaskLoopControls task={task} boardId={boardId} />

        <TaskChat task={task} />

        <div className="modal-section">
          <div className="modal-section-title">📓 Diário de iterações</div>
          <div className="diary">
            {task.iterations.length === 0 ? (
              <div className="diary-empty">
                Sem iterações ainda. Rode 1 iteração ou mova a história para In Progress.
              </div>
            ) : null}
            {task.iterations.map((iteration) => {
              const phase = PHASE_META[iteration.phase] ?? { label: iteration.phase, emoji: "•" };
              return (
                <div key={iteration.id} className="iter">
                  <div className="iter-head">
                    <span className="iter-phase">
                      {phase.emoji} {phase.label}
                    </span>
                    <span className="iter-idx">#{iteration.index}</span>
                    <span className="iter-agent">{relativeTime(iteration.ts)}</span>
                  </div>
                  {iteration.summary ? (
                    <div className="iter-summary">{cleanChatText(iteration.summary)}</div>
                  ) : null}
                  {iteration.detail ? (
                    <div className="iter-detail">{cleanChatText(iteration.detail)}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">🎞️ Diff / Replay por iteração</div>
          <IterationDiffViewer iterations={task.iterations} />
        </div>

        <CommentsSection card={task} />
        <ActivitySection card={task} />
        <DangerZoneSection boardId={boardId} card={task} onDeleted={onClose} />
      </div>
    </ModalPanel>
  );
}

/**
 * O agent só consegue trabalhar numa story se houver um Projeto-alvo (repo onde
 * a AI cria o worktree isolado). Uma story herda o `aiProject` do épico pai.
 * Retorna o projeto-alvo EFETIVO (próprio ou herdado) já normalizado, ou "".
 */
function resolveEffectiveProject(
  card: Pick<ApiCardSummary, "aiProject" | "parentId">,
  allCards: ApiCardSummary[],
): string {
  const own = card.aiProject?.trim() ?? "";
  if (own) return own;
  if (!card.parentId) return "";
  const parent = allCards.find((c) => c.id === card.parentId);
  return parent?.aiProject?.trim() ?? "";
}

/** Uma coluna do board é "In Progress"? (a que dispara o loop engine). */
function isInProgressColumn(column: ApiBoardColumn | undefined): boolean {
  return column?.title.trim().toLowerCase() === "in progress";
}

/**
 * Move pendente que foi bloqueado por faltar campo obrigatório. Guardamos tudo
 * o que precisamos para refazer o move depois que o usuário preencher o campo.
 */
interface PendingMove {
  cardId: string;
  cardKey: string;
  cardTitle: string;
  columnId: string;
  parentId: string | null;
  /** Nome do épico pai, se herdaria dele (para orientar o usuário). */
  parentKey?: string | null;
}

/**
 * Modal que EXIGE o Projeto-alvo antes de mover uma story para In Progress.
 * Deixa óbvio qual campo preencher e, ao salvar, grava o `aiProject` na story e
 * então efetiva o move original.
 */
function RequiredFieldsModal({
  boardId,
  pending,
  onClose,
  onSatisfied,
}: {
  boardId: string;
  pending: PendingMove;
  onClose: () => void;
  onSatisfied: (move: PendingMove) => void;
}) {
  const updateCard = useUpdateCard();
  const [aiProject, setAiProject] = useState("");

  const value = aiProject.trim();
  const canSave = value.length > 0 && !updateCard.isPending;

  const handleSave = () => {
    if (!canSave) return;
    updateCard.mutate(
      { boardId, cardId: pending.cardId, dto: { aiProject: value } },
      {
        onSuccess: () => {
          onSatisfied(pending);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="required-fields-dialog">
        <DialogHeader>
          <DialogTitle>Falta o Projeto-alvo para mover a story</DialogTitle>
          <DialogDescription>
            A story <strong>{pending.cardKey}</strong> só pode entrar em{" "}
            <strong>In Progress</strong> depois que você definir o repositório
            onde a AI vai trabalhar. Sem isso o agent não tem onde criar o
            worktree isolado.
          </DialogDescription>
        </DialogHeader>

        <div className="required-field-block">
          <label className="required-field-label" htmlFor="required-ai-project">
            Projeto-alvo (repositório onde a AI trabalha){" "}
            <span className="required-field-mark">*obrigatório</span>
          </label>
          <input
            id="required-ai-project"
            className="card-desc-input required-field-input"
            autoFocus
            value={aiProject}
            placeholder="/caminho/absoluto/do/repositorio"
            onChange={(event) => setAiProject(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSave();
            }}
          />
          <div className="modal-hint">
            Caminho absoluto do repositório onde a AI cria uma branch/worktree
            isolada. Ex.: <code>/home/voce/dev/meu-projeto</code>.
          </div>
        </div>

        <DialogFooter>
          <button className="kb-btn" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="kb-btn kb-btn-primary"
            type="button"
            disabled={!canSave}
            onClick={handleSave}
          >
            {updateCard.isPending ? "Salvando…" : "Salvar e mover"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BoardView() {
  const { boardId, isLoading: loadingBoards, isError: boardError } = usePrimaryBoardId();
  const { data: board } = useBoard(boardId);
  const { data: cards } = useCards(boardId);
  const moveCard = useMoveCard();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const [createEpicOpen, setCreateEpicOpen] = useState(false);
  const [createStoryCtx, setCreateStoryCtx] = useState<{ columnId: string; parentId: string | null } | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  const { modals, openEpic, openStory, openTask, closeAllModals, closeTopModal, setDraggedCard, draggedCardId } =
    useBoardUiStore();
  const filters = useBoardUiStore((state) => state.filters);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTopModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeTopModal]);

  const boardColumns = (board?.columns ?? [])
    .filter((column) => !column.isTaskColumn)
    .filter((column) => BOARD_COLUMNS.includes(column.title as (typeof BOARD_COLUMNS)[number]))
    .sort((a, b) => a.position - b.position);

  const cardMatches = (card: ApiCardSummary) => {
    if (filters.label && !(card.labelIds ?? []).includes(filters.label)) return false;
    if (filters.assignee && !(card.assigneeIds ?? []).includes(filters.assignee)) return false;
    if (filters.q) {
      const haystack = (card.title + " " + card.description + " " + card.key).toLowerCase();
      if (!haystack.includes(filters.q.trim().toLowerCase())) return false;
    }
    return true;
  };

  // O filtro "Só Tasks" esconde as stories do board principal (tasks vivem dentro
  // das stories). "Só Histórias" e o valor vazio mantêm as stories visíveis.
  const showStories = filters.type !== "task";

  const epics = (cards ?? []).filter((card) => card.type === "epic").sort((a, b) => a.position - b.position);
  const stories = showStories
    ? (cards ?? [])
        .filter((card) => card.type === "story")
        .filter(cardMatches)
        .sort((a, b) => a.position - b.position)
    : [];

  if (loadingBoards) {
    return (
      <div className="work-area">
        <div className="board">Carregando board…</div>
      </div>
    );
  }
  if (boardError || !boardId) {
    return (
      <div className="work-area">
        <div className="board">Não foi possível carregar boards.</div>
      </div>
    );
  }

  const openModals = [modals.epicId, modals.storyId, modals.taskId].filter(Boolean).length;
  const modalLayerClass =
    "modal-layer" + (openModals >= 3 ? " depth-3" : openModals === 2 ? " depth-2" : "");

  return (
    <div className="work-area">
      <aside className="epics-sidebar">
        <div className="epics-header">
          <span className="epics-title">ÉPICOS</span>
          <span className="column-count">{epics.length}</span>
          <button
            className="kb-btn kb-btn-primary kb-btn-sm"
            type="button"
            title="Criar novo épico"
            style={{ marginLeft: "auto" }}
            onClick={() => setCreateEpicOpen(true)}
          >
            + Épico
          </button>
        </div>
        <div className="epics-list">
          {epics.length === 0 ? (
            <div className="epic-empty">Nenhum épico ainda. Crie um para agrupar histórias.</div>
          ) : null}
          {epics.map((epic) => {
            const status = epic.epicStatus?.status ?? "todo";
            const done = epic.epicStatus?.done ?? 0;
            const total = epic.epicStatus?.total ?? 0;
            const width = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <div
                key={epic.id}
                className={"epic-card status-" + status}
                onClick={() => openEpic(epic.id)}
              >
                <div className="epic-top">
                  <span className="epic-key">{epic.key}</span>
                  {epic.blocked ? <span>⛔</span> : null}
                  <span className={"epic-status status-" + status}>{epicStatusLabel(status)}</span>
                </div>
                <div className="epic-title">{epic.title}</div>
                <div className="epic-progress">
                  <span style={{ width: width + "%" }} />
                </div>
                <div className="epic-meta">
                  <span>
                    🧩 {done}/{total} histórias
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <DndContext
        sensors={sensors}
        collisionDetection={boardCollision}
        onDragStart={(event: DragStartEvent) => setDraggedCard(String(event.active.id))}
        onDragOver={(event: DragOverEvent) => {
          const overId = event.over ? String(event.over.id) : "";
          const activeId = String(event.active.id);
          const column = overId ? getColumnFromOverId(overId, stories, activeId, (card) => card.boardColumnId) : null;
          setOverColumnId(column);
        }}
        onDragCancel={() => {
          setDraggedCard(null);
          setOverColumnId(null);
        }}
        onDragEnd={(event: DragEndEvent) => {
          setDraggedCard(null);
          setOverColumnId(null);
          const activeId = String(event.active.id);
          const overId = event.over ? String(event.over.id) : "";
          if (!overId) return;
          const destination = getColumnFromOverId(overId, stories, activeId, (card) => card.boardColumnId);
          if (!destination) return;
          const movedStory = stories.find((story) => story.id === activeId);

          // GATE: mover uma story para In Progress exige Projeto-alvo (aiProject)
          // definido — próprio ou herdado do épico pai. Se faltar, não movemos;
          // abrimos o modal exigindo o campo (o backend também recusa, defesa em
          // profundidade). Ver CardsService.move.
          const destColumn = (board?.columns ?? []).find((column) => column.id === destination);
          if (movedStory && isInProgressColumn(destColumn)) {
            const effective = resolveEffectiveProject(movedStory, cards ?? []);
            if (!effective) {
              const parent = movedStory.parentId
                ? (cards ?? []).find((c) => c.id === movedStory.parentId)
                : null;
              setPendingMove({
                cardId: movedStory.id,
                cardKey: movedStory.key,
                cardTitle: movedStory.title,
                columnId: destination,
                parentId: movedStory.parentId ?? null,
                parentKey: parent?.key ?? null,
              });
              return;
            }
          }

          moveCard.mutate({
            boardId,
            cardId: activeId,
            dto: { columnId: destination },
            parentId: movedStory?.parentId ?? null,
          });
        }}
      >
        <div className="board">
          {boardColumns.map((column) => (
            <StoryColumn
              key={column.id}
              column={column}
              stories={stories.filter((story) => story.boardColumnId === column.id)}
              isDropTarget={overColumnId === column.id && draggedCardId != null}
              onOpenStory={(story) => openStory(story.id)}
              onCreateStory={(columnId) => setCreateStoryCtx({ columnId, parentId: null })}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {draggedCardId
            ? (() => {
                const dragged = stories.find((story) => story.id === draggedCardId);
                return dragged ? (
                  <div className={"card type-story" + (dragged.blocked ? " blocked" : "") + " dragging-overlay"}>
                    <StoryCardContent card={dragged} />
                  </div>
                ) : null;
              })()
            : null}
        </DragOverlay>
      </DndContext>

      {openModals > 0 ? (
        <div className={modalLayerClass} onClick={closeAllModals}>
          {modals.epicId ? (
            <EpicModal
              boardId={boardId}
              epicId={modals.epicId}
              boardColumns={board?.columns ?? []}
              stories={stories}
              onOpenStory={(storyId) => openStory(storyId)}
              onClose={closeTopModal}
              onCreateStory={(columnId, parentId) => setCreateStoryCtx({ columnId, parentId })}
            />
          ) : null}

          {modals.storyId ? (
            <StoryModal
              boardId={boardId}
              storyId={modals.storyId}
              boardColumns={board?.columns ?? []}
              boardLabels={board?.labels ?? []}
              boardAssignees={board?.assignees ?? []}
              onOpenTask={openTask}
              onClose={closeTopModal}
            />
          ) : null}

          {modals.taskId ? (
            <TaskModal
              boardId={boardId}
              taskId={modals.taskId}
              boardLabels={board?.labels ?? []}
              boardAssignees={board?.assignees ?? []}
              onClose={closeTopModal}
            />
          ) : null}
        </div>
      ) : null}

      {createEpicOpen ? (
        <CreateEpicModal
          boardId={boardId}
          boardColumns={board?.columns ?? []}
          onClose={() => setCreateEpicOpen(false)}
          onCreated={(epicId) => {
            setCreateEpicOpen(false);
            openEpic(epicId);
          }}
        />
      ) : null}

      {createStoryCtx ? (
        <CreateStoryModal
          boardId={boardId}
          boardColumns={board?.columns ?? []}
          columnId={createStoryCtx.columnId}
          parentId={createStoryCtx.parentId}
          onClose={() => setCreateStoryCtx(null)}
          onCreated={(storyId) => {
            setCreateStoryCtx(null);
            openStory(storyId);
          }}
        />
      ) : null}

      {pendingMove ? (
        <RequiredFieldsModal
          boardId={boardId}
          pending={pendingMove}
          onClose={() => setPendingMove(null)}
          onSatisfied={(move) => {
            moveCard.mutate({
              boardId,
              cardId: move.cardId,
              dto: { columnId: move.columnId },
              parentId: move.parentId,
            });
          }}
        />
      ) : null}
    </div>
  );
}
