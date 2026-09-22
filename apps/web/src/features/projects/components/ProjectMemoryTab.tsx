import { useMemo, useState } from "react";

import type {
  MemoryNeuronSummary,
  ProjectLearning,
  ProjectLearningDeadEnd,
  ProjectLearningNode,
} from "@kanban-ai/shared";

import {
  useProjectLearning,
  useProjectMemory,
  useProjectNeuron,
} from "../hooks/useProjectExplorer";
import { splitFrontmatter } from "../lib/markdownLite";
import {
  contestedScore,
  deriveMemoryView,
  filterCorrections,
  filterDeadEnds,
  filterLearningNodes,
  filterNeurons,
  outcomeLabel,
  signalDay,
  splitLearning,
  verdictLabel,
} from "../lib/memoryPanel";
import { MarkdownLite } from "./MarkdownLite";

/**
 * US-UX.3 — aba "O que a AI sabe" vira o PAINEL do que a AI aprendeu.
 *
 * A lista plana de neurônios desperdiçava o que o EP-F5 destravou: o
 * `graphify reflect` (US-F5.2) já grava em disco vereditos por nó
 * (preferred/tentative/contested), proveniência (as perguntas originais com
 * data e outcome), becos sem saída e o `code_fingerprint` (código mudou →
 * `stale`). Este painel projeta os TRÊS blocos que já existem no dado:
 *
 *  1. "O que a AI aprendeu" — aprendizados ancorados no código
 *     (`source_nodes` → nó/arquivo) com a pergunta que os originou;
 *  2. "Contestado" — sinais em conflito, com o placar e o veredito da
 *     recência;
 *  3. "Becos sem saída" — o mais valioso: já tentamos, não levou a nada,
 *     não re-deduzir.
 *
 * Sinal transversal: `stale` = o código mudou desde o aprendizado — suspeito,
 * não falso (rótulo + cor, nunca cor sozinha). Preservados da MemoryTab
 * antiga: busca (agora transversal aos blocos), leitura do neurônio completo
 * e o estado vazio honesto — que agora explica o que fará aparecer conteúdo.
 * Padrão da US-UX.2: lógica pura em `../lib/memoryPanel.ts` (com specs); o
 * componente só desenha.
 */
