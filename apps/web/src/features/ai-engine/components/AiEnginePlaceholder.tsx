import type { Iteration } from '@kanban-ai/shared';

/** Visão client-side das iterações do loop engine. Placeholder de fundação. */
export function AiEnginePlaceholder({ iterations = [] }: { iterations?: Iteration[] }) {
  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-medium">AI Engine</h2>
      <p className="text-sm text-muted-foreground">
        Visão do loop de iterações dos agents. {iterations.length} iteração(ões) carregada(s).
      </p>
    </section>
  );
}
