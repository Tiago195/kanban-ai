import type { EpicDerivedStatus } from '@kanban-ai/shared';

/** Coluna mínima necessária para derivar status. */
export interface ColumnLike {
  id: string;
  title: string;
}

/** Story mínima necessária para derivar status. */
export interface StoryLike {
  everInProgress: boolean;
  boardColumnId: string | null;
}

/** Resultado da derivação de status do epic. */
export interface DerivedEpicStatus {
  status: EpicDerivedStatus;
  done: number;
  total: number;
}

const norm = (t: string) => t.trim().toLowerCase();

/** A story "passou por" In Progress se está em In Progress, Review ou Done. */
const INPROGRESS_OR_BEYOND = ['in progress', 'review', 'done'];

function isDoneColumn(col: ColumnLike | undefined): boolean {
  return !!col && norm(col.title) === 'done';
}

function reachedInProgress(col: ColumnLike | undefined): boolean {
  return !!col && INPROGRESS_OR_BEYOND.includes(norm(col.title));
}

/**
 * Replica EXATAMENTE `deriveEpicStatus` do artifact (docs/reference/kanban.html).
 *  - sem stories → todo
 *  - todas as stories em coluna Done → done
 *  - alguma story `everInProgress` OU já em In Progress/Review/Done → inprogress
 *  - caso contrário → todo
 *
 * `everInProgress` é pegajoso: uma vez em In Progress, permanece true.
 */
export function deriveEpicStatus(
  stories: StoryLike[],
  columnsById: Map<string, ColumnLike>,
): DerivedEpicStatus {
  const total = stories.length;
  if (total === 0) return { status: 'todo', done: 0, total: 0 };

  const colOf = (s: StoryLike) => (s.boardColumnId ? columnsById.get(s.boardColumnId) : undefined);

  const done = stories.filter((s) => isDoneColumn(colOf(s))).length;
  if (done === total) return { status: 'done', done, total };

  const anyInProgress = stories.some((s) => s.everInProgress || reachedInProgress(colOf(s)));
  if (anyInProgress) return { status: 'inprogress', done, total };

  return { status: 'todo', done, total };
}
