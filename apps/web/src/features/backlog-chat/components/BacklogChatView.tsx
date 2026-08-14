import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BacklogChatMessage, BacklogProposalStory } from "@kanban-ai/shared";

import { ChatPanel, AgentMessageBody, type ChatPanelMessage } from "@/features/ai-engine";
import { apiClient } from "@/shared/services/apiClient";
import { showToast } from "@/shared/services/toastStore";
import { useBacklogChat } from "@/features/backlog-chat/hooks/useBacklogChat";
import { ProposalCard } from "@/features/backlog-chat/components/ProposalCard";
import { StoryThreadSheet } from "@/features/backlog-chat/components/StoryThreadSheet";
import { StoryChatSheet } from "@/features/backlog-chat/components/StoryChatSheet";
import { SessionSidebar } from "@/features/backlog-chat/components/SessionSidebar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";

export interface BacklogChatViewProps {
  boardId: string | null;
  /** Estado da query de boards — usado para distinguir "carregando board" de "criando sessão". */
  boardLoading?: boolean;
  /** Boards falharam ou nenhum board existe — o chat não tem onde criar a sessão. */
  boardUnavailable?: boolean;
  /** Retenta carregar os boards (usado no empty-state de erro). */
  onRetryBoard?: () => void;
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
  boardLoading = false,
  boardUnavailable = false,
  onRetryBoard,
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
  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [skipTasksWarning, setSkipTasksWarning] = useState(false);
  // Story-card do board resolvida a partir de uma story da proposta numa sessão
  // já aplicada — abre o `StoryChatSheet` (materialização real de tasks).
  const [storyChat, setStoryChat] = useState<{
    storyId: string;
    title: string;
  } | null>(null);

  const [createFailed, setCreateFailed] = useState(false);
  const createSession = useMutation({
    mutationFn: (bid: string) => apiClient.createBacklogSession(bid),
    onSuccess: (res) => {
      setCreateFailed(false);
      onSessionCreated(res.id);
    },
    onError: () => setCreateFailed(true),
  });

  // Numa sessão applied, "✨ Materializar tasks" na thread da proposta resolve a
  // story-card real do board (pelo título) e abre o chat da story, onde a
  // materialização incremental cria cards type:task de verdade (fecha o bug de
  // "tasks fantasma").
  const resolveStoryCard = useMutation({
    mutationFn: (vars: { sessionId: string; story: BacklogProposalStory }) =>
      apiClient.resolveAppliedStoryCard(vars.sessionId, vars.story.title),
    onSuccess: (res, vars) => {
      setOpenStorySnapshot(null);
      setStoryChat({ storyId: res.storyId, title: vars.story.title });
    },
    onError: () =>
      showToast("Não localizei esta história no board para materializar tasks"),
  });

  const createMutate = createSession.mutate;
  const creating = createSession.isPending;
  // Guarda síncrona: `isPending` do react-query não vira `true` no mesmo tick do
  // `mutate`, então sob StrictMode (double-invoke) ou re-render antes do estado
  // atualizar, o effect dispararia `createMutate` várias vezes → dezenas de
  // sessões vazias. O ref flipa de forma síncrona no 1º disparo e trava os
  // seguintes até a URL ganhar um `sessionId`; se a criação falhar, liberamos o
  // ref para permitir uma nova tentativa.
  const hasRequestedRef = useRef(false);
  useEffect(() => {
    // Se a URL já tem sessão, não há o que criar — e reseta o guard para uma
    // futura navegação a /backlog-chat "limpo" (ex.: "nova conversa").
    if (sessionId) {
      hasRequestedRef.current = false;
      return;
    }
    // Só cria sessão quando a URL não tem id (rota /backlog-chat sem :sessionId),
    // já temos um board-alvo, e a última tentativa não falhou (evita loop de
    // auto-retry — o usuário reativa manualmente pelo botão do empty-state).
    if (boardId && !creating && !createFailed && !hasRequestedRef.current) {
      hasRequestedRef.current = true;
      createMutate(boardId, {
        onError: () => {
          hasRequestedRef.current = false;
        },
      });
    }
  }, [boardId, sessionId, creating, createFailed, createMutate]);

  // Retenta a criação da sessão após uma falha (botão no empty-state). Se o
  // board também está indisponível, retenta o carregamento dos boards primeiro.
  const retryBoot = () => {
    if (boardUnavailable) {
      onRetryBoard?.();
      return;
    }
    setCreateFailed(false);
    hasRequestedRef.current = false;
  };

  const {
    messages,
    pending,
    proposal,
    streaming,
    streamingSince,
    lastActivity,
    isSending,
    isAnswering,
    isApplying,
    send,
    answer,
    apply,
  } = useBacklogChat(sessionId, boardId);

  const currentVersion = proposal?.version ?? null;

  const storiesWithoutTasks = useMemo(
    () =>
      proposal?.stories.filter((story) => !story.tasks || story.tasks.length === 0) ?? [],
    [proposal],
  );

