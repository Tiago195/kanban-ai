import { useEffect, useMemo, useState } from "react";
import type { Iteration } from "@kanban-ai/shared";

const PHASE_META: Record<string, { label: string; emoji: string }> = {
  reproduce: { label: "Reproduzir", emoji: "🔁" },
  analysis: { label: "Análise", emoji: "🔎" },
  implementation: { label: "Implementação", emoji: "🛠️" },
  validation: { label: "Validação", emoji: "✅" },
};

type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("@@")) {
    return line.startsWith("@@") ? "hunk" : "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** Render leve de um unified diff: quebra por linhas e estiliza +/-. */
function DiffBody({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  if (!diff.trim()) {
    return <div className="diff-empty">Sem mudanças de código nesta iteração.</div>;
  }
  return (
    <pre className="diff-body">
      {lines.map((line, i) => {
        const kind = classifyLine(line);
        return (
          <div key={i} className={`diff-line diff-${kind}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Diff/Replay Viewer: lista as iterações de uma task e mostra o diff da
 * selecionada. Navegação prev/next = "replay" (iteração a iteração). Reage a
 * novas iterações (a lista vem via React Query, invalidada por
 * `iteration.appended`) mantendo a seleção estável.
 */
export function IterationDiffViewer({ iterations = [] }: { iterations?: Iteration[] }) {
  const ordered = useMemo(
    () => [...iterations].sort((a, b) => a.index - b.index),
    [iterations],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Ao chegar novas iterações: se nada selecionado, pula para a última.
  useEffect(() => {
    if (ordered.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) =>
      prev && ordered.some((it) => it.id === prev)
        ? prev
        : ordered[ordered.length - 1].id,
    );
  }, [ordered]);

  const selectedIndex = ordered.findIndex((it) => it.id === selectedId);
  const selected = selectedIndex >= 0 ? ordered[selectedIndex] : null;

  const goPrev = () => {
    if (selectedIndex > 0) setSelectedId(ordered[selectedIndex - 1].id);
  };
  const goNext = () => {
    if (selectedIndex >= 0 && selectedIndex < ordered.length - 1) {
      setSelectedId(ordered[selectedIndex + 1].id);
    }
  };

  if (ordered.length === 0) {
    return (
      <div className="diff-empty">
        Sem iterações ainda. Rode 1 iteração ou mova a história para In Progress.
      </div>
    );
  }

  return (
    <div className="diff-viewer">
      <div className="diff-replay-bar">
        <button
          className="diff-nav-btn"
          onClick={goPrev}
          disabled={selectedIndex <= 0}
          aria-label="Iteração anterior"
        >
          ← Anterior
        </button>
        <span className="diff-replay-pos">
          Iteração {selected ? selected.index : "–"} de {ordered.length}
        </span>
        <button
          className="diff-nav-btn"
          onClick={goNext}
          disabled={selectedIndex < 0 || selectedIndex >= ordered.length - 1}
          aria-label="Próxima iteração"
        >
          Próxima →
        </button>
      </div>

      <div className="diff-iter-list">
        {ordered.map((it) => {
          const meta = PHASE_META[it.phase] ?? { label: it.phase, emoji: "•" };
          return (
            <button
              key={it.id}
              className={`diff-iter-chip${it.id === selectedId ? " is-active" : ""}`}
              onClick={() => setSelectedId(it.id)}
              title={`${meta.label} — iteração #${it.index}`}
            >
              {meta.emoji} #{it.index}
            </button>
          );
        })}
      </div>

      {selected ? <DiffBody diff={selected.diff} /> : null}
    </div>
  );
}
