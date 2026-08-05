import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BacklogChatMessage, BacklogProposalStory } from "@kanban-ai/shared";

import { ChatPanel, AgentMessageBody, type ChatPanelMessage } from "@/features/ai-engine";
import { apiClient } from "@/shared/services/apiClient";
import { showToast } from "@/shared/services/toastStore";
import { useBacklogChat } from "@/features/backlog-chat/hooks/useBacklogChat";
import { ProposalCard } from "@/features/backlog-chat/components/ProposalCard";
import { StoryThreadSheet } from "@/features/backlog-chat/components/StoryThreadSheet";
import { SessionSidebar } from "@/features/backlog-chat/components/SessionSidebar";

export interface BacklogChatViewProps {
  boardId: string | null;
  /** sessionId vindo da URL (`/backlog-chat/:sessionId`), ou null em `/backlog-chat`. */
  routeSessionId: string | null;
  /** Chamado quando uma sessão nova é criada, para o router refletir o id na URL. */
  onSessionCreated: (sessionId: string) => void;
  /** Abre uma sessão existente a partir do seletor lateral. */
  onSelectSession: (sessionId: string) => void;
  /** Inicia uma conversa nova a partir do seletor lateral. */
  onNewSession: () => void;
  onClose: () => void;
}

/**
 * Tela cheia do "Chat de criação de Épicos/Histórias". Se a URL já traz um
 * `sessionId`, reusa e reidrata a conversa (F5-safe). Caso contrário, cria uma
 * sessão nova e avisa o router para colocar o id na URL — assim um reload reabre
 * exatamente a mesma conversa em vez de começar do zero.
 *
 * Renderizada por uma rota dedicada (ver App.tsx), com URL própria e
 * deep-link. Ver ADR-0021.
 */
export function BacklogChatView({
  boardId,
  routeSessionId,
  onSessionCreated,
  onSelectSession,
  onNewSession,
  onClose,
}: BacklogChatViewProps) {
  const sessionId = routeSessionId;
  const queryClient = useQueryClient();
  const [openStorySnapshot, setOpenStorySnapshot] =
    useState<BacklogProposalStory | null>(null);

  const createSession = useMutation({
    mutationFn: (bid: string) => apiClient.createBacklogSession(bid),
    onSuccess: (res) => onSessionCreated(res.id),
    onError: () => showToast("Falha ao iniciar o chat de backlog"),
  });

  const createMutate = createSession.mutate;
  const creating = createSession.isPending;
  useEffect(() => {
    // Só cria sessão quando a URL não tem id (rota /backlog-chat sem :sessionId).
    if (boardId && !sessionId && !creating) {
      createMutate(boardId);
    }
  }, [boardId, sessionId, creating, createMutate]);

  const {
    messages,
    pending,
    proposal,
    streaming,
    isSending,
    isAnswering,
    isApplying,
    send,
    answer,
    apply,
  } = useBacklogChat(sessionId, boardId);

  const currentVersion = proposal?.version ?? null;

  // A story exibida no Sheet é resolvida da proposta CORRENTE — assim patches
  // (ex.: novas tasks) refletem em tempo real, sem depender de F5. Casa primeiro
  // pelo id estável; se a IA reemitir a proposta com id novo, cai no título; por
  // último usa o snapshot capturado no clique. Ver ADR-0024.
  const openStory: BacklogProposalStory | null = openStorySnapshot
    ? (proposal?.stories.find((s) => s.id === openStorySnapshot.id) ??
      proposal?.stories.find((s) => s.title === openStorySnapshot.title) ??
      openStorySnapshot)
    : null;

  const panelMessages: ChatPanelMessage[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    kind: m.kind === "proposal" ? undefined : m.kind,
  }));

  const proposalById = new Map<string, BacklogChatMessage>();
  for (const m of messages) {
    if (m.kind === "proposal" && m.proposal) proposalById.set(m.id, m);
  }

  const busy = isSending || isAnswering;

  const refreshSessions = () => {
    void queryClient.invalidateQueries({ queryKey: ["backlog-sessions", boardId] });
  };

  const handleSend = (text: string) => {
    if (pending) {
      answer(text);
    } else {
      send(text);
    }
    // A 1ª mensagem faz a sessão aparecer/renomear na lista lateral.
    setTimeout(refreshSessions, 400);
  };

  return (
    <div className="backlog-chat-overlay">
      <SessionSidebar
        boardId={boardId}
        activeSessionId={sessionId}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
      />
      <div className="backlog-chat-shell">
        <header className="backlog-chat-header">
          <div className="backlog-chat-heading">
            <h2>✨ Criar backlog com IA</h2>
            <span className="backlog-chat-sub">
              Descreva sua ideia — a IA faz perguntas, propõe um épico com histórias e você aprova.
            </span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>

        <div className="backlog-chat-body">
          <ChatPanel
            messages={panelMessages}
            pending={pending ? { options: pending.options } : null}
            thinking={streaming}
            busy={busy}
            inputMode="always"
            placeholder={
              pending ? "Responda ou escreva livremente…" : "Descreva a ideia do backlog…"
            }
            submitLabel="Enviar"
            busyLabel="Enviando…"
            emptyState={
              createSession.isPending || !sessionId
                ? "Iniciando conversa…"
                : "Conte à IA o que você quer construir. Ela vai te ajudar a estruturar um épico com histórias."
            }
            questionHint={
              pending ? (
                <div className="agent-chat-question-hint">
                  <span className="agent-chat-question-icon">💬</span>
                  A IA aguarda sua resposta para refinar a proposta
                </div>
              ) : undefined
            }
            onSend={handleSend}
            onQuickReply={(text) => (pending ? answer(text) : send(text))}
            renderMessageBody={(msg) => {
              const proposalMsg = proposalById.get(msg.id);
              if (proposalMsg?.proposal) {
                return (
                  <ProposalCard
                    proposal={proposalMsg.proposal}
                    isCurrent={proposalMsg.proposal.version === currentVersion}
                    applying={isApplying}
                    onApply={apply}
                    onOpenStory={setOpenStorySnapshot}
                  />
                );
              }
              return <AgentMessageBody text={msg.text} />;
            }}
          />
        </div>
      </div>
      {openStory ? (
        <StoryThreadSheet
          sessionId={sessionId}
          boardId={boardId}
          story={openStory}
          open
          onOpenChange={(o) => {
            if (!o) setOpenStorySnapshot(null);
          }}
        />
      ) : null}
    </div>
  );
}
