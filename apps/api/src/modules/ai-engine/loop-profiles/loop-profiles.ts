import type { IterationPhase, LoopProfileId, ValidationStrategy } from '@kanban-ai/shared';

/**
 * Capacidade de ferramentas de uma iteração do loop (US-COLAB2 / ADR-0031).
 * - `full` (default/ausente): pode editar arquivos do repo-alvo (perfis
 *   codadores existentes — feature/bug/refactor/__default).
 * - `board-only`: o agent SÓ pode criar/atribuir/linkar cards (via MCP) e
 *   NUNCA edita arquivos. O `buildPrompt` troca a seção de escopo conforme
 *   este campo, e o gate de `git diff` vazio é neutralizado.
 */
export type LoopToolset = 'full' | 'board-only';

/**
 * Definição de um loop profile — o comportamento do agent varia por tipo de label.
 * Fonte: BUILTIN_LOOP_PROFILES em docs/reference/kanban.html.
 */
export interface LoopProfileDef {
  id: LoopProfileId | string;
  name: string;
  builtin: boolean;
  description: string;
  phases: IterationPhase[];
  validation: ValidationStrategy;
  firstStep: string;
  /**
   * US-COLAB2 — capacidade de ferramentas desta iteração. `full` (default/ausente)
   * = pode editar arquivos do repo-alvo. `board-only` = o agent SÓ pode
   * criar/atribuir/linkar cards e NUNCA editar arquivos.
   */
  toolset?: LoopToolset;
}

/** Perfis embutidos (feature | bug | refactor | __default). */
export const BUILTIN_LOOP_PROFILES: Record<string, LoopProfileDef> = {
  feature: {
    id: 'feature',
    name: 'Feature',
    builtin: true,
    description: 'Análise → implementação → validação de fluxos novos + regressão.',
    phases: ['analysis', 'implementation', 'validation'],
    validation: 'flows+regression',
    firstStep: 'Entender o quê, onde mexer e efeitos colaterais.',
  },
  bug: {
    id: 'bug',
    name: 'Bug',
    builtin: true,
    description: 'Reproduzir a causa raiz → corrigir → validar que o bug sumiu + regressão.',
    phases: ['reproduce', 'analysis', 'implementation', 'validation'],
    validation: 'bug-gone+regression',
    firstStep: 'Reproduzir o bug e isolar a causa raiz antes de corrigir.',
  },
  refactor: {
    id: 'refactor',
    name: 'Refactor',
    builtin: true,
    description: 'Análise → execução → validação apenas de regressão (comportamento não muda).',
    phases: ['analysis', 'implementation', 'validation'],
    validation: 'regression-only',
    firstStep: 'Mapear o que será refatorado sem alterar comportamento observável.',
  },
  __default: {
    id: '__default',
    name: 'Genérico',
    builtin: true,
    description: 'Loop padrão para labels sem perfil próprio.',
    phases: ['analysis', 'implementation', 'validation'],
    validation: 'flows+regression',
    firstStep: 'Entender a tarefa, onde mexer e os efeitos colaterais.',
  },
  orchestrator: {
    id: 'orchestrator',
    name: 'Orquestrador (board manager)',
    builtin: true,
    description:
      'Gerente de board: quebra escopo em stories/tasks, atribui aos agents ' +
      'certos e linka dependências. NUNCA edita arquivos do repo-alvo.',
    // Sem fase de implementação de CÓDIGO: analisa o board e decide, planeja e
    // valida a organização. A última fase é 'validation' (invariante do
    // normalizador de perfis — loop-profiles.service.ts).
    phases: ['analysis', 'validation'],
    validation: 'regression-only',
    firstStep:
      'Ler o board (épicos/stories/tasks), identificar lacunas de decomposição ' +
      'e planejar quais cards criar/atribuir/linkar — sem tocar em arquivos.',
    toolset: 'board-only',
  },
};

/** Resolve o perfil a usar a partir do loopType da task (fallback __default). */
export function resolveLoopProfile(loopType?: string | null): LoopProfileDef {
  if (loopType && BUILTIN_LOOP_PROFILES[loopType]) return BUILTIN_LOOP_PROFILES[loopType];
  return BUILTIN_LOOP_PROFILES.__default;
}
