import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BACKLOG_MAIN_CHANNEL,
  backlogTaskChannel,
  type BacklogChatMessage,
  type StoryChatSession,
} from "@kanban-ai/shared";

import { ChatPanel, AgentMessageBody, type ChatPanelMessage } from "@/features/ai-engine";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { apiClient } from "@/shared/services/apiClient";
import { showToast } from "@/shared/services/toastStore";
import { queryKeys } from "@/features/board/services";
import { useBacklogChat } from "@/features/backlog-chat/hooks/useBacklogChat";
import { useStoryChat } from "@/features/backlog-chat/hooks/useStoryChat";
import { useBacklogChatStore } from "@/features/backlog-chat/services/backlogChatStore";
import { TaskProposalCard } from "@/features/backlog-chat/components/TaskProposalCard";

export interface StoryChatSheetProps {
  /** Id do card `type:story` do board cujo chat será aberto. */
  storyId: string | null;
  /** Título da story (exibido no header enquanto a sessão resolve). */
  storyTitle?: string;
  boardId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Sheet lateral do "chat da story" (ADR-0026), aberto a partir de uma
 * story-card do board. Espelha o backlog-chat: transcript no canal principal da
 * story + threads por task (`task:<id>`) + botão "✨ Sugerir tasks" que
 * materializa as tasks rascunhadas como cards `type:task` em To Do.
 *
 * Regra de origem (resolvida no backend via `openStoryChatSession`):
 * - Story vinda de backlog-chat → reusa a `BacklogChatSession` original (mesmo
 *   transcript/contexto).
 * - Story manual → sessão zerada dedicada (criada e vinculada ao card).
 */
export function StoryChatSheet({
  storyId,
  storyTitle,
  boardId,
  open,
  onOpenChange,
}: StoryChatSheetProps) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<StoryChatSession | null>(null);
  const [activeTaskThread, setActiveTaskThread] = useState<string | null>(null);

  const setTaskProposal = useBacklogChatStore((s) => s.setTaskProposal);
  const { open: openStory, isOpening } = useStoryChat(setSession);

  // Ao (re)abrir o sheet para uma story, resolve/reusa a sessão de chat.
  useEffect(() => {
    if (open && storyId && (!session || session.storyId !== storyId)) {
      openStory(storyId);
    }
    if (!open) {
      setActiveTaskThread(null);
    }
  }, [open, storyId, session, openStory]);

  // Semeia a proposta de tasks corrente (vinda do backend ao abrir a sessão)
  // no store, para reidratar a lista clicável sem esperar um novo turno da IA.
  useEffect(() => {
    if (session?.taskProposal) {
      setTaskProposal(session.sessionId, session.taskProposal);
    }
  }, [session, setTaskProposal]);

  const sessionId = session?.storyId === storyId ? session.sessionId : null;
  // Canal do chat principal da story: se a sessão foi reusada de um backlog-chat,
  // conversamos no canal geral (`main`), que já carrega o contexto do épico. As
  // threads por task usam `task:<id>` no mesmo espírito do `story:<id>`.
  const mainChannel = activeTaskThread
    ? backlogTaskChannel(activeTaskThread)
    : BACKLOG_MAIN_CHANNEL;

  const {
    messages,
    pending,
    taskProposal,
    streaming,
    streamingSince,
    lastActivity,
    isSending,
    isAnswering,
    send,
    answer,
  } = useBacklogChat(sessionId, boardId, mainChannel);

