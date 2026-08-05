import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/services/apiClient";

export interface SessionSidebarProps {
  boardId: string | null;
  /** Sessão atualmente aberta (destacada na lista), ou null em `/backlog-chat`. */
  activeSessionId: string | null;
  /** Abre uma sessão existente (navega para `/backlog-chat/:id`). */
  onSelectSession: (sessionId: string) => void;
  /** Inicia uma conversa nova (navega para `/backlog-chat`). */
  onNewSession: () => void;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD} d`;
  return d.toLocaleDateString();
}

/**
 * Barra lateral estilo LibreChat com a lista de conversas de backlog do board.
 * Só lista sessões que já têm mensagens (o backend filtra as vazias). Clicar em
 * uma conversa navega para a URL dela (F5-safe); "+ Nova conversa" volta para
 * `/backlog-chat`, que cria uma sessão fresca.
 */
export function SessionSidebar({
  boardId,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: SessionSidebarProps) {
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["backlog-sessions", boardId],
    queryFn: () => apiClient.listBacklogSessions(boardId as string),
    enabled: !!boardId,
    refetchOnWindowFocus: false,
  });

  return (
    <aside className="backlog-session-sidebar">
      <button className="backlog-session-new" onClick={onNewSession}>
        <span aria-hidden>＋</span> Nova conversa
      </button>

      <div className="backlog-session-list">
        {isLoading && <p className="backlog-session-empty">Carregando…</p>}
        {!isLoading && sessions.length === 0 && (
          <p className="backlog-session-empty">Nenhuma conversa ainda.</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={
              "backlog-session-item" + (s.id === activeSessionId ? " is-active" : "")
            }
            onClick={() => onSelectSession(s.id)}
            title={s.title}
          >
            <span className="backlog-session-title">{s.title}</span>
            <span className="backlog-session-meta">
              {s.messageCount} msg · {formatWhen(s.updatedAt)}
              {s.status === "applied" && " · ✅"}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
