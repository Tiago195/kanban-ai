import { backlogStoryChannel, type BacklogProposalStory } from "@kanban-ai/shared";

import { ChatPanel, AgentMessageBody, type ChatPanelMessage } from "@/features/ai-engine";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { useBacklogChat } from "@/features/backlog-chat/hooks/useBacklogChat";

export interface StoryThreadSheetProps {
  sessionId: string | null;
  boardId: string | null;
  /** Story selecionada; quando null o sheet não deve ser montado. */
  story: BacklogProposalStory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Sheet lateral (modelo Slack — ADR-0023) com os detalhes ricos de uma story da
 * proposta e uma thread de chat focada só nela. Reusa o MESMO <ChatPanel> do
 * canal `main`, mas apontando para o canal `story:<id>` via `useBacklogChat`.
 *
 * Deve ser montado apenas quando há uma story selecionada (renderização
 * condicional no consumidor), garantindo que o hook sempre receba um channel
 * válido e respeitando as regras de hooks do React.
 */
export function StoryThreadSheet({
  sessionId,
  boardId,
  story,
  open,
  onOpenChange,
}: StoryThreadSheetProps) {
  const channel = backlogStoryChannel(story?.id ?? "");

  const {
    messages,
    pending,
    streaming,
    isSending,
    isAnswering,
    send,
    answer,
  } = useBacklogChat(sessionId, boardId, channel);

  const panelMessages: ChatPanelMessage[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    kind: m.kind === "proposal" ? undefined : m.kind,
  }));

  const busy = isSending || isAnswering;

  const handleSend = (text: string) => {
    if (pending) {
      answer(text);
    } else {
      send(text);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[480px] flex flex-col gap-0 p-0"
      >
        <SheetHeader className="border-b p-6">
          <div className="flex items-center gap-2">
            <span className="proposal-story-badge">📄</span>
            <SheetTitle>{story?.title ?? "História"}</SheetTitle>
          </div>
          {story?.points != null ? (
            <div>
              <span className="proposal-story-points">{story.points} pts</span>
            </div>
          ) : null}
          <SheetDescription>
            {story?.description
              ? story.description
              : "Converse sobre esta história; mudanças aqui refletem no plano em tempo real."}
          </SheetDescription>
        </SheetHeader>

        <div className="backlog-chat-body flex-1 min-h-0 p-4">
          <ChatPanel
            messages={panelMessages}
            pending={pending ? { options: pending.options } : null}
            thinking={streaming}
            busy={busy}
            inputMode="always"
            placeholder={
              pending ? "Responda ou escreva livremente…" : "Ajuste esta história com a IA…"
            }
            submitLabel="Enviar"
            busyLabel="Enviando…"
            emptyState="Converse sobre esta história; mudanças aqui refletem no plano em tempo real."
            questionHint={
              pending ? (
                <div className="agent-chat-question-hint">
                  <span className="agent-chat-question-icon">💬</span>
                  A IA aguarda sua resposta para refinar esta história
                </div>
              ) : undefined
            }
            onSend={handleSend}
            onQuickReply={(text) => (pending ? answer(text) : send(text))}
            renderMessageBody={(msg) => <AgentMessageBody text={msg.text} />}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
