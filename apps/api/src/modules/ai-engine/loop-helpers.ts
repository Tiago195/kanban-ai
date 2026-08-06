import type { ExecState, IterationPhase, StructuredEvidence } from '@kanban-ai/shared';
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

/**
 * Serializa `evidence` (string livre OU `StructuredEvidence`) para a coluna
 * `Iteration.evidence` (String). A forma estruturada vira uma representação
 * legível e estável (checks + arquivos + nota) para persistência/rastreio; a
 * forma livre é retornada como está. `undefined`/vazio → `''`.
 */
export function evidenceToString(
  evidence: string | StructuredEvidence | null | undefined,
): string {
  if (!evidence) return '';
  if (typeof evidence === 'string') return evidence.trim();
  const parts: string[] = [];
  for (const c of evidence.checks ?? []) {
    parts.push(`- [${c.passed ? 'ok' : 'x'}] ${c.name}${c.output ? `: ${c.output}` : ''}`);
  }
  if (evidence.filesChanged && evidence.filesChanged.length > 0) {
    parts.push(`arquivos: ${evidence.filesChanged.join(', ')}`);
  }
  if (evidence.note) parts.push(evidence.note);
  return parts.join('\n');
}

/**
 * Anti-thrash (#3): tokeniza texto para comparação de similaridade. Normaliza
 * (lowercase, remove pontuação, colapsa espaços) e retorna o conjunto de
 * palavras com ≥ 2 chars.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  );
}

/**
 * Similaridade de Jaccard entre dois textos (0..1). Dois textos vazios são
 * considerados idênticos (1). Um vazio e um não-vazio → 0.
 */
export function textSimilarity(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Assinatura de uma iteração para detecção de thrash. */
export interface ThrashSample {
  summary: string;
  nextStep: string;
}

/**
 * Anti-thrash (#3): detecta se a AI está "travada" — iterações recentes com
 * `summary`+`nextStep` quase idênticos. Compara as últimas `window` amostras
 * (as mais recentes ao FINAL do array) par a par; se QUALQUER par consecutivo
 * tiver similaridade ≥ `threshold`, considera thrash. Precisa de ≥ 2 amostras.
 */
export function isThrashing(
  samples: ThrashSample[],
  threshold: number,
  window: number,
): boolean {
  if (!Array.isArray(samples) || samples.length < 2) return false;
  const w = Math.max(2, Math.floor(window) || 2);
  const recent = samples.slice(-w);
  const sig = (s: ThrashSample) => `${s.summary ?? ''} ${s.nextStep ?? ''}`.trim();
  for (let i = 1; i < recent.length; i++) {
    if (textSimilarity(sig(recent[i - 1]), sig(recent[i])) >= threshold) return true;
  }
  return false;
}