export function ProjectMemoryTab({ projectId }: { projectId: string | null }) {
  const memoryQuery = useProjectMemory(projectId);
  const learningQuery = useProjectLearning(projectId);
  const neurons = memoryQuery.data ?? [];
  const learning = learningQuery.data;
  const ok: ProjectLearning | null = learning?.ok === true ? learning : null;

  const [search, setSearch] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);

  const view = deriveMemoryView({
    memoryLoading: memoryQuery.isLoading,
    neurons,
    learningLoading: learningQuery.isLoading,
    learning,
  });

  const buckets = useMemo(() => splitLearning(ok?.nodes ?? []), [ok]);
  const learned = useMemo(
    () => filterLearningNodes(buckets.learned, search),
    [buckets.learned, search],
  );
  const contested = useMemo(
    () => filterLearningNodes(buckets.contested, search),
    [buckets.contested, search],
  );
  const deadEnds = useMemo(
    () => filterDeadEnds(ok?.deadEnds ?? [], search),
    [ok, search],
  );
  const corrections = useMemo(
    () => filterCorrections(ok?.corrections ?? [], search),
    [ok, search],
  );
  const filteredNeurons = useMemo(() => filterNeurons(neurons, search), [neurons, search]);
  const searching = search.trim().length > 0;

  return (
    <div data-testid="memory-tab">
      {view.kind === "loading" ? (
        <div style={{ color: "var(--text-muted)" }}>Carregando memória…</div>
      ) : view.kind === "empty" ? (
        <EmptyState
          title="A AI ainda não aprendeu nada"
          hint={
            "Quando a frota executar cards, cada resposta útil (ou beco sem saída) vira um " +
            "memory doc em .hive/memory do clone; o reflect agrega esses sinais em vereditos " +
            "por nó do código — e é isso que aparece aqui: aprendizados, contestados e becos."
          }
        />
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <input
            className="card-desc-input"
            placeholder="Buscar por nó, arquivo, pergunta, título ou tag…"
            data-testid="memory-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ margin: 0 }}
          />

          {view.learningError ? (
            /* Falha VISÍVEL (padrão F4.1/F5.4): o overlay não veio, os
               neurônios crus seguem lá embaixo. */
            <div data-testid="learning-error" style={{ fontSize: 12 }}>
              <span className="chip" style={pillStyle("var(--danger)")}>
                aprendizado indisponível
              </span>{" "}
              <span style={{ color: "var(--text-muted)" }}>{view.learningError}</span>
            </div>
          ) : ok ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }} data-testid="learning-meta">
              Destilado de {ok.docs} memória(s) pelo reflect
              {ok.generatedAt ? ` · vereditos de ${signalDay(ok.generatedAt)}` : ""} · o código
              que mudou desde o aprendizado é sinalizado
            </div>
          ) : null}

          <LearningBlock
            icon="🧠"
            title={`O que a AI aprendeu (${learned.length})`}
            testid="learning-learned"
            emptyHint={
              searching
                ? "Nenhum aprendizado corresponde à busca."
                : "Nenhum veredito ainda — uma resposta útil torna o nó tentativo; útil em 2+ sessões, preferido."
            }
            empty={learned.length === 0}
          >
            {learned.map((node) => (
              <LearningNodeCard key={node.id} node={node} />
            ))}
          </LearningBlock>

          <LearningBlock
            icon="⚖️"
            title={`Contestado (${contested.length})`}
            testid="learning-contested"
            emptyHint={
              searching
                ? "Nenhum contestado corresponde à busca."
                : "Nada em conflito — este bloco aparece quando o mesmo nó recebe sinais úteis E becos; a recência decide."
            }
            empty={contested.length === 0}
          >
            {contested.map((node) => (
              <LearningNodeCard key={node.id} node={node} />
            ))}
          </LearningBlock>

          <LearningBlock
            icon="🚧"
            title={`Becos sem saída (${deadEnds.length})`}
            testid="learning-deadends"
            emptyHint={
              searching
                ? "Nenhum beco corresponde à busca."
                : "Nenhum beco registrado — quando uma investigação é marcada como dead_end, ela fica aqui para a frota não re-deduzir o caminho que já falhou."
            }
            empty={deadEnds.length === 0}
          >
            {deadEnds.map((deadEnd) => (
              <DeadEndCard key={`${deadEnd.date}|${deadEnd.question}`} deadEnd={deadEnd} />
            ))}
          </LearningBlock>

          {corrections.length > 0 ? (
            <LearningBlock
              icon="✏️"
              title={`Correções (${corrections.length})`}
              testid="learning-corrections"
              empty={false}
              emptyHint=""
            >
              {corrections.map((c) => (
                <div
                  key={`${c.date}|${c.question}`}
                  data-testid="learning-correction"
                  style={cardStyle}
                >
                  <div style={{ fontSize: 13 }}>
                    “{c.question}” <span style={{ color: "var(--text-muted)" }}>→</span>{" "}
                    {c.correction}
                  </div>
                  {c.date ? (
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {signalDay(c.date)}
                    </div>
                  ) : null}
                </div>
              ))}
            </LearningBlock>
          ) : null}

          {/* A lista crua de neurônios continua disponível (leitura completa
              preservada), agora como detalhe — o painel é o evento principal. */}
          <details data-testid="memory-neuron-list" open={neurons.length > 0 && !ok?.nodes.length}>
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
              Memórias cruas ({filteredNeurons.length}
              {searching ? ` de ${neurons.length}` : ""})
            </summary>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {filteredNeurons.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {searching
                    ? "Nenhum neurônio corresponde à busca."
                    : "Nenhum memory doc no clone ainda."}
                </div>
              ) : (
                filteredNeurons.map((n) => (
                  <NeuronCard key={n.path} neuron={n} onOpen={() => setOpenPath(n.path)} />
                ))
              )}
            </div>
          </details>
        </div>
      )}

      {openPath ? (
        <NeuronDrawer projectId={projectId} path={openPath} onClose={() => setOpenPath(null)} />
      ) : null}
    </div>
  );
}

// ── Blocos e cards do painel ─────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "10px 12px",
  background: "var(--surface-2, transparent)",
  display: "grid",
  gap: 6,
};

/** Pill de status: cor no ANEL, rótulo no texto — cor nunca é o único canal. */
function pillStyle(color: string): React.CSSProperties {
  return {
    border: `1.5px solid ${color}`,
    borderRadius: 999,
    padding: "1px 8px",
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text)",
    background: "transparent",
    whiteSpace: "nowrap",
  };
}

const STATUS_META: Record<
  ProjectLearningNode["status"],
  { label: string; color: string }
> = {
  preferred: { label: "✓ preferido", color: "var(--ok)" },
  tentative: { label: "· tentativo", color: "var(--text-muted)" },
  contested: { label: "⚖ contestado", color: "var(--warn)" },
};

function LearningBlock({
  icon,
  title,
  testid,
  empty,
  emptyHint,
  children,
}: {
  icon: string;
  title: string;
  testid: string;
  empty: boolean;
  emptyHint: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testid} style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>
        <span aria-hidden>{icon}</span> {title}
      </div>
      {empty ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{emptyHint}</div>
      ) : (
        <div style={{ display: "grid", gap: 8, maxWidth: 960 }}>{children}</div>
      )}
    </section>
  );
}

