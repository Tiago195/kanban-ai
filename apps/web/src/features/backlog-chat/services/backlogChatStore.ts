import { create } from "zustand";
import {
  BACKLOG_MAIN_CHANNEL,
  type BacklogChatMessage,
  type BacklogProposal,
  type BacklogTaskProposal,
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
  /**
   * Epoch (ms) em que o streaming corrente começou NESTE canal, ou `null`
   * quando ocioso. Permite à UI mostrar um cronômetro de "há Xs trabalhando"
   * durante turnos longos do PO (que rodam shell real no repo-alvo e podem levar
   * minutos entre chunks). Ver finding imp-slow-turns.
   */
  streamingSince: number | null;
  /**
   * Última linha de "pensamento" (`thought`) emitida pela AI neste canal.
   * Serve de status vivo no indicador de digitação durante silêncios longos
   * (ex.: "explorando o repositório…", "rodando os testes…"), para que um turno
   * de vários minutos não pareça travado. Ver finding imp-slow-turns.
   */
  lastActivity: string | null;
}

/**
 * Estado de uma sessão: um mapa de canais + a proposta corrente (session-level,
 * compartilhada entre canais).
 */
export interface SessionChat {
  byChannel: Record<string, ChannelChat>;
  proposal: BacklogProposal | null;
  /**
   * Proposta de TASKS corrente do chat da story (ADR-0026), session-level
   * (compartilhada entre canais como a `proposal`). Alimentada pelo evento
   * `backlog.task_proposal` e pela hidratação (`openStorySession.taskProposal`).
   */
  taskProposal: BacklogTaskProposal | null;
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
  /**
   * Atualiza a proposta de TASKS corrente da sessão (session-level) e anexa uma
   * mensagem `kind=task_proposal` ao canal `main` — o front renderiza a lista
   * clicável de tasks. Ver ADR-0026.
   */
  setTaskProposal: (sessionId: string, taskProposal: BacklogTaskProposal) => void;
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
    taskProposal?: BacklogTaskProposal | null,
  ) => void;
  reset: (sessionId: string) => void;
}

/** Fábrica de um canal vazio. */
export const emptyChannel = (): ChannelChat => ({
  messages: [],
  pending: null,
  streaming: false,
  streamingSince: null,
  lastActivity: null,
});

/**
 * Canal vazio com **referência estável** para os caminhos de LEITURA
 * (selectors). Como o zustand compara o snapshot por `Object.is`, um selector
 * que retornasse `emptyChannel()` (objeto novo) a cada render dispararia um loop
 * infinito de re-render ("getSnapshot should be cached" → "Maximum update depth
 * exceeded"). Retornamos sempre esta mesma instância congelada quando o canal
 * ainda não existe. Escritas nunca mutam este objeto (fazem spread).
 */
const EMPTY_CHANNEL: ChannelChat = {
  messages: [],
  pending: null,
  streaming: false,
  streamingSince: null,
  lastActivity: null,
};

/** Fábrica de uma sessão vazia (sem canais, sem proposta). */
export const emptySession = (): SessionChat => ({
  byChannel: {},
  proposal: null,
  taskProposal: null,
});

function makeId(): string {
  return `bmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Condensa um chunk de `thought` numa linha curta de status para o indicador de
 * digitação. Pega a primeira linha não-vazia, colapsa espaços e trunca. Retorna
 * `null` se o chunk for só espaço em branco (mantém o status anterior).
 */
function summarizeActivity(delta: string): string | null {
  const firstLine = delta
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  const collapsed = firstLine.replace(/\s+/g, " ");
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

/** Lê o estado de um canal específico, ou um canal vazio se ainda não existir. */
function getChannel(session: SessionChat, channel: string): ChannelChat {
  return session.byChannel[channel] ?? EMPTY_CHANNEL;
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
  return session ? getChannel(session, channel) : EMPTY_CHANNEL;
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
        streamingSince: chan.streamingSince ?? Date.now(),
        // Um `thought` vira o status vivo; `output` (texto final) não sobrescreve
        // o status — é a resposta em si, já visível na thread.
        lastActivity:
          kind === "thought"
            ? summarizeActivity(delta) ?? chan.lastActivity
            : chan.lastActivity,
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
        streamingSince: null,
        lastActivity: null,
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
        streamingSince: null,
        lastActivity: null,
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
        streamingSince: null,
        lastActivity: null,
      });
      const next: SessionChat = { ...withProposalChannel, proposal };
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  setTaskProposal: (sessionId, taskProposal) =>
    set((state) => {
      const session = state.bySession[sessionId] ?? emptySession();
      // Idempotência: se já temos exatamente esta versão, não re-injeta a msg.
      if (session.taskProposal && session.taskProposal.version === taskProposal.version) {
        return state;
      }
      const channel = BACKLOG_MAIN_CHANNEL;
      const chan = getChannel(session, channel);
      const messages: BacklogChatMessage[] = [
        ...chan.messages,
        {
          id: `btp-${taskProposal.version}-${Date.now()}`,
          sessionId,
          channel,
          role: "ai",
          kind: "task_proposal",
          text: "",
          taskProposal,
          ts: Date.now(),
        },
      ];
      const withTaskChannel = withChannel(session, channel, {
        ...chan,
        messages,
        streaming: false,
        streamingSince: null,
        lastActivity: null,
      });
      const next: SessionChat = { ...withTaskChannel, taskProposal };
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  setStreaming: (sessionId, channel, streaming) =>
    set((state) => {
      const session = state.bySession[sessionId] ?? emptySession();
      const chan = getChannel(session, channel);
      const next = withChannel(session, channel, {
        ...chan,
        streaming,
        // Ligar o streaming inicia o cronômetro (se ainda não iniciado);
        // desligar limpa o cronômetro e o status vivo.
        streamingSince: streaming ? (chan.streamingSince ?? Date.now()) : null,
        lastActivity: streaming ? chan.lastActivity : null,
      });
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  hydrate: (sessionId, history, proposal, taskProposal) =>
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

        byChannel[channel] = {
          messages,
          pending,
          streaming: false,
          streamingSince: null,
          lastActivity: null,
        };
      }

      // Deriva a proposta de tasks corrente: a passada explicitamente (do
      // openStorySession) tem precedência; senão, a última msg task_proposal do
      // transcript; senão, mantém a que já existir no store.
      let resolvedTaskProposal: BacklogTaskProposal | null =
        taskProposal ?? existing?.taskProposal ?? null;
      if (!taskProposal) {
        for (const m of history) {
          if (m.kind === "task_proposal" && m.taskProposal) {
            resolvedTaskProposal = m.taskProposal;
          }
        }
      }

      const next: SessionChat = {
        byChannel,
        proposal,
        taskProposal: resolvedTaskProposal,
      };
      return { bySession: { ...state.bySession, [sessionId]: next } };
    }),

  reset: (sessionId) =>
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: emptySession() },
    })),
}));