  // Status da sessão (compartilha a query com a SessionSidebar via mesma key).
  // Usado para NÃO oferecer "Aprovar" numa sessão que já virou cards no board
  // (reaplicar duplicaria épico/stories/tasks; o backend responde 409).
  const { data: sessions = [] } = useQuery({
    queryKey: ["backlog-sessions", boardId],
    queryFn: () => apiClient.listBacklogSessions(boardId as string),
    enabled: !!boardId,
    refetchOnWindowFocus: false,
  });
  const alreadyApplied =
    sessions.find((s) => s.id === sessionId)?.status === "applied";

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

  // Empty-state distingue os estados de boot para nunca ficar num "Iniciando
  // conversa…" infinito: (1) board carregando, (2) board indisponível/erro,
  // (3) falha ao criar a sessão, (4) criando, (5) sessão pronta. Só (4) mostra
  // um spinner transitório; (2) e (3) oferecem "Tentar novamente".
  let emptyStateNode: ReactNode;
  if (!sessionId && boardUnavailable) {
    emptyStateNode = (
      <div className="backlog-chat-boot backlog-chat-boot-error">
        <span className="backlog-chat-boot-icon">⚠️</span>
        <p className="backlog-chat-boot-title">Não foi possível carregar o board</p>
        <p className="backlog-chat-boot-hint">
          O chat precisa de um board para criar o backlog. Verifique sua conexão e tente de novo.
        </p>
        <button type="button" className="btn btn-primary btn-sm" onClick={retryBoot}>
          Tentar novamente
        </button>
      </div>
    );
  } else if (!sessionId && createFailed) {
    emptyStateNode = (
      <div className="backlog-chat-boot backlog-chat-boot-error">
        <span className="backlog-chat-boot-icon">⚠️</span>
        <p className="backlog-chat-boot-title">Não consegui iniciar a conversa</p>
        <p className="backlog-chat-boot-hint">
          Falha ao criar a sessão de backlog. Isso costuma ser temporário.
        </p>
        <button type="button" className="btn btn-primary btn-sm" onClick={retryBoot}>
          Tentar novamente
        </button>
      </div>
    );
  } else if (!sessionId && (boardLoading || createSession.isPending || !boardId)) {
    emptyStateNode = (
      <div className="backlog-chat-boot">
        <span className="backlog-chat-boot-spinner" aria-hidden="true" />
        <p className="backlog-chat-boot-hint">Iniciando conversa…</p>
      </div>
    );
  } else {
    emptyStateNode =
      "Conte à IA o que você quer construir. Ela vai te ajudar a estruturar um épico com histórias.";
  }

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

  const handleApplyRequest = () => {
    if (storiesWithoutTasks.length === 0) {
      apply();
      return;
    }
    setSkipTasksWarning(false);
    setApplyModalOpen(true);
  };

  const handleSuggestTasksNow = () => {
    const firstStoryWithoutTasks = storiesWithoutTasks[0];
    if (!firstStoryWithoutTasks) return;
    setApplyModalOpen(false);
    setSkipTasksWarning(false);
    // TODO(story-chat-threads): quando existir alvo dedicado no fluxo de thread,
    // encaminhar para ele em vez de apenas abrir o sheet da story.
    setOpenStorySnapshot(firstStoryWithoutTasks);
  };

  const handleConfirmApplyAnyway = () => {
    apply();
    setApplyModalOpen(false);
    setSkipTasksWarning(false);
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
            activityLabel={lastActivity}
            since={streamingSince}
            busy={busy}
            inputMode="always"
            placeholder={
              pending ? "Responda ou escreva livremente…" : "Descreva a ideia do backlog…"
            }
            submitLabel="Enviar"
            busyLabel="Enviando…"
            emptyState={emptyStateNode}
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
                    applied={alreadyApplied}
                    applying={isApplying}
                    onApply={handleApplyRequest}
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
          applied={alreadyApplied}
          onMaterializeTasks={(story) => {
            if (!sessionId) return;
            resolveStoryCard.mutate({ sessionId, story });
          }}
          open
          onOpenChange={(o) => {
            if (!o) setOpenStorySnapshot(null);
          }}
        />
      ) : null}
      {storyChat ? (
        <StoryChatSheet
          storyId={storyChat.storyId}
          storyTitle={storyChat.title}
          boardId={boardId}
          open
          onOpenChange={(o) => {
            if (!o) setStoryChat(null);
          }}
        />
      ) : null}
      <Dialog open={applyModalOpen} onOpenChange={setApplyModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stories sem tasks</DialogTitle>
            <DialogDescription>
              As seguintes stories ainda não têm tasks:
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc pl-5 text-sm">
            {storiesWithoutTasks.map((story) => (
              <li key={story.id}>{story.title}</li>
            ))}
          </ul>
          {skipTasksWarning ? (
            <p className="text-sm text-amber-700">
              Stories sem tasks entram no board, mas ao serem puxadas para In Progress o loop
              não terá o que executar e elas serão marcadas como "Precisa de você" até que
              tasks sejam criadas (via chat da story).
            </p>
          ) : null}
          <DialogFooter>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleSuggestTasksNow}>
              Criar tasks agora
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                if (!skipTasksWarning) {
                  setSkipTasksWarning(true);
                  return;
                }
                handleConfirmApplyAnyway();
              }}
              disabled={isApplying}
            >
              {skipTasksWarning ? (isApplying ? "Criando…" : "Confirmar aprovação") : "Aprovar mesmo assim"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
