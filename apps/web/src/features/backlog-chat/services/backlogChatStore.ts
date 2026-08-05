import { create } from "zustand";
import {
  BACKLOG_MAIN_CHANNEL,
  type BacklogChatMessage,
  type BacklogProposal,
} from "@kanban-ai/shared";

/**
 * Buffer reativo em memória do chat de backlog, keyed por `sessionId` e, dentro
 * de cada sessão, por **canal** (thread estilo Slack).
 *
 * Espelha o `agentChatStore` do loop engine: os chunks de streaming
 * (`backlog.chunk`) chegam com alta frequência e NÃO invalidam cache — o store
 * acumula o transcript localmente.
 *
 * Modelo de canais (ver ADR-0023): uma mesma sessão do Copilot mantém múltiplos
 * transcripts separados. `main` é a conversa geral; `story:<storyId>` é a thread
 * focada de uma story. `messages`, `pending` (HITL) e `streaming` são
 * **por canal**; a proposta corrente (`backlog.proposal`) é **por sessão** —
 * existe uma única proposta compartilhada por todos os canais.
 */

/** Pergunta de descoberta pendente (HITL) num canal de uma sessão. */
export interface BacklogPending {
  sessionId: string;
  /** Canal (thread) ao qual esta pergunta pertence. */
  channel: string;
  questionId: string;
  prompt: string;
  options?: string[];
  ts: number;
}

/**
 * Estado de um único canal (thread) dentro de uma sessão. Todo transcript
 * conversacional (mensagens, pergunta pendente, streaming) é isolado aqui.
 */
export interface ChannelChat {
  messages: BacklogChatMessage[];
  pending: BacklogPending | null;
  /** true enquanto a AI está processando (streaming ativo) NESTE canal. */
  streaming: boolean;
}

/**
 * Estado de uma sessão: um mapa de canais + a proposta corrente (session-level,
 * compartilhada entre canais).
 */
export interface SessionChat {
  byChannel: Record<string, ChannelChat>;
  proposal: BacklogProposal | null;
}

interface BacklogChatState {
  bySession: Record<string, SessionChat>;
  /** Anexa um chunk de streaming da AI ao canal informado. */
  appendChunk: (input: {
    sessionId: string;
    channel: string;
    kind?: "thought" | "output";
    delta: string;
  }) => void;
  /** Adiciona uma mensagem já pronta ao canal informado. */
  addMessage: (
    sessionId: string,
    channel: string,
    message: BacklogChatMessage,
  ) => void;
  /** Registra uma pergunta HITL (a própria pergunta carrega sessionId + channel). */
  setQuestion: (question: BacklogPending) => void;
  /** Limpa a pergunta pendente de um canal; se `answer`, registra a resposta do humano. */
  clearQuestion: (sessionId: string, channel: string, answer?: string) => void;
  /**
   * Atualiza a proposta corrente da sessão (session-level). A mensagem
   * `kind=proposal` gerada é anexada ao canal `main`.
   */
  setProposal: (sessionId: string, proposal: BacklogProposal) => void;
  /** Liga/desliga o indicador de streaming de um canal. */
  setStreaming: (sessionId: string, channel: string, streaming: boolean) => void;
  /**
   * Reidrata o transcript persistido ao (re)abrir a sessão. `history` é o
   * transcript COMPLETO (todos os canais) — as mensagens são distribuídas nos
   * baldes por `message.channel`. Só semeia um canal se ele ainda estiver vazio
   * (chunks ao vivo têm precedência). Deriva `pending` POR CANAL (pergunta da AI
   * ainda não respondida naquele canal). A proposta permanece session-level.
   */
  hydrate: (
    sessionId: string,
    history: BacklogChatMessage[],
    proposal: BacklogProposal | null,
  ) => void;
  reset: (sessionId: string) => void;
}

/** Fábrica de um canal vazio. */
export const emptyChannel = (): ChannelChat => ({
  messages: [],
  pending: null,
  streaming: false,
});

/** Fábrica de uma sessão vazia (sem canais, sem proposta). */
export const emptySession = (): SessionChat => ({
  byChannel: {},
  proposal: null,
});

