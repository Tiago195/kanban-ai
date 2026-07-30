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
import type { StoryPoints } from "@kanban-ai/shared";
import { Check, Plus, Trash2 } from "lucide-react";

import { useCardAssignees } from "@/features/assignees";
import { useBoard, useCards, useCreateCard, useMoveCard, usePrimaryBoardId } from "@/features/board/hooks";
import { useBoardUiStore } from "@/features/board/services";
import { useCardLabels } from "@/features/labels";
import { useCard, useDodMutations, useFlows, useUpdateCard } from "@/features/stories";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/components/ui/select";
import { Separator } from "@/shared/components/ui/separator";
import { Textarea } from "@/shared/components/ui/textarea";
import { cn } from "@/shared/utils/cn";
import type { ApiBoardColumn, ApiCardDetails, ApiCardSummary } from "@/shared/types";

const BOARD_COLUMNS = ["Backlog", "To Do", "In Progress", "Review", "Done"] as const;
const STORY_POINTS = [1, 2, 3, 5, 8, 13] as const;
const TASK_COLUMNS = ["To Do", "In Progress", "Review", "Done"] as const;

function SortableCardItem({ card, onClick }: { card: ApiCardSummary; onClick: (card: ApiCardSummary) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });

  return (
    <button
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "w-full rounded-md border bg-card p-3 text-left shadow-sm hover:border-primary/50",
        isDragging && "opacity-70",
      )}
      onClick={() => onClick(card)}
      {...attributes}
      {...listeners}
    >
      <p className="text-xs text-muted-foreground">{card.key}</p>
      <p className="text-sm font-medium">{card.title}</p>
    </button>
  );
}

function statusLabel(status?: "todo" | "inprogress" | "done") {
  if (status === "done") return "Done";
  if (status === "inprogress") return "In Progress";
  return "To Do";
}

