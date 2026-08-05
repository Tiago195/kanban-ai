import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { AgentMessageBody } from "@/features/ai-engine/components/AgentMessageBody";

/** Papel de quem emitiu a mensagem no chat. */
export type ChatPanelRole = "ai" | "user" | "system";

/**
 * Mensagem genérica renderizada pelo <ChatPanel>. É intencionalmente agnóstica
 * ao domínio (não conhece task/story/HITL): quem consome mapeia seu modelo para
 * este shape. É um superset estrutural de `AgentChatMessage`, então o transcript
 * do agente pluga sem conversão.
 */
export interface ChatPanelMessage {
  id: string;
  role: ChatPanelRole;
  text: string;
  /** Rótulo curto opcional exibido junto ao papel (ex.: "pensando"). */
  kind?: string;
  /** Metadado opcional de fase, já resolvido pelo consumidor (emoji + label). */
  phase?: { emoji: string; label: string } | null;
}

/**
 * Pergunta pendente (HITL) — quando presente, o painel exibe os chips de
 * resposta rápida e a dica "aguardando resposta". Opcional: um chat puramente
 * conversacional (ex.: criação de épicos) simplesmente não passa `pending`.
 */
export interface ChatPanelPending {
  options?: string[];
}

export interface ChatPanelProps {
  messages: ChatPanelMessage[];
  /** Pergunta pendente (modo HITL). Ausente ⇒ sem chips/dica de espera. */
  pending?: ChatPanelPending | null;
  /** Mostra o indicador "digitando…". */
  thinking?: boolean;
  /** Desabilita o input/envio (ex.: enquanto uma resposta está em trânsito). */
  busy?: boolean;
  /**
   * Controla quando o input aceita digitação.
   * - "always" (padrão): chat conversacional — input sempre disponível.
   * - "when-pending": modo HITL — só habilita quando há pergunta pendente.
   */
  inputMode?: "always" | "when-pending";
  placeholder?: string;
  /** Placeholder quando o input está desabilitado (modo HITL sem pergunta). */
  disabledPlaceholder?: string;
  submitLabel?: string;
  busyLabel?: string;
  emptyState?: ReactNode;
  /** Dica exibida acima do input quando há pergunta pendente (modo HITL). */
  questionHint?: ReactNode;
  /** Envia o texto digitado. */
  onSend: (text: string) => void;
  /** Clique num chip de resposta rápida (envia direto). */
  onQuickReply?: (text: string) => void;
  /** Renderizador do corpo da mensagem. Default: <AgentMessageBody>. */
  renderMessageBody?: (message: ChatPanelMessage) => ReactNode;
}

const ROLE_LABEL: Record<ChatPanelRole, string> = {
  ai: "🤖 Agente",
  user: "🧑 Você",
  system: "⚙️ Sistema",
};

/**
 * Painel de chat puramente apresentacional e controlado por props. Não conhece
 * TanStack Query, zustand, endpoints nem o domínio de task/story — quem consome
 * fornece as mensagens e os handlers. Reaproveita <AgentMessageBody> para render
 * rico (markdown leve, tool blocks, selo de resultado).
 *
 * Suporta dois modos via `inputMode`:
 * - HITL (`when-pending`): input só habilita quando há pergunta do agente.
 * - Conversacional (`always`): humano inicia e conduz o diálogo livremente.
 */
export function ChatPanel({
  messages,
  pending = null,
  thinking = false,
  busy = false,
  inputMode = "always",
  placeholder = "Escreva uma mensagem…",
  disabledPlaceholder = "Disponível quando o agente perguntar",
  submitLabel = "Enviar",
  busyLabel = "Enviando…",
  emptyState = "Sem mensagens ainda.",
  questionHint,
  onSend,
  onQuickReply,
  renderMessageBody,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, thinking]);

  const inputEnabled = inputMode === "always" ? !busy : Boolean(pending) && !busy;

  const submit = () => {
    const text = draft.trim();
    if (!text || !inputEnabled) return;
    onSend(text);
    setDraft("");
  };

  const quickReply = (text: string) => {
    if (busy) return;
    (onQuickReply ?? onSend)(text);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const resolvedPlaceholder = inputEnabled ? placeholder : disabledPlaceholder;

  return (
    <div className="agent-chat">
      <div className="agent-chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? <div className="agent-chat-empty">{emptyState}</div> : null}
        {messages.map((msg) => (
          <div key={msg.id} className={"chat-bubble role-" + msg.role}>
            <div className="chat-bubble-meta">
              <span className="chat-role">{ROLE_LABEL[msg.role]}</span>
              {msg.kind ? <span className="chat-kind">{msg.kind}</span> : null}
              {msg.phase ? (
                <span className="chat-phase">
                  {msg.phase.emoji} {msg.phase.label}
                </span>
              ) : null}
            </div>
            {renderMessageBody ? renderMessageBody(msg) : <AgentMessageBody text={msg.text} />}
          </div>
        ))}
        {thinking ? (
          <div className="chat-typing" aria-live="polite">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span className="chat-typing-label">agente digitando…</span>
          </div>
        ) : null}
      </div>

      <div className="agent-chat-input">
        {pending ? (
          <div className="agent-chat-question">
            {questionHint ?? (
              <div className="agent-chat-question-hint">
                <span className="agent-chat-question-icon">💬</span>
                O agente aguarda sua resposta
              </div>
            )}
            {pending.options && pending.options.length > 0 ? (
              <div className="agent-chat-quick-replies" role="group" aria-label="Respostas sugeridas">
                {pending.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className="chat-chip"
                    onClick={() => quickReply(opt)}
                    disabled={busy}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="agent-chat-input-row">
          <input
            className="chat-input"
            value={draft}
            placeholder={resolvedPlaceholder}
            disabled={!inputEnabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={!inputEnabled || draft.trim().length === 0}
          >
            {busy ? busyLabel : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
