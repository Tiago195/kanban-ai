import type { ExecState, IterationPhase } from '@kanban-ai/shared';
import type { LoopProfileDef } from './loop-profiles/loop-profiles';

/**
 * Helpers puros do loop engine — portados de docs/reference/kanban.html
 * (linhas ~855–991). Sem efeitos colaterais: recebem dados já carregados do
 * Postgres e decidem seleção de task, fase e estado. Testáveis isoladamente.
 */

/** ExecState do domínio (shared) usa `blocked-dep`; o enum Prisma usa `blocked_dep`. */
export type PrismaExecState =
  | 'idle'
  | 'analyzing'
  | 'implementing'
  | 'validating'
  | 'blocked_dep'
  | 'done';

/** Converte ExecState do shared (hífen) para o enum do Prisma (underscore). */
export function toPrismaExecState(state: ExecState): PrismaExecState {
  return state === 'blocked-dep' ? 'blocked_dep' : state;
}

/** Converte o enum do Prisma (underscore) para o ExecState do shared (hífen). */
export function fromPrismaExecState(state: string | null | undefined): ExecState {
  return state === 'blocked_dep' ? 'blocked-dep' : ((state ?? 'idle') as ExecState);
}

/** Forma mínima de uma task carregada para o loop. */
export interface LoopTask {
  id: string;
  type: string;
  execState: ExecState;
  createdAt: number;
  /** ids das tasks das quais esta depende. */
  dependsOn: string[];
  /** iterações já persistidas (só as fases importam para o motor). */
  phases: IterationPhase[];
  /** DOD: só o `done` importa para o gate. */
  dodDone: boolean[];
  /** Task escalada para humano: fica fora do conjunto executável até ser resolvida. */
  needsHuman: boolean;
}

/** Todas as tasks da story estão concluídas? */
export function allTasksDone(tasks: LoopTask[]): boolean {
  return tasks.every((t) => t.execState === 'done');
}

/** DOD completo? (precisa ter ao menos 1 item e todos marcados) — artifact `dodAllDone`. */
export function dodAllDone(task: LoopTask): boolean {
  return task.dodDone.length > 0 && task.dodDone.every(Boolean);
}

/** Dependências ainda pendentes (não `done`) — artifact `taskDepsPending`. */
export function pendingDeps(task: LoopTask, byId: Map<string, LoopTask>): LoopTask[] {
  return task.dependsOn
    .map((id) => byId.get(id))
    .filter((d): d is LoopTask => !!d && d.execState !== 'done');
}

/** Task pronta para rodar: não concluída, sem deps pendentes e não escalada a humano — artifact `taskReady`. */
export function taskReady(task: LoopTask, byId: Map<string, LoopTask>): boolean {
  return (
    task.type === 'task' &&
    task.execState !== 'done' &&
    !task.needsHuman &&
    pendingDeps(task, byId).length === 0
  );
}

/**
 * Próxima task a rodar numa story: 1ª "pronta" em ordem estável de criação
 * (artifact `pickNextTask`).
 */
export function pickNextTask(tasks: LoopTask[], byId: Map<string, LoopTask>): LoopTask | null {
  return (
    [...tasks]
      .sort((a, b) => a.createdAt - b.createdAt)
      .find((t) => t.execState !== 'done' && taskReady(t, byId)) ?? null
  );
}

/** Há alguma task ainda não concluída? — artifact `storyHasPendingTasks`. */
export function storyHasPendingTasks(tasks: LoopTask[]): boolean {
  return tasks.some((t) => t.execState !== 'done');
}

/**
 * Decide a fase da próxima iteração a partir do estado + perfil — artifact
 * `nextPhaseFor` (linhas ~978–991).
 */
export function nextPhaseFor(task: LoopTask, profile: LoopProfileDef): IterationPhase {
  if (task.phases.length === 0) return profile.phases[0];
  if (!dodAllDone(task)) {
    const hasAnalysis = task.phases.includes('analysis');
    const hasReproduce = task.phases.includes('reproduce');
    if (profile.phases[0] === 'reproduce' && !hasReproduce) return 'reproduce';
    if (!hasAnalysis) return 'analysis';
    return 'implementation';
  }
  return 'validation';
}

/**
 * ExecState resultante de uma iteração normal (não-validation) — espelha a
 * lógica do artifact em `runIteration` (linhas ~1043–1046).
 */
export function execStateAfterPhase(phase: IterationPhase): ExecState {
  if (phase === 'reproduce') return 'analyzing';
  if (phase === 'analysis') return 'analyzing';
  return 'implementing';
}
