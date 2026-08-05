import { backlogStoryChannel, type BacklogProposalStory } from "@kanban-ai/shared";

import { ChatPanel, AgentMessageBody, type ChatPanelMessage } from "@/features/ai-engine";
import {
  Sheet,
  SheetContent,
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

  const handleSuggestTasks = () => {
    if (busy || !story) return;
    // Pede à IA para decompor ESTA story em tasks. O prompt (thread focada) já
    // instrui a preferir um PATCH cirúrgico em /stories/<i>/tasks, então a
    // proposta reflete as tasks em tempo real (via backlog.proposal WS).
    send(
      `Decomponha esta história ("${story.title}") em tasks acionáveis (unidades de trabalho executável, ` +
        `sem pontos e sem DoD). Atualize a proposta com um patch cirúrgico nas tasks desta história.`,
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        overlayClassName="story-thread-overlay"
        className="story-thread-content w-[480px] sm:max-w-[480px] flex flex-col gap-0 p-0"
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
        </SheetHeader>

        <div className="story-thread-scroll flex-1 min-h-0 overflow-y-auto">
          <div className="story-thread-detail">
            <section className="story-detail-section">
              <h4 className="story-detail-label">Descrição</h4>
              {story?.description && story.description.trim().length > 0 ? (
                <p className="story-detail-text">{story.description}</p>
              ) : (
                <p className="story-detail-empty">
                  Sem descrição ainda — peça à IA para detalhar esta história abaixo.
                </p>
              )}
            </section>

            {story?.aiSummary && story.aiSummary.trim().length > 0 ? (
              <section className="story-detail-section">
                <h4 className="story-detail-label">Contexto</h4>
                <p className="story-detail-text">{story.aiSummary}</p>
              </section>
            ) : null}

            {story?.aiNotes && story.aiNotes.trim().length > 0 ? (
              <section className="story-detail-section">
                <h4 className="story-detail-label">Notas técnicas</h4>
                <p className="story-detail-text">{story.aiNotes}</p>
              </section>
            ) : null}

            <section className="story-detail-section">
              <div className="story-detail-tasks-head">
                <h4 className="story-detail-label">
                  Tasks{story?.tasks?.length ? ` (${story.tasks.length})` : ""}
                </h4>
                <button
                  type="button"
                  className="story-detail-suggest"
                  disabled={busy}
                  onClick={handleSuggestTasks}
                >
                  ✨ Sugerir tasks
                </button>
              </div>
              {story?.tasks && story.tasks.length > 0 ? (
                <ul className="story-detail-task-list">
                  {story.tasks.map((t) => (
                    <li key={t.id} className="story-detail-task">
                      <span className="story-detail-task-badge">☑︎</span>
                      {t.title}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="story-detail-empty">
                  Nenhuma task rascunhada. As tasks viram cards no board ao aplicar o backlog;
                  o DoD é montado depois, direto no board.
                </p>
              )}
            </section>
          </div>

          <div className="backlog-chat-body story-thread-chat">
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
        </div>
      </SheetContent>
    </Sheet>
  );
}
