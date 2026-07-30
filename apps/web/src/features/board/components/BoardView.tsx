import { useEffect, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ExecState, StoryPoints } from "@kanban-ai/shared";

import { useCardAssignees } from "@/features/assignees";
import { useBoard, useCards, useCreateCard, useMoveCard, usePrimaryBoardId } from "@/features/board/hooks";
import { useBoardUiStore } from "@/features/board/services";
import { useCardLabels } from "@/features/labels";
import { useCard, useDodMutations, useFlows, useUpdateCard } from "@/features/stories";
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

function StoryCard({ card, onOpen }: { card: ApiCardSummary; onOpen: (card: ApiCardSummary) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const hasDescription = Boolean(card.description && card.description.trim());

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={"card type-story" + (card.blocked ? " blocked" : "") + (isDragging ? " dragging" : "")}
      onClick={() => onOpen(card)}
      {...attributes}
      {...listeners}
    >
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
    </div>
  );
}

function StoryColumn({
  column,
  stories,
  onOpenStory,
  onCreateStory,
}: {
  column: ApiBoardColumn;
  stories: ApiCardSummary[];
  onOpenStory: (card: ApiCardSummary) => void;
  onCreateStory: (columnId: string) => void;
}) {
  const points = stories.reduce((sum, story) => sum + (story.points ?? 0), 0);
  const overLimit = column.wipLimit != null && stories.length > column.wipLimit;
  const allowsCreate = column.title === "Backlog" || column.title === "To Do";

  return (
    <div className="column">
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
        <div id={"column:" + column.id} className="card-list">
          {stories.map((story) => (
            <StoryCard key={story.id} card={story} onOpen={onOpenStory} />
          ))}
        </div>
      </SortableContext>
      {allowsCreate ? (
        <button className="add-card-btn" onClick={() => onCreateStory(column.id)}>
          + Adicionar história
        </button>
      ) : null}
    </div>
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
      <div className="task-card-top">
        <span className="card-key">{card.key}</span>
        {showPoints && card.points != null ? <span className="points-badge">{card.points}</span> : null}
        {card.blocked ? <span>⛔</span> : null}
      </div>
      <div className="task-card-title">{card.title}</div>
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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        const activeId = String(event.active.id);
        const overId = event.over ? String(event.over.id) : "";
        if (!overId) return;
        const destination = getColumnFromOverId(overId, cards, activeId, fallbackColumn);
        if (!destination) return;
        moveCard.mutate({ boardId, cardId: activeId, dto: { columnId: destination } });
      }}
    >
      <div className="task-board">
        {columns.map((column) => {
          const items = cards.filter((card) => fallbackColumn(card) === column.id);
          const canAdd = Boolean(onAddCard) && (allowAddOn ? allowAddOn(column) : true);
          return (
            <div key={column.id} className="task-col">
              <div className="task-col-head">
                <span className="task-col-title">{column.title}</span>
                <span className="task-col-count">{items.length}</span>
              </div>
              <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <div id={"column:" + column.id} className="task-list">
                  {items.map((item) => (
                    <MiniCard key={item.id} card={item} onOpen={onOpenCard} showPoints />
                  ))}
                </div>
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
  const { attachLabel, detachLabel } = useCardLabels();
  const selected = new Set(card.labels.map((entry) => entry.label.id));

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
            </span>
          );
        })}
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
  const flowColumns = boardColumns.filter((column) => !column.isTaskColumn).sort((a, b) => a.position - b.position);
  const epicStories = stories.filter((story) => story.parentId === epicId).sort((a, b) => a.position - b.position);
  const done = epic?.epicStatus?.done ?? 0;
  const total = epic?.epicStatus?.total ?? 0;

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
          <input className="card-title-input" value={epic?.title ?? ""} readOnly />
          <button className="modal-close" onClick={onClose} aria-label="Fechar épico">
            ✕
          </button>
        </div>
      </div>
      <div className="modal-body">
        {epic?.description ? (
          <div className="modal-section">
            <div className="modal-section-title">Descrição</div>
            <div className="card-desc-input" style={{ whiteSpace: "pre-wrap" }}>
              {epic.description}
            </div>
          </div>
        ) : null}
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
      </div>
    </ModalPanel>
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
  const createCard = useCreateCard(boardId);
  const { addFlow, removeFlow } = useFlows();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [points, setPoints] = useState("");
  const [flowName, setFlowName] = useState("");

  useEffect(() => {
    if (!story) return;
    setTitle(story.title);
    setDescription(story.description ?? "");
    setPoints(story.points ? String(story.points) : "");
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

  const addFlowItem = () => {
    const value = flowName.trim();
    if (!value) return;
    addFlow.mutate({ boardId, cardId: story.id, dto: { name: value, files: [] } });
    setFlowName("");
  };

  const createTask = () => {
    const todoColumn = taskColumns.find((column) => column.title === "To Do");
    if (!todoColumn) return;
    createCard.mutate({
      dto: { boardId, type: "task", title: "Nova task", parentId: story.id, columnId: todoColumn.id },
    });
  };

  return (
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
            onAddCard={(columnId) => {
              createCard.mutate({
                dto: { boardId, type: "task", title: "Nova task", parentId: story.id, columnId },
              });
            }}
            addLabel="+ Task"
            allowAddOn={(column) => column.title === "To Do"}
          />
        </div>

        <ChecklistSection card={story} boardId={boardId} />
        <CommentsSection card={story} />
        <ActivitySection card={story} />
      </div>
    </ModalPanel>
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
        <ChecklistSection card={task} boardId={boardId} />

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
                  {iteration.summary ? <div className="iter-summary">{iteration.summary}</div> : null}
                  {iteration.detail ? <div className="iter-detail">{iteration.detail}</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ModalPanel>
  );
}

export function BoardView() {
  const { boardId, isLoading: loadingBoards, isError: boardError } = usePrimaryBoardId();
  const { data: board } = useBoard(boardId);
  const { data: cards } = useCards(boardId);
  const moveCard = useMoveCard();
  const createCard = useCreateCard(boardId);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { modals, openEpic, openStory, openTask, closeAllModals, closeTopModal, setDraggedCard } = useBoardUiStore();

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

  const epics = (cards ?? []).filter((card) => card.type === "epic").sort((a, b) => a.position - b.position);
  const stories = (cards ?? []).filter((card) => card.type === "story").sort((a, b) => a.position - b.position);

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
        collisionDetection={closestCenter}
        onDragStart={(event: DragStartEvent) => setDraggedCard(String(event.active.id))}
        onDragCancel={() => setDraggedCard(null)}
        onDragEnd={(event: DragEndEvent) => {
          setDraggedCard(null);
          const activeId = String(event.active.id);
          const overId = event.over ? String(event.over.id) : "";
          if (!overId) return;
          const destination = getColumnFromOverId(overId, stories, activeId, (card) => card.boardColumnId);
          if (!destination) return;
          moveCard.mutate({ boardId, cardId: activeId, dto: { columnId: destination } });
        }}
      >
        <div className="board">
          {boardColumns.map((column) => (
            <StoryColumn
              key={column.id}
              column={column}
              stories={stories.filter((story) => story.boardColumnId === column.id)}
              onOpenStory={(story) => openStory(story.id, story.parentId)}
              onCreateStory={(columnId) =>
                createCard.mutate({
                  dto: { boardId, type: "story", title: "Nova story", columnId, points: 1 },
                })
              }
            />
          ))}
        </div>
      </DndContext>

      {openModals > 0 ? (
        <div className={modalLayerClass} onClick={closeAllModals}>
          {modals.epicId ? (
            <EpicModal
              boardId={boardId}
              epicId={modals.epicId}
              boardColumns={board?.columns ?? []}
              stories={stories}
              onOpenStory={(storyId) => openStory(storyId, modals.epicId)}
              onClose={closeTopModal}
              onCreateStory={(columnId, parentId) =>
                createCard.mutate({
                  dto: { boardId, type: "story", title: "Nova story", columnId, parentId, points: 1 },
                })
              }
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
    </div>
  );
}
