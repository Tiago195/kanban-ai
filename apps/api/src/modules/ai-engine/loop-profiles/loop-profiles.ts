import type { IterationPhase, LoopProfileId, ValidationStrategy } from '@kanban-ai/shared';

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
};

/** Resolve o perfil a usar a partir do loopType da task (fallback __default). */
export function resolveLoopProfile(loopType?: string | null): LoopProfileDef {
  if (loopType && BUILTIN_LOOP_PROFILES[loopType]) return BUILTIN_LOOP_PROFILES[loopType];
  return BUILTIN_LOOP_PROFILES.__default;
}
