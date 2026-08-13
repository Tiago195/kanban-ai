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
export type LoopProfileId = 'feature' | 'bug' | 'refactor' | 'orchestrator' | '__default';

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

/**
 * US-ROB2 — estado de vivacidade PERSISTIDO de uma sessão de agent. Diferente de
 * AgentSessionState (efêmero, in-process), este sobrevive a restart e alimenta a
 * reconciliação durável + o recovery por lease (US-ROB4).
 *
 *  - starting: sessão recém-criada, ainda sem heartbeat consolidado.
 *  - alive:    processando normalmente (heartbeat recente).
 *  - stalled:  sem heartbeat há > TTL (candidato a recovery).
 *  - dead:     encerrada (limpa ou abortada).
 */
export const LivenessState = {
  Starting: 'starting',
  Alive: 'alive',
  Stalled: 'stalled',
  Dead: 'dead',
} as const;
export type LivenessState = (typeof LivenessState)[keyof typeof LivenessState];

/**
 * US-CTX3 (EP-CTX / Paperclip #1) — classificação de VIVACIDADE de UM run
 * (iteração) do loop. Diferente de LivenessState (estado da SESSÃO, durável) e
 * de AgentSessionState (efêmero). Alimenta a decisão de continuação bounded:
 *
 *  - completed:      run fechou a task (done + DOD/diff satisfeitos).
 *  - advanced:       progrediu (diff no worktree OU fechou ≥1 item de DOD).
 *  - plan_only:      só planejou (nextStep/summary, sem diff nem avanço de DOD).
 *  - empty_response: run sem summary e sem diff e sem DOD (praticamente vazio).
 *  - blocked:        terminou bloqueado (blocked-dep / needs_input).
 *  - failed:         falhou na validação/erro do run.
 *  - needs_followup: pediu HITL (aguardando resposta humana).
 *
 * `plan_only` e `empty_response` disparam CONTINUAÇÃO BOUNDED (re-wake alvo em
 * segundos, até `continuationCap`). Os demais seguem o fluxo normal do loop.
 * Ver docs/specs/ep-ctx.md §4.2.
 */
export const RunLivenessState = {
  Completed: 'completed',
  Advanced: 'advanced',
  PlanOnly: 'plan_only',
  EmptyResponse: 'empty_response',
  Blocked: 'blocked',
  Failed: 'failed',
  NeedsFollowup: 'needs_followup',
} as const;
export type RunLivenessState = (typeof RunLivenessState)[keyof typeof RunLivenessState];

/** US-CTX3 — estados que merecem continuação bounded (re-wake alvo). */
export const CONTINUABLE_LIVENESS: readonly RunLivenessState[] = [
  RunLivenessState.PlanOnly,
  RunLivenessState.EmptyResponse,
] as const;

/**
 * US-COLAB3 — estado de um item na wakeup queue durável (Postgres). A fila é só
 * ESTADO persistido: o processamento segue in-process (Orchestrator), SEM Redis
 * (invariante 7 / ADR-0019 / ADR-0032).
 *
 *  - pending: aguardando o processador in-process drenar.
 *  - claimed: reivindicado por uma sessão in-process (em processamento).
 *  - done:    processado com sucesso.
 *  - failed:  falhou (mantido para auditoria/retry).
 *
 * Coalescing forte: no máximo UM item NÃO-terminal (`pending`|`claimed`) por
 * story (garantido por índice único parcial na migration).
 */
export const WAKEUP_STATUS = ['pending', 'claimed', 'done', 'failed'] as const;
export type WakeupStatus = (typeof WAKEUP_STATUS)[number];

/**
 * US-COLAB3 — motivo pelo qual uma story precisa acordar. Persistido junto do
 * item da wakeup queue para auditoria e retomada correta pós-restart.
 *
 *  - story_in_progress: gatilho clássico — story entrou/está em In Progress.
 *  - task_added:        task nova adicionada a story já em progresso (BUG-09).
 *  - hitl_answered:     humano respondeu uma pergunta pendente.
 *  - manual_step:       "Rodar 1 iteração" / stepOnce.
 *  - reconcile:         re-enfileirado no boot a partir do board.
 *  - continuation:      US-CTX3 — run improdutivo (plan_only/empty_response)
 *                       recuperável; re-wake alvo bounded (continuationCap).
 */