/**
 * Um nó com veredito: âncora no código (label + arquivo), status, placar
 * (contestado), sinal de código mudado e a trilha de proveniência (as
 * perguntas originais que geraram o aprendizado).
 */
function LearningNodeCard({ node }: { node: ProjectLearningNode }) {
  const meta = STATUS_META[node.status];
  return (
    <div data-testid="learning-node-card" style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={pillStyle(meta.color)}>{meta.label}</span>
        <strong style={{ fontSize: 13 }}>
          <code>{node.label}</code>
        </strong>
        {node.sourceFile ? (
          <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{node.sourceFile}</code>
        ) : null}
        {node.stale ? (
          /* US-UX.3 — o code_fingerprint divergiu: aprendizado sobre código
             que se moveu é SUSPEITO, não falso. Rótulo explícito + cor. */
          <span data-testid="learning-stale" style={pillStyle("var(--warn)")}>
            ⚠ código mudou desde o aprendizado
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {node.status === "contested"
          ? `${contestedScore(node)} → ${verdictLabel(node.verdict)}`
          : `${node.uses}× útil${node.status === "tentative" ? " (ainda não corroborado)" : ""}`}
        {node.last ? ` · último sinal ${signalDay(node.last)}` : ""}
      </div>
      {node.provenance.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
          {node.provenance.map((p, index) => (
            <li key={index} style={{ fontSize: 12 }}>
              “{p.q}”{" "}
              <span style={{ color: "var(--text-muted)" }}>
                — {signalDay(p.date)} · {outcomeLabel(p.outcome)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DeadEndCard({ deadEnd }: { deadEnd: ProjectLearningDeadEnd }) {
  return (
    <div data-testid="learning-deadend" style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={pillStyle("var(--danger)")}>⛔ não re-deduzir</span>
        <span style={{ fontSize: 13 }}>“{deadEnd.question}”</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {deadEnd.nodes.map((n) => (
          <code key={n}>{n}</code>
        ))}
        {deadEnd.date ? <span>· {signalDay(deadEnd.date)}</span> : null}
      </div>
    </div>
  );
}

// ── Preservados da MemoryTab antiga (US-PROJ7): card e leitura do neurônio ───

function NeuronCard({
  neuron,
  onOpen,
}: {
  neuron: MemoryNeuronSummary;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="neuron-card"
      data-testid="neuron-card"
      onClick={onOpen}
      style={{
        textAlign: "left",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        // US-UX.3 — surface-2 (não surface): o path em --text-muted sobre
        // --surface media 4.5:1 cravado no tema claro; sobre --surface-2
        // (branco) sobe para ~5.4:1 com folga.
        background: "var(--surface-2, transparent)",
        cursor: "pointer",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong>{neuron.title || neuron.path}</strong>
      </div>
      <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{neuron.path}</code>
      {neuron.summary ? <div style={{ fontSize: 13 }}>{neuron.summary}</div> : null}
      {neuron.tags.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {neuron.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

function NeuronDrawer({
  projectId,
  path,
  onClose,
}: {
  projectId: string | null;
  path: string;
  onClose: () => void;
}) {
  const detailQuery = useProjectNeuron(projectId, path);
  const detail = detailQuery.data;

  return (
    <div
      className="modal-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-panel" onClick={(event) => event.stopPropagation()} data-testid="neuron-drawer">
        <div className="kb-modal">
          <div className="modal-header">
            <div className="modal-title-row">
              <h2 style={{ margin: 0, fontSize: 15 }}>🧠 {detail?.title || path}</h2>
              <button className="modal-close" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </div>
          </div>
          <div className="modal-body">
            {detailQuery.isLoading ? (
              <div style={{ color: "var(--text-muted)" }}>Carregando neurônio…</div>
            ) : !detail ? (
              <EmptyState title="Neurônio indisponível" hint="Ele pode ter sido removido da colmeia." />
            ) : (
              <>
                {/* US-F2.3 — sem HEAD: neurônio é arquivo simples no .hive/ do clone. */}
                {/* US-F4.2 — o frontmatter (`---`) é METADADO, não conteúdo:
                    chips + corpo em markdown lite (nunca markdown cru). */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    marginBottom: 10,
                  }}
                >
                  <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{detail.path}</code>
                  {detail.tags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    atualizado em {new Date(detail.updatedAt).toLocaleString()}
                  </span>
                </div>
                <div style={{ maxHeight: "60vh", overflow: "auto" }}>
                  {detail.content ? (
                    <MarkdownLite text={splitFrontmatter(detail.content).body} />
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>(neurônio vazio)</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div
      data-testid="empty-state"
      style={{
        textAlign: "center",
        padding: "32px 16px",
        color: "var(--text-muted)",
        border: "1px dashed var(--border)",
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {hint ? <div style={{ fontSize: 12, marginTop: 6 }}>{hint}</div> : null}
    </div>
  );
}
