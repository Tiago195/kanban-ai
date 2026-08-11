import type {
  BacklogTaskProposal,
  BacklogTaskProposalItem,
} from "@kanban-ai/shared";

export interface TaskProposalCardProps {
  proposal: BacklogTaskProposal;
  /** true na proposta corrente (habilita clique/materialização). */
  isCurrent: boolean;
  /**
   * Abre a thread focada de uma task (`task:<id>`) para refinar SÓ ela. Quando
   * fornecido, cada task vira clicável — mesmo padrão do `ProposalCard` das
   * stories (ADR-0026).
   */
  onOpenTask?: (task: BacklogTaskProposalItem) => void;
  /** Materializa as tasks propostas como cards `type:task` em To Do. */
  onMaterialize?: () => void;
  materializing?: boolean;
}

/**
 * Cartão da proposta de TASKS exibido dentro do chat da story (ADR-0026).
 * Espelha o `ProposalCard` das stories: mostra a lista de tasks; cada task é
 * clicável e abre uma thread focada de refinamento (`task:<id>`). Só a proposta
 * corrente pode ser materializada.
 */
export function TaskProposalCard({
  proposal,
  isCurrent,
  onOpenTask,
  onMaterialize,
  materializing,
}: TaskProposalCardProps) {
  return (
    <div className={"proposal-card" + (isCurrent ? "" : " proposal-card-stale")}>
      <div className="proposal-card-head">
        <div className="proposal-card-title">
          <span className="proposal-card-badge">☑ Tasks</span>
          <b>{proposal.tasks.length} task(s) sugerida(s)</b>
        </div>
        <div className="proposal-card-meta">
          <span title="Versão da proposta de tasks">v{proposal.version}</span>
        </div>
      </div>

      <ul className="proposal-story-list">
        {proposal.tasks.map((task, i) => {
          const clickable = Boolean(onOpenTask) && isCurrent;
          const content = (
            <div className="proposal-story-head">
              <span className="proposal-story-badge">☑</span>
              <span className="proposal-story-title">{task.title}</span>
              {clickable ? (
                <span className="proposal-story-open" aria-hidden="true">
                  💬
                </span>
              ) : null}
            </div>
          );
          return (
            <li key={task.id ?? i} className="proposal-story">
              {clickable ? (
                <button
                  type="button"
                  className="proposal-story-btn"
                  data-testid="task-proposal-item"
                  onClick={() => onOpenTask?.(task)}
                  title="Refinar esta task numa thread dedicada"
                >
                  {content}
                </button>
              ) : (
                content
              )}
              {task.description ? (
                <p className="proposal-card-desc">{task.description}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {proposal.rationale ? (
        <p className="proposal-card-rationale">💡 {proposal.rationale}</p>
      ) : null}

      {isCurrent && onMaterialize ? (
        <div className="proposal-card-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="task-proposal-materialize"
            onClick={onMaterialize}
            disabled={materializing || proposal.tasks.length === 0}
          >
            {materializing
              ? "Criando…"
              : `✓ Materializar ${proposal.tasks.length} task(s) em To Do`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