export const WAKEUP_REASON = [
  'story_in_progress',
  'task_added',
  'hitl_answered',
  'manual_step',
  'reconcile',
  'blockers_resolved', // US-BLOCK3: todos os blockers (dependsOn) fecharam
  'issue_unblock', // US-BLOCK2: owner=agent notificado para destravar
  'continuation', // US-CTX3: continuação bounded de run improdutivo (EP-CTX)
  'monitor_due', // US-SCHED1: deferred monitor reached its scheduledFor time
] as const;
export type WakeupReason = (typeof WAKEUP_REASON)[number];

/**
 * EP-BLOCK / US-BLOCK1 (ADR-0039) — taxonomia typed de bloqueio. `null` no card
 * = comportamento pré-BLOCK (bloqueio genérico), retrocompatível.
 *
 *  - dependency:  esperando uma dependência (`dependsOn`) fechar. AUTO-RESUMÍVEL,
 *                 sem humano. Volta a "To Do"/`blocked-dep` e re-valida quando o
 *                 blocker fecha. NÃO marca `needsHuman`.
 *  - needs_input: esperando resposta humana (HITL). Marca `needsHuman`.
 *  - capability:  gap de capacidade / falta ferramenta / cap esgotado. Marca
 *                 `needsHuman` (permanente até intervenção).
 *  - transient:   falha passageira (rede, rate-limit). Elegível a retry
 *                 automático; NÃO marca `needsHuman` por si só.
 */
export const BLOCK_KIND = ['dependency', 'needs_input', 'capability', 'transient'] as const;
export type BlockKind = (typeof BLOCK_KIND)[number];

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

/**
 * Estado do lock de edição de um neurônio (unidade de memória versionada).
 * Enum canônico do contrato de memória compartilhada (US-114).
 *
 * - FREE: sem dono; qualquer agent/humano pode adquirir o lock para editar.
 * - EDITING: alguém detém o lease (lock) e está editando o neurônio agora.
 * - REVIEW: edição concluída, aguardando revisão antes de liberar o lock.
 *
 * Fonte: mem_service_design (lock, access) + board seções 22-23.
 *
 * Padrão: const object + type derivado (idem `KEY_PREFIX`), permitindo tanto
 * acesso por membro (`MemoryLockState.EDITING`) quanto o union type derivado.
 */
export const MemoryLockState = {
  FREE: 'FREE',
  EDITING: 'EDITING',
  REVIEW: 'REVIEW',
} as const;
export type MemoryLockState = (typeof MemoryLockState)[keyof typeof MemoryLockState];

/** Todos os valores de `MemoryLockState` (útil para validação/iteração). */
export const MEMORY_LOCK_STATES = Object.values(MemoryLockState);

/**
 * @deprecated Definição provisória da US-113 (Neuron). Use `MemoryLockState`
 * (enum canônico da US-114). Mantido como alias para não quebrar consumidores.
 */
export const NEURON_LOCK_STATES = MEMORY_LOCK_STATES;
/**
 * @deprecated Use `MemoryLockState`. Alias de tipo mantido para compatibilidade
 * com `domain.ts` (campo `Neuron.lockState`) até a migração dos consumidores.
 */
export type NeuronLockState = MemoryLockState;

/**
 * MemoryAccessMode — modo de permissão de um agent sobre a memória viva (colmeia).
 *
 * Modela a assimetria de acesso definida no ADR-0027 (seção de acesso/escopo):
 * - READ_GLOBAL: leitura é GLOBAL — um agent pode ler QUALQUER neurônio da
 *   colmeia, independentemente do módulo, para reaproveitar o conhecimento de
 *   outras áreas.
 * - WRITE_SCOPE: escrita é RESTRITA AO ESCOPO — um agent só pode gravar
 *   (criar/editar) neurônios do `scope`/módulo da sua própria story, evitando
 *   que uma sessão altere memória fora do seu domínio.
 *
 * Fonte: mem_service_design (access) + board seções 22-23.
 *
 * É apenas o CONTRATO do modo; a regra de autorização (checar se um `AgentId`
 * pode escrever em dado `scope`) vive na Camada 2, fora deste pacote.
 *
 * Padrão: const object + type derivado (idem `MemoryLockState`), permitindo
 * tanto acesso por membro (`MemoryAccessMode.WRITE_SCOPE`) quanto o union type.
 */
export const MemoryAccessMode = {
  READ_GLOBAL: 'READ_GLOBAL',
  WRITE_SCOPE: 'WRITE_SCOPE',
} as const;
export type MemoryAccessMode = (typeof MemoryAccessMode)[keyof typeof MemoryAccessMode];

/** Todos os valores de `MemoryAccessMode` (útil para validação/iteração). */
export const MEMORY_ACCESS_MODES = Object.values(MemoryAccessMode);
