/**
 * US-UX.3 — helpers PUROS do painel da memória ("O que a AI sabe").
 * Mesmo padrão das US-F4.2/F5.4 (`graphView.ts`/`wikiView.ts`): a lógica
 * (máquina de estados da tela, ordenação dos blocos, busca transversal,
 * rótulos de veredito) vive aqui, testável offline; o componente só desenha.
 */

import type {
  MemoryNeuronSummary,
  ProjectLearningCorrection,
  ProjectLearningDeadEnd,
  ProjectLearningNode,
  ProjectLearningResponse,
} from '@kanban-ai/shared';

/** Estado projetado da aba — a UI só faz switch sobre ele. */
export type MemoryViewState =
  | { kind: 'loading' }
  /** Nada aprendido E nenhum neurônio — o estado vazio honesto. */
  | { kind: 'empty' }
  /** Há conteúdo (neurônios e/ou aprendizado). `learningError` = a consulta
   * do learning falhou (sidecar fora) — falha VISÍVEL, neurônios seguem. */
  | { kind: 'panel'; learningError: string | null };

/**
 * Deriva o estado da tela. O aprendizado indisponível (`{ok:false}`) NÃO
 * esconde os neurônios; e neurônios zerados com learning vazio caem no
 * estado vazio único (não três blocos vazios empilhados).
 */
export function deriveMemoryView(args: {
  memoryLoading: boolean;
  neurons: MemoryNeuronSummary[];
  learningLoading: boolean;
  learning: ProjectLearningResponse | undefined;
}): MemoryViewState {
  const { memoryLoading, neurons, learningLoading, learning } = args;
  if (memoryLoading || learningLoading) return { kind: 'loading' };
  const generated = learning?.ok === true && learning.generated;
  if (neurons.length === 0 && !generated) return { kind: 'empty' };
  return {
    kind: 'panel',
    learningError: learning && !learning.ok ? learning.error : null,
  };
}

/** Os dois blocos de vereditos: aprendizados (preferred+tentative) e contestados. */
export interface LearningBuckets {
  learned: ProjectLearningNode[];
  contested: ProjectLearningNode[];
}

const STATUS_RANK: Record<string, number> = { preferred: 0, tentative: 1, contested: 2 };

/**
 * Separa e ordena os nós do overlay para os blocos do painel: aprendizados
 * recentes primeiro (data do último sinal desc; empate por status
 * preferred>tentative e id — determinístico).
 */
export function splitLearning(nodes: ProjectLearningNode[]): LearningBuckets {
  const byRecency = (a: ProjectLearningNode, b: ProjectLearningNode) =>
    b.last.localeCompare(a.last) ||
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
    a.id.localeCompare(b.id);
  const learned = nodes.filter((n) => n.status === 'preferred' || n.status === 'tentative');
  const contested = nodes.filter((n) => n.status === 'contested');
  learned.sort(byRecency);
  contested.sort(byRecency);
  return { learned, contested };
}

/** Busca transversal: label, arquivo, id e as perguntas da proveniência. */
export function filterLearningNodes(
  nodes: ProjectLearningNode[],
  query: string,
): ProjectLearningNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.filter(
    (n) =>
      n.label.toLowerCase().includes(q) ||
      n.id.toLowerCase().includes(q) ||
      (n.sourceFile ?? '').toLowerCase().includes(q) ||
      n.provenance.some((p) => p.q.toLowerCase().includes(q)),
  );
}

/** Busca nos becos sem saída: pergunta e nós citados. */
export function filterDeadEnds(
  deadEnds: ProjectLearningDeadEnd[],
  query: string,
): ProjectLearningDeadEnd[] {
  const q = query.trim().toLowerCase();
  if (!q) return deadEnds;
  return deadEnds.filter(
    (d) =>
      d.question.toLowerCase().includes(q) ||
      d.nodes.some((n) => n.toLowerCase().includes(q)),
  );
}

/** Busca nas correções: pergunta e texto da correção. */
export function filterCorrections(
  corrections: ProjectLearningCorrection[],
  query: string,
): ProjectLearningCorrection[] {
  const q = query.trim().toLowerCase();
  if (!q) return corrections;
  return corrections.filter(
    (c) => c.question.toLowerCase().includes(q) || c.correction.toLowerCase().includes(q),
  );
}

/** Busca nos neurônios crus (a MESMA regra que a MemoryTab antiga aplicava). */
export function filterNeurons(
  neurons: MemoryNeuronSummary[],
  query: string,
): MemoryNeuronSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return neurons;
  return neurons.filter(
    (n) =>
      n.title.toLowerCase().includes(q) ||
      n.path.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

/** Placar de um nó contestado: "2× útil · 1× beco/correção". */
export function contestedScore(node: ProjectLearningNode): string {
  return `${node.uses}× útil · ${node.neg}× beco/correção`;
}

/** Rótulo PT do veredito do reflect ('useful' | 'dead end' | 'even'). */
export function verdictLabel(verdict: string | null): string {
  if (verdict === 'useful') return 'a recência diz: útil';
  if (verdict === 'dead end') return 'a recência diz: beco sem saída';
  return 'empatado';
}

/** Rótulo PT do outcome de um sinal da proveniência. */
export function outcomeLabel(outcome: string): string {
  if (outcome === 'useful') return 'útil';
  if (outcome === 'dead_end') return 'beco sem saída';
  if (outcome === 'corrected') return 'corrigida';
  return outcome;
}

/** Só a data (YYYY-MM-DD) de um ISO — os sinais não precisam de hora na UI. */
export function signalDay(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}
