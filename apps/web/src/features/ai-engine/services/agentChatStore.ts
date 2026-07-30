import { create } from "zustand";
import type {
  AgentChatMessage,
  IterationPhase,
  PendingQuestion,
} from "@kanban-ai/shared";

/**
 * Buffer reativo em memória do chat/transcript do agent, keyed por taskId.
 *
 * Os chunks de streaming (`agent.chunk`) chegam com alta frequência; usá-los
 * para invalidar queries do TanStack Query causaria refetch por token. Por isso
 * este store acumula o transcript localmente e o realtime NÃO invalida cache
 * para esses eventos (ver ADR-0017). `iteration.appended` (persistência) segue
 * pelo caminho normal de invalidação.
 */

interface TaskChat {
  messages: AgentChatMessage[];
  pending: PendingQuestion | null;
}

interface AgentChatState {
  /** Transcript por taskId. */
  byTask: Record<string, TaskChat>;
  /**
   * Anexa um chunk de streaming ao transcript da task. Chunks consecutivos do
   * mesmo `kind` são concatenados na última mensagem da AI para render fluido.
   */
  appendChunk: (input: {
    taskId: string;
    kind: "thought" | "output";
    delta: string;
    phase?: IterationPhase;
  }) => void;
  /** Registra uma mensagem completa (ex.: system, resposta do usuário). */
  addMessage: (taskId: string, message: AgentChatMessage) => void;
  /** Define a pergunta pendente (HITL) e a registra como mensagem da AI. */
  setQuestion: (question: PendingQuestion) => void;
  /** Limpa a pergunta pendente ao ser respondida; registra a resposta. */
  clearQuestion: (taskId: string, answer?: string) => void;
  /** Zera o transcript de uma task. */
  reset: (taskId: string) => void;
}

const emptyChat = (): TaskChat => ({ messages: [], pending: null });

function makeId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useAgentChatStore = create<AgentChatState>((set) => ({
  byTask: {},

  appendChunk: ({ taskId, kind, delta, phase }) =>
    set((state) => {
      const chat = state.byTask[taskId] ?? emptyChat();
      const messages = [...chat.messages];
      const last = messages[messages.length - 1];

      if (last && last.role === "ai" && last.kind === kind && !chat.pending) {
        messages[messages.length - 1] = { ...last, text: last.text + delta };
      } else {
        messages.push({
          id: makeId(),
          role: "ai",
          kind,
          phase,
          text: delta,
          ts: Date.now(),
        });
      }

      return { byTask: { ...state.byTask, [taskId]: { ...chat, messages } } };
    }),

  addMessage: (taskId, message) =>
    set((state) => {
      const chat = state.byTask[taskId] ?? emptyChat();
      return {
        byTask: {
          ...state.byTask,
          [taskId]: { ...chat, messages: [...chat.messages, message] },
        },
      };
    }),

  setQuestion: (question) =>
    set((state) => {
      const chat = state.byTask[question.taskId] ?? emptyChat();
      const messages = [
        ...chat.messages,
        {
          id: `q-${question.questionId}`,
          role: "ai" as const,
          text: question.prompt,
          ts: question.ts,
        },
      ];
      return {
        byTask: {
          ...state.byTask,
          [question.taskId]: { messages, pending: question },
        },
      };
    }),

  clearQuestion: (taskId, answer) =>
    set((state) => {
      const chat = state.byTask[taskId] ?? emptyChat();
      const messages = answer
        ? [
            ...chat.messages,
            {
              id: makeId(),
              role: "user" as const,
              text: answer,
              ts: Date.now(),
            },
          ]
        : chat.messages;
      return {
        byTask: { ...state.byTask, [taskId]: { messages, pending: null } },
      };
    }),

  reset: (taskId) =>
    set((state) => ({
      byTask: { ...state.byTask, [taskId]: emptyChat() },
    })),
}));
