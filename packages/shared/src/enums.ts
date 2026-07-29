/**
 * Enums e constantes do domínio do Kanban-AI.
 *
 * Fonte da verdade: docs/reference/kanban.html (spec funcional de referência).
 * NOTA v1: DOR e `acceptance` foram removidos — o único checklist é o DOD.
 */

/** Tipo de card na hierarquia Epic → Story → Task. */
export type CardType = 'epic' | 'story' | 'task';

/** Prefixos de chave por tipo de card (EP-1, US-2, TK-3). */
export const KEY_PREFIX: Record<CardType, string> = {
  epic: 'EP',
  story: 'US',
  task: 'TK',
};

/**
 * Story points permitidos (sequência de Fibonacci usada no board).
 * Aplicável a story/epic; tasks não têm pontos.
 */
export const STORY_POINTS = [1, 2, 3, 5, 8, 13] as const;
export type StoryPoints = (typeof STORY_POINTS)[number];

/**
 * Estado de execução de uma task no loop engine.
 * Espelha EXEC_STATE_META do artifact de referência.
 */
export type ExecState =
  | 'idle'
  | 'analyzing'
  | 'implementing'
  | 'validating'
  | 'blocked-dep'
  | 'done';

/**
 * Fase de uma iteração do loop.
 * Espelha PHASE_META do artifact de referência.
 */
export type IterationPhase = 'reproduce' | 'analysis' | 'implementation' | 'validation';

/** Perfis de loop embutidos; labels sem perfil próprio usam `__default`. */
export type LoopProfileId = 'feature' | 'bug' | 'refactor' | '__default';

/**
 * Estratégia de validação de um loop profile.
 * - flows+regression: valida fluxos afetados + regressão
 * - bug-gone+regression: confirma que o bug sumiu + regressão
 * - regression-only: só regressão (comportamento não muda, ex.: refactor)
 */
export type ValidationStrategy = 'flows+regression' | 'bug-gone+regression' | 'regression-only';

/**
 * Estado de uma sessão de agent no AgentSessionManager (orquestração in-process).
 * O watchdog só age em sessões `dead` ou travadas em `idle`.
 */
export type AgentSessionState = 'running' | 'idle' | 'dead';

/** Modo de parada manual de uma sessão de agent. */
export type StopMode = 'graceful' | 'hard';

/** Colunas do board principal (fluxo de stories). */
export const BOARD_COLUMNS = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'] as const;
export type BoardColumnTitle = (typeof BOARD_COLUMNS)[number];

/** Colunas do mini-kanban de tasks (dentro do modal da story). */
export const TASK_COLUMNS = ['To Do', 'In Progress', 'Review', 'Done'] as const;
export type TaskColumnTitle = (typeof TASK_COLUMNS)[number];

/** Colunas onde é permitido CRIAR tasks (regra de domínio). */
export const TASK_CREATION_COLUMNS: BoardColumnTitle[] = ['Backlog', 'To Do'];
