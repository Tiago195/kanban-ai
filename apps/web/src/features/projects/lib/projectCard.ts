/**
 * US-UX.4 — helpers PUROS do card de projeto (área "Projetos").
 * Mesmo padrão da casa (`graphView.ts`/`memoryPanel.ts`): a lógica — badges de
 * estado, a faixa de estado do conhecimento (clone · grafo · wiki · memória) e
 * a mensagem honesta de "zero módulos" (BUG-UI2) — vive aqui, testável
 * offline; o componente só desenha.
 */

import type {
  ProjectCloneState,
  ProjectGraphState,
  ProjectKnowledgeSummary,
} from "@kanban-ai/shared";

/** Tom visual de um badge/fato — cor NUNCA é o único canal (o rótulo textual
 * acompanha sempre); o tom só reforça. */
export type BadgeTone = "ok" | "warn" | "danger" | "muted";

export interface StateBadge {
  label: string;
  tone: BadgeTone;
}

/** Badge do estado do clone: `falhou` grita (danger), transitórios avisam. */
export function cloneStateBadge(state: ProjectCloneState): StateBadge {
  switch (state) {
    case "ready":
      return { label: "pronto", tone: "ok" };
    case "failed":
      return { label: "falhou", tone: "danger" };
    case "cloning":
      return { label: "clonando…", tone: "warn" };
    default:
      return { label: "pendente", tone: "warn" };
  }
}

/** Um fato da faixa de estado do conhecimento do card. */
export interface KnowledgeFact {
  key: "clone" | "graph" | "wiki" | "memory";
  icon: string;
  label: string;
  /** Valor legível ("312 nós · 640 arestas", "ainda não gerada", "falhou"). */
  value: string;
  tone: BadgeTone;
  /** Erro legível (só quando tone === 'danger' com causa conhecida). */
  detail: string | null;
}

const fact = (
  key: KnowledgeFact["key"],
  icon: string,
  label: string,
  value: string,
  tone: BadgeTone,
  detail: string | null = null,
): KnowledgeFact => ({ key, icon, label, value, tone, detail });

/**
 * A faixa do card: um olhar responde "o que a AI tem sobre este repo?".
 * `summary` ausente (carregando / rota fora) degrada para "…" mudo — nunca
 * esconde a faixa nem inventa números. Estados vazios são HONESTOS
 * ("ainda não gerada" ≠ "indisponível"), e falha é visível (danger + causa).
 */
export function knowledgeFacts(args: {
  cloneState: ProjectCloneState;
  graphState: ProjectGraphState;
  summary: ProjectKnowledgeSummary | undefined;
}): KnowledgeFact[] {
  const { cloneState, graphState, summary } = args;
  const clone = cloneStateBadge(cloneState);
  const facts: KnowledgeFact[] = [
    fact("clone", "📦", "Clone", clone.label, clone.tone),
  ];

  // Grafo: o estado (fresco, via WS) manda; as contagens vêm do resumo.
  if (summary?.graph.ok) {
    facts.push(
      fact(
        "graph",
        "🕸️",
        "Grafo",
        `${summary.graph.nodes} nós · ${summary.graph.edges} arestas`,
        "ok",
      ),
    );
  } else if (graphState === "failed") {
    facts.push(
      fact("graph", "🕸️", "Grafo", "falhou", "danger", summary && !summary.graph.ok ? summary.graph.error : null),
    );
  } else if (graphState === "building") {
    facts.push(fact("graph", "🕸️", "Grafo", "construindo…", "warn"));
  } else if (!summary) {
    facts.push(fact("graph", "🕸️", "Grafo", "…", "muted"));
  } else if (graphState === "ready") {
    // Grafo construído mas a consulta falhou (sidecar fora): indisponível ≠
    // inexistente — falha visível com a causa, nunca "ainda não construído".
    facts.push(fact("graph", "🕸️", "Grafo", "indisponível", "danger", summary.graph.ok ? null : summary.graph.error));
  } else {
    facts.push(fact("graph", "🕸️", "Grafo", "ainda não construído", "muted"));
  }

  // Wiki: gerada (N artigos) · ainda não gerada · indisponível (sidecar fora).
  if (!summary) {
    facts.push(fact("wiki", "📖", "Wiki", "…", "muted"));
  } else if (!summary.wiki.ok) {
    facts.push(fact("wiki", "📖", "Wiki", "indisponível", "danger", summary.wiki.error));
  } else if (!summary.wiki.generated) {
    facts.push(fact("wiki", "📖", "Wiki", "ainda não gerada", "muted"));
  } else {
    const n = summary.wiki.articles;
    facts.push(fact("wiki", "📖", "Wiki", `${n} artigo${n === 1 ? "" : "s"}`, "ok"));
  }

  // Memória: aprendizados (+ contestados destacados) · nada ainda · indisponível.
  if (!summary) {
    facts.push(fact("memory", "🐝", "Memória", "…", "muted"));
  } else if (!summary.memory.ok) {
    facts.push(fact("memory", "🐝", "Memória", "indisponível", "danger", summary.memory.error));
  } else if (!summary.memory.generated && summary.memory.learnings === 0) {
    facts.push(fact("memory", "🐝", "Memória", "nada aprendido ainda", "muted"));
  } else {
    const m = summary.memory;
    const base = `${m.learnings} aprendizado${m.learnings === 1 ? "" : "s"}`;
    facts.push(
      m.contested > 0
        ? fact("memory", "🐝", "Memória", `${base} · ${m.contested} contestado${m.contested === 1 ? "" : "s"}`, "warn")
        : fact("memory", "🐝", "Memória", base, "ok"),
    );
  }

  return facts;
}

/**
 * BUG-UI2 — mensagem para "Módulos detectados: zero". Zero módulos com clone
 * `ready` é resultado LEGÍTIMO (repo flat, sem `src/`/`apps/`…): diga isso, e
 * só sugira problema de clone quando o clone de fato não está pronto — a
 * mensagem antiga ("repo ainda não clonado?") contradizia o HEAD visível ao
 * lado.
 */
export function modulesEmptyMessage(cloneState: ProjectCloneState): string {
  if (cloneState === "ready") {
    return "nenhum módulo detectado — o repositório não tem diretórios de módulos (src/, apps/, packages/…); resultado normal para repositórios simples";
  }
  const clone = cloneStateBadge(cloneState);
  return `nenhum — o clone ainda não está pronto (estado: ${clone.label})`;
}
