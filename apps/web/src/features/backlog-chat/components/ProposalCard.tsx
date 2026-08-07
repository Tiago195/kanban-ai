import type { BacklogProposal, BacklogProposalStory } from "@kanban-ai/shared";

export interface ProposalCardProps {
  proposal: BacklogProposal;
  /** true na proposta corrente (habilita o botão de aprovar). */
  isCurrent: boolean;
  /** true quando a sessão já foi materializada no board (não pode reaplicar). */
  applied?: boolean;
  applying?: boolean;
  onApply?: () => void;
  /**
   * Callback para abrir a thread focada de uma story (Sheet estilo Slack —
   * ADR-0023). Quando fornecido, cada story vira clicável.
   */
  onOpenStory?: (story: BacklogProposalStory) => void;
}

/**
 * Cartão de proposta de backlog exibido dentro do chat. Mostra o épico e a
 * lista de histórias; cada história é clicável e abre uma thread focada (Sheet)
 * com os detalhes ricos + chat dedicado (ADR-0023). Só a proposta corrente pode
 * ser aprovada.
 */
export function ProposalCard({
  proposal,
  isCurrent,
  applied,
  applying,
  onApply,
  onOpenStory,
}: ProposalCardProps) {
  const totalPoints = proposal.stories.reduce((acc, s) => acc + (s.points ?? 0), 0);

  return (
    <div className={"proposal-card" + (isCurrent ? "" : " proposal-card-stale")}>
      <div className="proposal-card-head">
        <div className="proposal-card-title">
          <span className="proposal-card-badge">📦 Épico</span>
          <b>{proposal.epic.title}</b>
        </div>
        <div className="proposal-card-meta">
          <span title="Versão da proposta">v{proposal.version}</span>
          <span title="Histórias">{proposal.stories.length} histórias</span>
          {totalPoints > 0 ? <span title="Pontos totais">{totalPoints} pts</span> : null}
        </div>
      </div>

      {proposal.epic.description ? (
        <p className="proposal-card-desc">{proposal.epic.description}</p>
      ) : null}

      <ul className="proposal-story-list">
        {proposal.stories.map((story, i) => {
          const clickable = Boolean(onOpenStory);
          const content = (
            <div className="proposal-story-head">
              <span className="proposal-story-badge">📄</span>
              <span className="proposal-story-title">{story.title}</span>
              {story.points != null ? (
                <span className="proposal-story-points">{story.points}</span>
              ) : null}
              {story.tasks && story.tasks.length > 0 ? (
                <span
                  className="proposal-story-tasks"
                  title={`${story.tasks.length} tasks rascunhadas`}
                >
                  ☑ {story.tasks.length}
                </span>
              ) : null}
              {story.dod && story.dod.length > 0 ? (
                <span
                  className="proposal-story-dod"
                  title={`${story.dod.length} itens de DoD`}
                >
                  ✓ {story.dod.length}
                </span>
              ) : null}
              {story.affectedFlows && story.affectedFlows.length > 0 ? (
                <span
                  className="proposal-story-flows"
                  title={`${story.affectedFlows.length} fluxos afetados`}
                >
                  🔀 {story.affectedFlows.length}
                </span>
              ) : null}
              {clickable ? (
                <span className="proposal-story-open" aria-hidden="true">
                  💬
                </span>
              ) : null}
            </div>
          );
          return (
            <li key={story.id ?? i} className="proposal-story">
              {clickable ? (
                <button
                  type="button"
                  className="proposal-story-btn"
                  data-testid="proposal-story"
                  onClick={() => onOpenStory?.(story)}
                  title="Abrir thread desta história"
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ul>

      {proposal.rationale ? (
        <p className="proposal-card-rationale">💡 {proposal.rationale}</p>
      ) : null}

      <div className="proposal-card-actions">
        {applied ? (
          <span className="proposal-card-applied">✅ Aplicado no board</span>
        ) : isCurrent && onApply ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="proposal-apply"
            onClick={onApply}
            disabled={applying}
          >
            {applying ? "Criando…" : "✓ Aprovar e criar no board"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
