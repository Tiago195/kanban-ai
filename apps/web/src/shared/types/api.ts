import type {
  Activity,
  AffectedFlow,
  Assignee,
  CardType,
  ChecklistItem,
  Comment,
  ExecState,
  Iteration,
  IterationPhase,
  StoryPoints,
  ValidationStrategy,
} from "@kanban-ai/shared";

export interface ApiBoardColumn {
  id: string;
  title: string;
  wipLimit: number | null;
  position: number;
  isTaskColumn: boolean;
}

/** Label como retornada pela API (loopProfileId é o profileId string, não o uuid). */
export interface ApiLabel {
  id: string;
  boardId?: string;
  name: string;
  color: string;
  loopProfileId: string | null;
}

/** Loop profile como retornado pela API: uuid em `id`, chave lógica em `profileId`. */
export interface ApiLoopProfile {
  id: string;
  boardId: string;
  profileId: string;
  name: string;
  builtin: boolean;
  description: string;
  phases: IterationPhase[];
  validation: ValidationStrategy;
  firstStep: string;
}

export interface ApiBoard {
  id: string;
  title: string;
  columns: ApiBoardColumn[];
  labels: ApiLabel[];
  assignees: Assignee[];
  loopProfiles: ApiLoopProfile[];
  defaultModel?: string | null;
  /** EP-PROJECT / US-PROJ6 — Project (repo git gerenciado) associado ao quadro. */
  projectId?: string | null;
}

/** Um modelo de AI disponível para o login atual do Copilot CLI. */
export interface ApiAgentModel {
  id: string;
  label: string;
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
  needsHuman: boolean;
  needsHumanReason?: string | null;
  parentId: string | null;
  boardColumnId: string | null;
  taskColumnId: string | null;
  position: number;
  createdAt: number;
  aiSummary?: string | null;
  aiProject?: string | null;
  aiNotes?: string | null;
  model?: string | null;
  resolvedModel?: string | null;
  loopType?: string | null;
  execState?: ExecState | null;
  derivedFromId?: string | null;
  epicStatus?: EpicStatusSummary;
  labelIds?: string[];
  assigneeIds?: string[];
}

/** Uma dependência de task exposta pelo GET /cards/:id (task pré-requisito). */
export interface TaskDependencyView {
  dependsOn: {
    id: string;
    key: string;
    title: string;
    execState: ExecState | null;
  };
}

export interface ApiCardDetails extends ApiCardSummary {
  dodItems: ChecklistItem[];
  comments: Comment[];
  activities: Activity[];
  affectedFlows: AffectedFlow[];
  iterations: Iteration[];
  labels: Array<{ label: ApiLabel }>;
  assignees: Array<{ assignee: Assignee }>;
  children: ApiCardSummary[];
  dependsOn?: TaskDependencyView[];
}
