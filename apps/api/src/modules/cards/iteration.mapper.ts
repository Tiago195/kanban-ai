import type { ExecState, Iteration, IterationPhase } from '@kanban-ai/shared';

/**
 * Registro cru de uma iteração como persistido pelo Prisma (campos de handoff
 * achatados + `ts` como Date). Modelado localmente para não acoplar ao client
 * gerado do Prisma neste ponto de fronteira.
 */
export interface PrismaIterationRow {
  id: string;
  index: number;
  ts: Date;
  agentId: string | null;
  phase: string;
  detail: string;
  summary: string;
  handoffState: string;
  handoffNextStep: string;
  handoffFiles: string[];
  handoffDodIds: string[];
  dodTouched: string[];
}

/**
 * Converte o registro cru do Prisma (`handoff*` achatado, `ts: Date`) no tipo
 * `Iteration` do contrato compartilhado (`handoff` aninhado, `ts: number` epoch).
 *
 * Ponto único de verdade — deve ser usado em toda leitura (`GET /cards/:id`) e
 * no payload do evento WS `iteration.appended`, garantindo que api e web falem o
 * mesmo formato.
 */
export function mapIteration(row: PrismaIterationRow): Iteration {
  return {
    id: row.id,
    index: row.index,
    ts: row.ts instanceof Date ? row.ts.getTime() : new Date(row.ts).getTime(),
    agentId: row.agentId,
    phase: row.phase as IterationPhase,
    detail: row.detail,
    summary: row.summary,
    dodTouched: row.dodTouched ?? [],
    handoff: {
      state: row.handoffState as ExecState | 'blocked' | 'done',
      nextStep: row.handoffNextStep,
      targets: {
        files: row.handoffFiles ?? [],
        dodIds: row.handoffDodIds ?? [],
      },
    },
  };
}