function makeId(): string {
  return `bmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Lê o estado de um canal específico, ou um canal vazio se ainda não existir. */
function getChannel(session: SessionChat, channel: string): ChannelChat {
  return session.byChannel[channel] ?? emptyChannel();
}

/** Substitui um canal dentro de uma sessão, retornando uma nova SessionChat. */
function withChannel(
  session: SessionChat,
  channel: string,
  chan: ChannelChat,
): SessionChat {
  return {
    ...session,
    byChannel: { ...session.byChannel, [channel]: chan },
  };
}

/**
 * Selector conveniente: lê o `ChannelChat` de um canal de uma sessão a partir do
 * mapa `bySession`, retornando um canal vazio quando ausente. Consumidores podem
 * usar `useBacklogChatStore((s) => selectChannel(s.bySession, id, channel))`.
 */
export function selectChannel(
  bySession: Record<string, SessionChat>,
  sessionId: string,
  channel: string,
): ChannelChat {
  const session = bySession[sessionId];
  return session ? getChannel(session, channel) : emptyChannel();
}

export const useBacklogChatStore = create<BacklogChatState>((set) => ({
  bySession: {},

  appendChunk: ({ sessionId, channel, kind, delta }) =>
    set((state) => {
      const session = state.bySession[sessionId] ?? emptySession();
      const chan = getChannel(session, channel);
      const messages = [...chan.messages];
      const last = messages[messages.length - 1];
      const isMergeable =
        last &&
        last.role === "ai" &&
        last.kind === kind &&
        !chan.pending;

      if (isMergeable) {
        messages[messages.length - 1] = { ...last, text: last.text + delta };
      } else {
        messages.push({
          id: makeId(),
          sessionId,
          channel,
          role: "ai",
          kind,
          text: delta,
          ts: Date.now(),
        });
      }

      const next = withChannel(session, channel, {
        ...chan,
        messages,
        streaming: true,
      });
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  addMessage: (sessionId, channel, message) =>
    set((state) => {
      const session = state.bySession[sessionId] ?? emptySession();
      const chan = getChannel(session, channel);
      const next = withChannel(session, channel, {
        ...chan,
        messages: [...chan.messages, message],
      });
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  setQuestion: (question) =>
    set((state) => {
      const { sessionId, channel } = question;
      const session = state.bySession[sessionId] ?? emptySession();
      const chan = getChannel(session, channel);
      const messages: BacklogChatMessage[] = [
        ...chan.messages,
        {
          id: `bq-${question.questionId}`,
          sessionId,
          channel,
          role: "ai",
          text: question.prompt,
          questionId: question.questionId,
          options: question.options,
          ts: question.ts,
        },
      ];
      const next = withChannel(session, channel, {
        ...chan,
        messages,
        pending: question,
        streaming: false,
      });
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  clearQuestion: (sessionId, channel, answer) =>
    set((state) => {
      const session = state.bySession[sessionId] ?? emptySession();
      const chan = getChannel(session, channel);
      const messages: BacklogChatMessage[] = answer
        ? [
            ...chan.messages,
            {
              id: makeId(),
              sessionId,
              channel,
              role: "user",
              text: answer,
              ts: Date.now(),
            },
          ]
        : chan.messages;
      const next = withChannel(session, channel, {
        ...chan,
        messages,
        pending: null,
        streaming: false,
      });
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  setProposal: (sessionId, proposal) =>
    set((state) => {
      const session = state.bySession[sessionId] ?? emptySession();
      const channel = BACKLOG_MAIN_CHANNEL;
      const chan = getChannel(session, channel);
      const messages: BacklogChatMessage[] = [
        ...chan.messages,
        {
          id: `bp-${proposal.version}-${Date.now()}`,
          sessionId,
          channel,
          role: "ai",
          kind: "proposal",
          text: "",
          proposal,
          ts: Date.now(),
        },
      ];
      const withProposalChannel = withChannel(session, channel, {
        ...chan,
        messages,
        streaming: false,
      });
      const next: SessionChat = { ...withProposalChannel, proposal };
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  setStreaming: (sessionId, channel, streaming) =>
    set((state) => {
      const session = state.bySession[sessionId] ?? emptySession();
      const chan = getChannel(session, channel);
      const next = withChannel(session, channel, { ...chan, streaming });
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  hydrate: (sessionId, history, proposal) =>
    set((state) => {
      const existing = state.bySession[sessionId];

      // Distribui o transcript completo nos baldes por canal.
      const grouped: Record<string, BacklogChatMessage[]> = {};
      for (const m of history) {
        const channel = m.channel || BACKLOG_MAIN_CHANNEL;
        (grouped[channel] ??= []).push(m);
      }

      // Chunks ao vivo têm precedência: parte-se dos canais já existentes e só
      // se semeia um canal que ainda esteja vazio.
      const byChannel: Record<string, ChannelChat> = {
        ...(existing?.byChannel ?? {}),
      };
      for (const [channel, messages] of Object.entries(grouped)) {
        const current = byChannel[channel];
        if (current && current.messages.length > 0) continue;

        // Deriva `pending` do canal: pergunta da AI ainda não respondida.
        const answeredQuestionIds = new Set(
          messages
            .filter((m) => m.role === "user" && m.questionId)
            .map((m) => m.questionId),
        );
        let pending: BacklogPending | null = null;
        for (const m of messages) {
          if (
            m.role === "ai" &&
            m.questionId &&
            !answeredQuestionIds.has(m.questionId)
          ) {
            pending = {
              sessionId,
              channel,
              questionId: m.questionId,
              prompt: m.text,
              options: m.options,
              ts: m.ts,
            };
          }
        }

        byChannel[channel] = { messages, pending, streaming: false };
      }

      const next: SessionChat = { byChannel, proposal };
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  reset: (sessionId) =>
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: emptySession() },
    })),
}));