function statusVariant(status?: "todo" | "inprogress" | "done"): "outline" | "secondary" {
  if (status === "done") return "secondary";
  return "outline";
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

function SidePanel({
  open,
  onOpenChange,
  index,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        showOverlay={false}
        className="top-20 h-[calc(100vh-6rem)] w-[420px] translate-x-0 translate-y-0 p-0"
        style={{ left: 80 + index * 440 }}
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="h-[calc(100%-57px)] px-4 py-3">{children}</ScrollArea>
      </DialogContent>
    </Dialog>
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
  return (
    <div className="flex h-full min-h-[480px] w-64 flex-col rounded-lg border bg-muted/30">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-semibold">{column.title}</h3>
        {(column.title === "Backlog" || column.title === "To Do") && (
          <Button variant="ghost" size="icon" onClick={() => onCreateStory(column.id)}>
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
      <ScrollArea className="h-[430px] p-2">
        <SortableContext items={stories.map((story) => story.id)} strategy={verticalListSortingStrategy}>
          <div id={"column:" + column.id} className="space-y-2">
            {stories.map((story) => (
              <SortableCardItem key={story.id} card={story} onClick={onOpenStory} />
            ))}
          </div>
        </SortableContext>
      </ScrollArea>
    </div>
  );
}

function DodSection({ card, boardId }: { card: ApiCardDetails; boardId: string }) {
  const [text, setText] = useState("");
  const { addDod, updateDod, removeDod } = useDodMutations();

  return (
    <section className="space-y-2">
      <p className="text-sm font-semibold">DOD</p>
      <div className="space-y-2">
        {card.dodItems.map((item) => (
          <div key={item.id} className="flex items-center gap-2 rounded border p-2">
            <button
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded border",
                item.done && "bg-primary text-primary-foreground",
              )}
              onClick={() =>
                updateDod.mutate({ boardId, cardId: card.id, itemId: item.id, dto: { done: !item.done } })
              }
            >
              {item.done ? <Check className="h-3.5 w-3.5" /> : null}
            </button>
            <span className={cn("flex-1 text-sm", item.done && "line-through text-muted-foreground")}>{item.text}</span>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => removeDod.mutate({ boardId, cardId: card.id, itemId: item.id })}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="Novo item" />
        <Button
          onClick={() => {
            if (!text.trim()) return;
            addDod.mutate({ boardId, cardId: card.id, dto: { text: text.trim() } });
            setText("");
          }}
        >
          Adicionar
        </Button>
      </div>
    </section>
  );
}

function StoryModal({
  boardId,
  storyId,
  boardColumns,
  boardLabels,
  boardAssignees,
  onOpenTask,
  panelIndex,
  onClose,
}: {
  boardId: string;
  storyId: string;
  boardColumns: ApiBoardColumn[];
  boardLabels: Array<{ id: string; name: string; color: string }>;
  boardAssignees: Array<{ id: string; name: string; model: string | null }>;
  onOpenTask: (taskId: string) => void;
  panelIndex: number;
  onClose: () => void;
}) {
  const { data: story } = useCard(storyId);
  const updateCard = useUpdateCard();
  const moveCard = useMoveCard();
  const createCard = useCreateCard(boardId);
  const { attachLabel, detachLabel } = useCardLabels();
  const { attachAssignee, detachAssignee } = useCardAssignees();
  const { addFlow, removeFlow } = useFlows();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [points, setPoints] = useState("");
  const [labelToAdd, setLabelToAdd] = useState("");
  const [assigneeToAdd, setAssigneeToAdd] = useState("");
  const [flowName, setFlowName] = useState("");
  const [flowFiles, setFlowFiles] = useState("");
  const [flowNote, setFlowNote] = useState("");

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

  const existingLabelIds = new Set(story.labels.map((entry) => entry.label.id));
  const existingAssigneeIds = new Set(story.assignees.map((entry) => entry.assignee.id));

  const taskSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  return (
    <SidePanel open onOpenChange={(open) => !open && onClose()} index={panelIndex} title={"Story " + story.key}>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Título</Label>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          <Label>Descrição</Label>
          <Textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          <Label>Points</Label>
          <Select value={points || "none"} onValueChange={(value) => setPoints(value === "none" ? "" : value)}>
            <SelectTrigger>
              <SelectValue placeholder="Sem pontos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sem pontos</SelectItem>
              {STORY_POINTS.map((point) => (
                <SelectItem key={point} value={String(point)}>
                  {point}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() =>
              updateCard.mutate({
                boardId,
                cardId: story.id,
                dto: {
                  title,
                  description,
                  points: points ? (Number(points) as StoryPoints) : null,
                },
              })
            }
          >
            Salvar
          </Button>
        </div>

        <Separator />
        <DodSection card={story} boardId={boardId} />

        <Separator />
        <section className="space-y-2">
          <p className="text-sm font-semibold">Labels</p>
          <div className="flex flex-wrap gap-2">
            {story.labels.map((entry) => (
              <Badge key={entry.label.id} className="text-white" style={{ backgroundColor: entry.label.color }}>
                {entry.label.name}
                <button
                  className="ml-2"
                  onClick={() => detachLabel.mutate({ boardId, cardId: story.id, labelId: entry.label.id })}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Select value={labelToAdd} onValueChange={setLabelToAdd}>
              <SelectTrigger>
                <SelectValue placeholder="Selecionar label" />
              </SelectTrigger>
              <SelectContent>
                {boardLabels
                  .filter((label) => !existingLabelIds.has(label.id))
                  .map((label) => (
                    <SelectItem key={label.id} value={label.id}>
                      {label.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                if (!labelToAdd) return;
                attachLabel.mutate({ boardId, cardId: story.id, labelId: labelToAdd });
                setLabelToAdd("");
              }}
            >
              Adicionar
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-semibold">Assignees</p>
          <div className="flex flex-wrap gap-2">
            {story.assignees.map((entry) => (
              <Badge key={entry.assignee.id} variant="outline">
                {entry.assignee.name + " (" + (entry.assignee.model ?? "-") + ")"}
                <button
                  className="ml-2"
                  onClick={() =>
                    detachAssignee.mutate({ boardId, cardId: story.id, assigneeId: entry.assignee.id })
                  }
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Select value={assigneeToAdd} onValueChange={setAssigneeToAdd}>
              <SelectTrigger>
                <SelectValue placeholder="Selecionar assignee" />
              </SelectTrigger>
              <SelectContent>
                {boardAssignees
                  .filter((assignee) => !existingAssigneeIds.has(assignee.id))
                  .map((assignee) => (
                    <SelectItem key={assignee.id} value={assignee.id}>
                      {assignee.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                if (!assigneeToAdd) return;
                attachAssignee.mutate({ boardId, cardId: story.id, assigneeId: assigneeToAdd });
                setAssigneeToAdd("");
              }}
            >
              Adicionar
            </Button>
          </div>
        </section>

        <Separator />
        <section className="space-y-2">
          <p className="text-sm font-semibold">Affected flows</p>
          {story.affectedFlows.map((flow) => (
            <div key={flow.id} className="rounded border p-2 text-sm">
              <div className="flex items-center justify-between">
                <strong>{flow.name}</strong>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => removeFlow.mutate({ boardId, cardId: story.id, flowId: flow.id })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-muted-foreground">{flow.note}</p>
            </div>
          ))}
          <Input value={flowName} onChange={(event) => setFlowName(event.target.value)} placeholder="Nome" />
          <Input
            value={flowFiles}
            onChange={(event) => setFlowFiles(event.target.value)}
            placeholder="Arquivos separados por vírgula"
          />
          <Textarea value={flowNote} onChange={(event) => setFlowNote(event.target.value)} placeholder="Nota" />
          <Button
            onClick={() => {
              if (!flowName.trim()) return;
              addFlow.mutate({
                boardId,
                cardId: story.id,
                dto: {
                  name: flowName.trim(),
                  files: flowFiles
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                  note: flowNote.trim() || undefined,
                },
              });
              setFlowName("");
              setFlowFiles("");
              setFlowNote("");
            }}
          >
            Adicionar flow
          </Button>
        </section>

        <Separator />
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Tasks</p>
            <Button
              size="sm"
              onClick={() => {
                const todoColumn = taskColumns.find((column) => column.title === "To Do");
                if (!todoColumn) return;
                createCard.mutate({
                  dto: {
                    boardId,
                    type: "task",
                    title: "Nova task",
                    parentId: story.id,
                    columnId: todoColumn.id,
                  },
                });
              }}
            >
              Nova task
            </Button>
          </div>

          <DndContext
            sensors={taskSensors}
            collisionDetection={closestCenter}
            onDragEnd={(event: DragEndEvent) => {
              const activeId = String(event.active.id);
              const overId = event.over ? String(event.over.id) : "";
              if (!overId) return;
              const destination = getColumnFromOverId(overId, tasks, activeId, (card) => card.taskColumnId);
              if (!destination) return;
              moveCard.mutate({ boardId, cardId: activeId, dto: { columnId: destination } });
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              {taskColumns.map((column) => {
                const items = tasks.filter((task) => task.taskColumnId === column.id);
                return (
                  <div key={column.id} className="rounded border bg-muted/20">
                    <p className="border-b px-2 py-1 text-xs font-semibold">{column.title}</p>
                    <ScrollArea className="h-40 p-2">
                      <SortableContext items={items.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                        <div id={"column:" + column.id} className="space-y-2">
                          {items.map((task) => (
                            <SortableCardItem key={task.id} card={task} onClick={(item) => onOpenTask(item.id)} />
                          ))}
                        </div>
                      </SortableContext>
                    </ScrollArea>
                  </div>
                );
              })}
            </div>
          </DndContext>
        </section>

        <Separator />
        <section className="space-y-2">
          <p className="text-sm font-semibold">Comentários</p>
          <div className="space-y-1 text-xs text-muted-foreground">
            {story.comments.map((comment) => (
              <p key={comment.id}>{comment.text}</p>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-semibold">Atividades</p>
          <div className="space-y-1 text-xs text-muted-foreground">
            {story.activities.map((activity) => (
              <p key={activity.id}>{activity.text}</p>
            ))}
          </div>
        </section>
      </div>
    </SidePanel>
  );
}

function TaskModal({
  boardId,
  taskId,
  boardLabels,
  boardAssignees,
  panelIndex,
  onClose,
}: {
  boardId: string;
  taskId: string;
  boardLabels: Array<{ id: string; name: string; color: string }>;
  boardAssignees: Array<{ id: string; name: string; model: string | null }>;
  panelIndex: number;
  onClose: () => void;
}) {
  const { data: task } = useCard(taskId);
  const updateCard = useUpdateCard();
  const { attachLabel, detachLabel } = useCardLabels();
  const { attachAssignee, detachAssignee } = useCardAssignees();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labelToAdd, setLabelToAdd] = useState("");
  const [assigneeToAdd, setAssigneeToAdd] = useState("");

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
  }, [task]);

  if (!task) return null;

  const existingLabelIds = new Set(task.labels.map((entry) => entry.label.id));
  const existingAssigneeIds = new Set(task.assignees.map((entry) => entry.assignee.id));

  return (
    <SidePanel open onOpenChange={(open) => !open && onClose()} index={panelIndex} title={"Task " + task.key}>
      <div className="space-y-4">
        <Label>Título</Label>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        <Label>Descrição</Label>
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
        <Button onClick={() => updateCard.mutate({ cardId: task.id, boardId, dto: { title, description } })}>Salvar</Button>

        <Separator />
        <DodSection card={task} boardId={boardId} />

        <Separator />
        <section className="space-y-2">
          <p className="text-sm font-semibold">Labels</p>
          <div className="flex flex-wrap gap-2">
            {task.labels.map((entry) => (
              <Badge key={entry.label.id} className="text-white" style={{ backgroundColor: entry.label.color }}>
                {entry.label.name}
                <button
                  className="ml-2"
                  onClick={() => detachLabel.mutate({ boardId, cardId: task.id, labelId: entry.label.id })}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Select value={labelToAdd} onValueChange={setLabelToAdd}>
              <SelectTrigger>
                <SelectValue placeholder="Selecionar label" />
              </SelectTrigger>
              <SelectContent>
                {boardLabels
                  .filter((label) => !existingLabelIds.has(label.id))
                  .map((label) => (
                    <SelectItem key={label.id} value={label.id}>
                      {label.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                if (!labelToAdd) return;
                attachLabel.mutate({ boardId, cardId: task.id, labelId: labelToAdd });
                setLabelToAdd("");
              }}
            >
              Adicionar
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-semibold">Assignees</p>
          <div className="flex flex-wrap gap-2">
            {task.assignees.map((entry) => (
              <Badge key={entry.assignee.id} variant="outline">
                {entry.assignee.name}
                <button
                  className="ml-2"
                  onClick={() =>
                    detachAssignee.mutate({ boardId, cardId: task.id, assigneeId: entry.assignee.id })
                  }
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Select value={assigneeToAdd} onValueChange={setAssigneeToAdd}>
              <SelectTrigger>
                <SelectValue placeholder="Selecionar assignee" />
              </SelectTrigger>
              <SelectContent>
                {boardAssignees
                  .filter((assignee) => !existingAssigneeIds.has(assignee.id))
                  .map((assignee) => (
                    <SelectItem key={assignee.id} value={assignee.id}>
                      {assignee.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                if (!assigneeToAdd) return;
                attachAssignee.mutate({ boardId, cardId: task.id, assigneeId: assigneeToAdd });
                setAssigneeToAdd("");
              }}
            >
              Adicionar
            </Button>
          </div>
        </section>

        <Separator />
        <section className="space-y-2">
          <p className="text-sm font-semibold">Iterations</p>
          <div className="space-y-2 text-xs">
            {task.iterations.map((iteration) => (
              <div key={iteration.id} className="rounded border p-2">
                <p className="font-semibold">#{iteration.index} · {iteration.phase}</p>
                <p className="text-muted-foreground">{iteration.summary}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </SidePanel>
  );
}

function EpicModal({
  boardId,
  epicId,
  boardColumns,
  stories,
  onOpenStory,
  onClose,
}: {
  boardId: string;
  epicId: string;
  boardColumns: ApiBoardColumn[];
  stories: ApiCardSummary[];
  onOpenStory: (storyId: string) => void;
  onClose: () => void;
}) {
  const { data: epic } = useCard(epicId);
  const moveCard = useMoveCard();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const flowColumns = boardColumns.filter((column) => !column.isTaskColumn).sort((a, b) => a.position - b.position);
  const epicStories = stories.filter((story) => story.parentId === epicId).sort((a, b) => a.position - b.position);

  return (
    <SidePanel open onOpenChange={(open) => !open && onClose()} index={0} title={"Epic " + (epic?.key ?? "")}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{epic?.description}</p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event: DragEndEvent) => {
            const activeId = String(event.active.id);
            const overId = event.over ? String(event.over.id) : "";
            if (!overId) return;
            const destination = getColumnFromOverId(overId, epicStories, activeId, (card) => card.boardColumnId);
            if (!destination) return;
            moveCard.mutate({ boardId, cardId: activeId, dto: { columnId: destination } });
          }}
        >
          <div className="space-y-2">
            {flowColumns.map((column) => {
              const columnStories = epicStories.filter((story) => story.boardColumnId === column.id);
              return (
                <div key={column.id} className="rounded border bg-muted/20">
                  <p className="border-b px-2 py-1 text-xs font-semibold">{column.title}</p>
                  <ScrollArea className="h-36 p-2">
                    <SortableContext items={columnStories.map((story) => story.id)} strategy={verticalListSortingStrategy}>
                      <div id={"column:" + column.id} className="space-y-2">
                        {columnStories.map((story) => (
                          <SortableCardItem
                            key={story.id}
                            card={story}
                            onClick={(item) => onOpenStory(item.id)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </ScrollArea>
                </div>
              );
            })}
          </div>
        </DndContext>
      </div>
    </SidePanel>
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

  if (loadingBoards) return <section className="rounded-lg border bg-card p-6">Carregando board...</section>;
  if (boardError || !boardId) {
    return <section className="rounded-lg border bg-card p-6">Não foi possível carregar boards.</section>;
  }

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-[260px_1fr] gap-4">
        <aside className="rounded-lg border bg-card p-3">
          <h2 className="mb-3 text-sm font-semibold">Epics</h2>
          <ScrollArea className="h-[520px] pr-2">
            <div className="space-y-2">
              {epics.map((epic) => {
                const done = epic.epicStatus?.done ?? 0;
                const total = epic.epicStatus?.total ?? 0;
                const progress = total > 0 ? (done / total) * 100 : 0;
                return (
                  <button
                    key={epic.id}
                    className="w-full rounded-md border p-2 text-left hover:border-primary/50"
                    onClick={() => openEpic(epic.id)}
                  >
                    <p className="text-xs text-muted-foreground">{epic.key}</p>
                    <p className="text-sm font-medium">{epic.title}</p>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <Badge variant={statusVariant(epic.epicStatus?.status)}>{statusLabel(epic.epicStatus?.status)}</Badge>
                      <span>{done + "/" + total}</span>
                    </div>
                    <div className="mt-2 h-1.5 rounded bg-muted">
                      <div className="h-1.5 rounded bg-primary" style={{ width: progress + "%" }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
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
          <div className="flex gap-3 overflow-x-auto pb-2">
            {boardColumns.map((column) => (
              <StoryColumn
                key={column.id}
                column={column}
                stories={stories.filter((story) => story.boardColumnId === column.id)}
                onOpenStory={(story) => openStory(story.id, story.parentId)}
                onCreateStory={(columnId) =>
                  createCard.mutate({
                    dto: {
                      boardId,
                      type: "story",
                      title: "Nova story",
                      columnId,
                      points: 1,
                    },
                  })
                }
              />
            ))}
          </div>
        </DndContext>
      </div>

      {(modals.epicId || modals.storyId || modals.taskId) && (
        <button className="fixed inset-0 z-40 cursor-default" onClick={closeAllModals} aria-label="fechar" />
      )}

      {modals.epicId ? (
        <EpicModal
          boardId={boardId}
          epicId={modals.epicId}
          boardColumns={board?.columns ?? []}
          stories={stories}
          onOpenStory={(storyId) => openStory(storyId, modals.epicId)}
          onClose={() => closeTopModal()}
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
          panelIndex={modals.epicId ? 1 : 0}
          onClose={() => closeTopModal()}
        />
      ) : null}

      {modals.taskId ? (
        <TaskModal
          boardId={boardId}
          taskId={modals.taskId}
          boardLabels={board?.labels ?? []}
          boardAssignees={board?.assignees ?? []}
          panelIndex={modals.epicId ? 2 : 1}
          onClose={() => closeTopModal()}
        />
      ) : null}
    </section>
  );
}