  const materialize = useMutation({
    mutationFn: (tasks: { title: string; description?: string }[]) => {
      if (!storyId) return Promise.reject(new Error("sem story"));
      return apiClient.materializeStoryTasks(storyId, tasks);
    },
    onSuccess: (res) => {
      showToast(`${res.cards.length} task(s) criada(s) em To Do ✅`);
      if (boardId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.cards(boardId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) });
      }
    },
    onError: (err: Error) => showToast(err.message || "Falha ao criar tasks"),
  });

  // Índice das mensagens de proposta de tasks por id → renderiza como cartão
  // clicável (espelha o ProposalCard das stories). O `kind:'task_proposal'` não
  // deve virar bolha de texto no ChatPanel.
  const taskProposalById = useMemo(() => {
    const map = new Map<string, BacklogChatMessage>();
    for (const m of messages) {
      if (m.kind === "task_proposal" && m.taskProposal) map.set(m.id, m);
    }
    return map;
  }, [messages]);

  const currentTaskVersion = taskProposal?.version ?? null;

  const activeTaskTitle = useMemo(() => {
    if (!activeTaskThread) return null;
    const t = taskProposal?.tasks.find((x) => x.id === activeTaskThread);
    return t?.title ?? null;
  }, [activeTaskThread, taskProposal]);

  const panelMessages: ChatPanelMessage[] = useMemo(
    () =>
      messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        kind:
          m.kind === "proposal" || m.kind === "task_proposal" ? undefined : m.kind,
      })),
    [messages],
  );

  const busy = isSending || isAnswering;

  const handleSend = (text: string) => {
    if (pending) answer(text);
    else send(text);
  };

  const handleSuggestTasks = () => {
    if (busy || !sessionId) return;
    send(
      "Ajude a decompor esta história em tasks acionáveis (unidades de trabalho " +
        "executável, sem pontos e sem DoD). Proponha a lista de tasks para eu revisar.",
    );
  };

  const handleMaterialize = () => {
    const tasks = (taskProposal?.tasks ?? [])
      .map((t) => ({
        title: t.title.trim(),
        description: t.description?.trim() || undefined,
      }))
      .filter((t) => t.title.length > 0);
    if (tasks.length === 0) return;
    materialize.mutate(tasks);
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
            <span className="proposal-story-badge">💬</span>
            <SheetTitle>{storyTitle ?? "Chat da história"}</SheetTitle>
          </div>
          <div className="story-detail-empty">
            {isOpening
              ? "Abrindo chat…"
              : session
                ? session.reused
                  ? "Reusando a conversa original do backlog-chat."
                  : "Chat dedicado desta história."
                : ""}
          </div>
          {session ? (
            <div className="flex flex-wrap gap-1 pt-2">
              <button
                type="button"
                className={`story-detail-suggest ${activeTaskThread === null ? "font-semibold" : ""}`}
                onClick={() => setActiveTaskThread(null)}
              >
                # história
              </button>
              {/* Thread da task focada (canal task:<id>) para refinar só ela. */}
              {activeTaskThread ? (
                <button type="button" className="story-detail-suggest font-semibold">
                  task: {activeTaskTitle ?? activeTaskThread.slice(0, 8)}
                </button>
              ) : null}
            </div>
          ) : null}
        </SheetHeader>

        <div className="story-thread-scroll flex-1 min-h-0 overflow-y-auto">
          <div className="story-thread-detail">
            <section className="story-detail-section">
              <div className="story-detail-tasks-head">
                <h4 className="story-detail-label">Tasks da história</h4>
                <button
                  type="button"
                  className="story-detail-suggest"
                  disabled={busy || !sessionId}
                  onClick={handleSuggestTasks}
                >
                  ✨ Sugerir tasks
                </button>
              </div>
              <p className="story-detail-empty mt-1">
                Peça à IA para propor tasks. Clique numa task para refiná-la numa
                thread dedicada. Ao materializar, elas viram cards{" "}
                <code>type:task</code> filhos desta história em To Do — o badge
                "Precisa de você" some e o loop pode rodar.
              </p>
            </section>
          </div>

          <div className="backlog-chat-body story-thread-chat">
            <ChatPanel
              messages={panelMessages}
              pending={pending ? { options: pending.options } : null}
              thinking={streaming}
              activityLabel={lastActivity}
              since={streamingSince}
              busy={busy}
              inputMode="always"
              placeholder={
                activeTaskThread
                  ? "Refine esta task…"
                  : pending
                    ? "Responda ou escreva livremente…"
                    : "Converse sobre esta história…"
              }
              submitLabel="Enviar"
              busyLabel="Enviando…"
              emptyState={
                sessionId
                  ? "Converse sobre esta história e refine suas tasks com a IA."
                  : "Abrindo o chat da história…"
              }
              questionHint={
                pending ? (
                  <div className="agent-chat-question-hint">
                    <span className="agent-chat-question-icon">💬</span>
                    A IA aguarda sua resposta
                  </div>
                ) : undefined
              }
              onSend={handleSend}
              onQuickReply={(text) => (pending ? answer(text) : send(text))}
              renderMessageBody={(msg) => {
                const proposalMsg = taskProposalById.get(msg.id);
                if (proposalMsg?.taskProposal) {
                  return (
                    <TaskProposalCard
                      proposal={proposalMsg.taskProposal}
                      isCurrent={
                        currentTaskVersion !== null &&
                        proposalMsg.taskProposal.version === currentTaskVersion
                      }
                      onOpenTask={(task) => setActiveTaskThread(task.id)}
                      onMaterialize={handleMaterialize}
                      materializing={materialize.isPending}
                    />
                  );
                }
                return <AgentMessageBody text={msg.text} />;
              }}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
