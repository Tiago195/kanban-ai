import type {
  AgentChatMessage,
  Assignee,
  AttachAssigneeDto,
  AttachLabelDto,
  BacklogAppliedCard,
  BacklogChatMessage,
  BacklogChatSessionSummary,
  BacklogProposal,
  StoryChatSession,
  CreateCardDto,
  CreateDodItemDto,
  CreateFlowDto,
  IterationPhase,
  LoopMetrics,
  MoveCardDto,
  UpdateCardDto,
  UpdateDodItemDto,
  ValidationStrategy,
} from "@kanban-ai/shared";
import { BACKLOG_MAIN_CHANNEL } from "@kanban-ai/shared";

import type { ApiAgentModel, ApiBoard, ApiCardDetails, ApiCardSummary, ApiLabel, ApiLoopProfile } from "@/shared/types";

const DEFAULT_BASE_URL = "http://localhost:3333";

const baseUrl: string = import.meta.env.VITE_API_BASE_URL ?? DEFAULT_BASE_URL;

export interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

/** Estado do loop de uma story, retornado pelo endpoint GET /cards/:id/loop/state. */
export interface LoopStateResponse {
  isAutoRunning: boolean;
  session: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Só declara Content-Type JSON quando há corpo. Fastify rejeita (400 "Body cannot be
  // empty") requisições com content-type application/json e corpo vazio — o que quebrava
  // os POSTs sem body do loop (step / auto/start).
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body != null && headers["Content-Type"] == null && headers["content-type"] == null) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    // Tenta extrair a mensagem do backend (Nest devolve { message, statusCode }).
    let serverMessage: string | undefined;
    let serverCode: string | undefined;
    try {
      const body = (await res.clone().json()) as { message?: string | string[]; code?: string };
      serverMessage = Array.isArray(body?.message) ? body.message.join(", ") : body?.message;
      serverCode = typeof body?.code === "string" ? body.code : undefined;
    } catch {
      // corpo não-JSON: ignora e cai no fallback abaixo
    }
    const err = new Error(serverMessage ?? `API ${path} respondeu ${res.status}`);
    (err as Error & { status?: number; code?: string }).status = res.status;
    if (serverCode) (err as Error & { code?: string }).code = serverCode;
    throw err;
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export const apiClient = {
  baseUrl,
  request,

  getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>("/health");
  },

  getBoards(): Promise<ApiBoard[]> {
    return request<ApiBoard[]>("/boards");
  },

  getBoard(id: string): Promise<ApiBoard> {
    return request<ApiBoard>(`/boards/${id}`);
  },

  /** Lista os modelos de AI disponíveis e o default do quadro/CLI. */
  getModels(): Promise<{ models: ApiAgentModel[]; default: string }> {
    return request<{ models: ApiAgentModel[]; default: string }>("/agents/models");
  },

  /** Define o modelo default do quadro (null = usar o default do CLI). */
  setBoardModel(id: string, defaultModel: string | null): Promise<ApiBoard> {
    return request<ApiBoard>(`/boards/${id}/model`, {
      method: "PATCH",
      body: JSON.stringify({ defaultModel }),
    });
  },

  getCards(boardId: string, tenantId?: string): Promise<ApiCardSummary[]> {
    const qs = new URLSearchParams({ boardId });
    // US-COLAB1: filtro opcional de tenant. Omitido = comportamento antigo
    // (todos os cards do board). Ver ADR-0030.
    if (tenantId) qs.set("tenantId", tenantId);
    return request<ApiCardSummary[]>(`/cards?${qs.toString()}`);
  },

  getCard(id: string): Promise<ApiCardDetails> {
    return request<ApiCardDetails>(`/cards/${id}`);
  },

