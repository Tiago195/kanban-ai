import type {
  Activity,
  AffectedFlow,
  Assignee,
  CardType,
  ChecklistItem,
  Comment,
  ExecState,
  Iteration,
  Label,
  LoopProfile,
  StoryPoints,
} from "@kanban-ai/shared";

export interface ApiBoardColumn {
  id: string;
  title: string;
  wipLimit: number | null;
  position: number;
  isTaskColumn: boolean;
}

export interface ApiBoard {
  id: string;
  title: string;
  columns: ApiBoardColumn[];
  labels: Label[];
  assignees: Assignee[];
  loopProfiles: LoopProfile[];
}

export interface EpicStatusSummary {
  status: "todo" | "inprogress" | "done";
  done: number;
  total: number;
}

export interface ApiCardSummary {
  id: string;
  key: string;
  type: CardType;
  title: string;
  description: string;
  points: StoryPoints | null;
  blocked: boolean;
  everInProgress: boolean;
  parentId: string | null;
  boardColumnId: string | null;
  taskColumnId: string | null;
  position: number;
  createdAt: number;
  aiSummary?: string | null;
  aiProject?: string | null;
  aiNotes?: string | null;
  loopType?: string | null;
  execState?: ExecState | null;
  epicStatus?: EpicStatusSummary;
}

export interface ApiCardDetails extends ApiCardSummary {
  dodItems: ChecklistItem[];
  comments: Comment[];
  activities: Activity[];
  affectedFlows: AffectedFlow[];
  iterations: Iteration[];
  labels: Array<{ label: Label }>;
  assignees: Array<{ assignee: Assignee }>;
  children: ApiCardSummary[];
}
