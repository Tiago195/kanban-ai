import type {
  AttachAssigneeDto,
  AttachLabelDto,
  CreateCardDto,
  CreateDodItemDto,
  CreateFlowDto,
  MoveCardDto,
  UpdateCardDto,
  UpdateDodItemDto,
} from "@kanban-ai/shared";

import type { ApiBoard, ApiCardDetails, ApiCardSummary } from "@/shared/types";

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
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    throw new Error(`API ${path} respondeu ${res.status}`);
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

  getCards(boardId: string): Promise<ApiCardSummary[]> {
    return request<ApiCardSummary[]>(`/cards?boardId=${encodeURIComponent(boardId)}`);
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
};

export function getHealth(): Promise<HealthResponse> {
  return apiClient.getHealth();
}