  createCard(dto: CreateCardDto): Promise<ApiCardSummary> {
    return request<ApiCardSummary>("/cards", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  moveCard(id: string, dto: MoveCardDto): Promise<ApiCardSummary> {
    return request<ApiCardSummary>(`/cards/${id}/move`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },

  updateCard(id: string, dto: UpdateCardDto): Promise<ApiCardSummary> {
    return request<ApiCardSummary>(`/cards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },

  deleteCard(id: string): Promise<{ deletedIds: string[] }> {
    return request<{ deletedIds: string[] }>(`/cards/${id}`, {
      method: "DELETE",
    });
  },

  addDod(cardId: string, dto: CreateDodItemDto): Promise<ApiCardDetails> {
    return request<ApiCardDetails>(`/cards/${cardId}/dod`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  updateDod(itemId: string, dto: UpdateDodItemDto): Promise<{ id: string }> {
    return request<{ id: string }>(`/dod/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },

  removeDod(itemId: string): Promise<void> {
    return request<void>(`/dod/${itemId}`, {
      method: "DELETE",
    });
  },

  attachLabel(cardId: string, dto: AttachLabelDto): Promise<{ id: string }> {
    return request<{ id: string }>(`/cards/${cardId}/labels`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  detachLabel(cardId: string, labelId: string): Promise<void> {
    return request<void>(`/cards/${cardId}/labels/${labelId}`, {
      method: "DELETE",
    });
  },

  // ── Labels globais do board ───────────────────────────────────────────────

  getLabels(boardId: string): Promise<ApiLabel[]> {
    return request<ApiLabel[]>(`/labels?boardId=${encodeURIComponent(boardId)}`);
  },

  createLabel(dto: {
    boardId: string;
    name: string;
    color?: string;
    loopProfileId?: string;
  }): Promise<ApiLabel> {
    return request<ApiLabel>(`/labels`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  deleteLabel(id: string): Promise<void> {
    return request<void>(`/labels/${id}`, {
      method: "DELETE",
    });
  },

  attachAssignee(cardId: string, dto: AttachAssigneeDto): Promise<{ id: string }> {
    return request<{ id: string }>(`/cards/${cardId}/assignees`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  detachAssignee(cardId: string, assigneeId: string): Promise<void> {
    return request<void>(`/cards/${cardId}/assignees/${assigneeId}`, {
      method: "DELETE",
    });
  },

  // ── Assignees globais (agents) ────────────────────────────────────────────

  getAssignees(boardId: string): Promise<Assignee[]> {
    return request<Assignee[]>(`/assignees?boardId=${encodeURIComponent(boardId)}`);
  },

  createAssignee(dto: {
    boardId: string;
    name: string;
    model?: string;
    instructions?: string;
  }): Promise<Assignee> {
    return request<Assignee>(`/assignees`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  removeAssignee(id: string): Promise<void> {
    return request<void>(`/assignees/${id}`, {
      method: "DELETE",
    });
  },

  // ── Loop profiles (perfis de loop das AIs) ────────────────────────────────

  getLoopProfiles(boardId: string): Promise<ApiLoopProfile[]> {
    return request<ApiLoopProfile[]>(`/loop-profiles?boardId=${encodeURIComponent(boardId)}`);
  },

  createLoopProfile(dto: {
    boardId: string;
    name: string;
    description?: string;
    phases?: IterationPhase[];
    validation?: ValidationStrategy;
    firstStep?: string;
  }): Promise<ApiLoopProfile> {
    return request<ApiLoopProfile>(`/loop-profiles`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  updateLoopProfile(
    id: string,
    dto: {
      name?: string;
      description?: string;
      phases?: IterationPhase[];
      validation?: ValidationStrategy;
      firstStep?: string;
    },
  ): Promise<ApiLoopProfile> {
    return request<ApiLoopProfile>(`/loop-profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },

  deleteLoopProfile(id: string): Promise<{ deletedId: string; profileId: string }> {
    return request<{ deletedId: string; profileId: string }>(`/loop-profiles/${id}`, {
      method: "DELETE",
    });
  },

  // ── Labels (mapa label → perfil de loop) ──────────────────────────────────

  updateLabel(
    id: string,
    dto: { loopProfileId?: string | null; name?: string; color?: string },
  ): Promise<ApiLabel> {
    return request<ApiLabel>(`/labels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },

  addFlow(cardId: string, dto: CreateFlowDto): Promise<{ id: string }> {
    return request<{ id: string }>(`/cards/${cardId}/flows`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  removeFlow(flowId: string): Promise<void> {
    return request<void>(`/flows/${flowId}`, {
      method: "DELETE",
    });
  },

  // ── Loop engine (AI) ──────────────────────────────────────────────────────

  getLoopState(storyId: string): Promise<LoopStateResponse> {
    return request<LoopStateResponse>(`/cards/${storyId}/loop/state`);
  },

  /** #8: métricas de custo & qualidade do loop de uma story (agregadas). */
  getLoopMetrics(storyId: string): Promise<LoopMetrics> {
    return request<LoopMetrics>(`/cards/${storyId}/loop/metrics`);
  },

  stepLoop(storyId: string): Promise<{ ran: boolean }> {
    return request<{ ran: boolean }>(`/cards/${storyId}/loop/step`, {
      method: "POST",
    });
  },

  startAutoLoop(storyId: string): Promise<{ running: boolean }> {
    return request<{ running: boolean }>(`/cards/${storyId}/loop/auto/start`, {
      method: "POST",
    });
  },

  stopAutoLoop(storyId: string, mode: "graceful" | "hard" = "graceful"): Promise<{ running: boolean }> {
    return request<{ running: boolean }>(`/cards/${storyId}/loop/auto/stop`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
  },

  /** HITL: responde à pergunta pendente de uma story. */
  answerQuestion(storyId: string, questionId: string, answer: string): Promise<{ accepted: boolean }> {
    return request<{ accepted: boolean }>(`/cards/${storyId}/loop/answer`, {
      method: "POST",
      body: JSON.stringify({ questionId, answer }),
    });
  },

  /** Histórico persistido do chat de uma task (transcript + HITL). */
  getAgentChatHistory(taskId: string): Promise<AgentChatMessage[]> {
    return request<AgentChatMessage[]>(`/cards/${taskId}/chat`);
  },

  // ── Chat de criação de Épicos/Histórias (backlog-chat) ────────────────────

  /** Cria uma sessão de chat de backlog para um board. */
  createBacklogSession(boardId: string): Promise<{ id: string; title: string }> {
    return request<{ id: string; title: string }>(`/backlog-chat/sessions`, {
      method: "POST",
      body: JSON.stringify({ boardId }),
    });
  },

  /** Lista as sessões (não vazias) de um board para o seletor de conversas. */
  listBacklogSessions(boardId: string): Promise<BacklogChatSessionSummary[]> {
    return request<BacklogChatSessionSummary[]>(
      `/backlog-chat/sessions?boardId=${encodeURIComponent(boardId)}`,
    );
  },

  /** Transcript persistido da sessão (reidrata o chat no F5). */
  getBacklogMessages(sessionId: string): Promise<BacklogChatMessage[]> {
    return request<BacklogChatMessage[]>(`/backlog-chat/sessions/${sessionId}/messages`);
  },

  /**
   * Envia uma mensagem do humano; dispara um turno da AI. O turno é roteado para
   * o canal (thread) informado — `main` por padrão. Ver ADR-0023.
   */
  sendBacklogMessage(
    sessionId: string,
    text: string,
    channel: string = BACKLOG_MAIN_CHANNEL,
  ): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/backlog-chat/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, channel }),
    });
  },

  /**
   * Responde a uma pergunta de descoberta pendente (HITL) no canal informado
   * (`main` por padrão). Ver ADR-0023.
   */
  answerBacklogQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
    channel: string = BACKLOG_MAIN_CHANNEL,
  ): Promise<{ accepted: boolean }> {
    return request<{ accepted: boolean }>(`/backlog-chat/sessions/${sessionId}/answer`, {
      method: "POST",
      body: JSON.stringify({ questionId, answer, channel }),
    });
  },

  /** Proposta corrente (maior versão), ou null se ainda em descoberta. */
  getBacklogProposal(sessionId: string): Promise<BacklogProposal | null> {
    return request<BacklogProposal | null>(`/backlog-chat/sessions/${sessionId}/proposal`);
  },

  /** Aprova e materializa a proposta: cria Epic + Stories no board. */
  applyBacklog(sessionId: string, version: number): Promise<{ cards: BacklogAppliedCard[] }> {
    return request<{ cards: BacklogAppliedCard[] }>(
      `/backlog-chat/sessions/${sessionId}/apply`,
      {
        method: "POST",
        body: JSON.stringify({ version }),
      },
    );
  },

  /**
   * Resolve o card `type:story` do board materializado por uma sessão já
   * aplicada, casando pelo título da story da proposta. Usado para redirecionar
   * a thread da proposta ao "chat da story" (onde tasks viram cards de verdade).
   */
  resolveAppliedStoryCard(sessionId: string, title: string): Promise<StoryChatSession> {
    return request<StoryChatSession>(`/backlog-chat/sessions/${sessionId}/story-card`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  },

  // ── Chat da story (ADR-0026) ──────────────────────────────────────────────

  /**
   * Abre (ou reusa) a sessão de chat de uma story-card. Reusa a sessão original
   * se a story veio de um backlog-chat; cria uma zerada e vincula se for manual.
   */
  openStoryChatSession(storyId: string): Promise<StoryChatSession> {
    return request<StoryChatSession>(`/backlog-chat/story/${storyId}/session`, {
      method: "POST",
    });
  },

  /**
   * Materializa tasks rascunhadas no chat da story como cards `type:task` filhos
   * em To Do (limpa o badge "Precisa de você" da story ao criar ≥1 task).
   */
  materializeStoryTasks(
    storyId: string,
    tasks: { title: string; description?: string }[],
  ): Promise<{ cards: BacklogAppliedCard[] }> {
    return request<{ cards: BacklogAppliedCard[] }>(`/backlog-chat/story/${storyId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ tasks }),
    });
  },
};

export function getHealth(): Promise<HealthResponse> {
  return apiClient.getHealth();
}
