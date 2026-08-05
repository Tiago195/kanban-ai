import type { StoryPoints } from './enums';

/**
 * Contratos do ecossistema "Chat de criação de Épicos/Histórias" (backlog-chat).
 *
 * O chat é conversacional: o humano descreve a ideia, a AI conduz uma fase de
 * **descoberta** (perguntas de refinamento), depois **propõe** um backlog
 * (Epic + Stories) enxuto. O humano pode pedir ajustes **cirúrgicos** (a AI muda
 * só o ponto solicitado, via patch versionado) e, ao aprovar, o backend
 * materializa os cards via `CardsService` (invariantes garantidas).
 *
 * Nada aqui cria cards diretamente — a AI só **propõe**; o `/apply` cria.
 */

/** Papel de quem emitiu a mensagem no chat de backlog. */
export type BacklogChatRole = 'ai' | 'user' | 'system';

/**
 * Canal (thread) do chat de backlog. `main` é a conversa geral. Uma thread de
 * story usa a chave `story:<storyId>`. Modelo Slack: mesma sessão do Copilot,
 * transcripts separados por canal. Ver ADR-0023.
 */
export const BACKLOG_MAIN_CHANNEL = 'main';

/** Monta a chave de canal de uma thread de story. */
export function backlogStoryChannel(storyId: string): string {
  return `story:${storyId}`;
}

/** Extrai o storyId de uma chave de canal `story:<id>`, ou null se for `main`. */
export function parseBacklogStoryChannel(channel: string): string | null {
  return channel.startsWith('story:') ? channel.slice('story:'.length) : null;
}

/** Situação do ciclo de vida de uma sessão de chat de backlog. */
export type BacklogChatSessionStatus = 'open' | 'applied' | 'archived';

/**
 * Resumo de uma sessão de chat de backlog, para listar/retomar conversas
 * anteriores de um board (seletor de sessões). Não carrega o transcript — só os
 * metadados necessários para exibir e ordenar na lista.
 */
export interface BacklogChatSessionSummary {
  id: string;
  boardId: string;
  title: string;
  status: BacklogChatSessionStatus;
  /** Versão da proposta corrente, ou null enquanto ainda em descoberta. */
  currentProposalVersion: number | null;
  /** Total de mensagens no transcript (para dar noção de tamanho da conversa). */
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mensagem persistida do transcript do chat de backlog (model
 * `BacklogChatMessage`). Reidratada ao reabrir a sessão (F5-safe).
 */
export interface BacklogChatMessage {
  id: string;
  sessionId: string;
  role: BacklogChatRole;
  /**
   * Canal (thread) do transcript ao qual esta mensagem pertence. `main` é a
   * conversa geral; `story:<storyId>` é a thread focada de uma story (modelo
   * Slack: mesma sessão do Copilot, transcripts separados). Ver ADR-0023.
   */
  channel: string;
  /** `proposal` marca a mensagem que carrega uma proposta de backlog. */
  kind?: 'thought' | 'output' | 'proposal';
  text: string;
  /** Vincula pergunta (role=ai) e resposta (role=user) do mesmo par HITL. */
  questionId?: string;
  /** Opções de resposta rápida (quick replies) da pergunta de refinamento. */
  options?: string[];
  /** Quando `kind=proposal`: snapshot da proposta na versão corrente. */
  proposal?: BacklogProposal;
  ts: number;
}

/** Uma story dentro de uma proposta de backlog. */
export interface BacklogProposalStory {
  /**
   * Identificador estável da story dentro da proposta. Sobrevive a
   * reordenação/patch — é a âncora usada pela thread `story:<id>` do chat.
   * Gerado pelo backend ao persistir a proposta. Ver ADR-0023.
   */
  id: string;
  title: string;
  /** Resumo objetivo (2–5 linhas) do que a story entrega. */
  description?: string;
  /**
   * Contexto de AI da story — **mesmo campo do Card** (`Card.aiSummary`).
   * Resumo/objetivo em linguagem natural que orienta a execução. Ao aplicar
   * (`/apply`) vai direto para `aiSummary` do card. Ver ADR-0024.
   */
  aiSummary?: string;
  /**
   * Notas de AI da story — **mesmo campo do Card** (`Card.aiNotes`).
   * Considerações técnicas, dependências, riscos ou pontos de atenção. NÃO é
   * acceptance/DoR (proibidos no v1 — ADR-0007). Ao aplicar vai para `aiNotes`
   * do card. Ver ADR-0024.
   */
  aiNotes?: string;
  points?: StoryPoints;
  /**
   * Rascunho de tasks (decomposição da story em passos acionáveis). **Opcional
   * e sob demanda** — a proposta não gera tasks por padrão (backlog enxuto);
   * o humano pode pedir "sugira tasks" na thread da story. Ao aprovar (`/apply`)
   * cada task vira um **card `type:task`** filho da story (o MESMO conceito de
   * task do board — não um modelo paralelo), na coluna "To Do". O DoD continua
   * sendo o `DodItem` do card, criado no board após o apply (ADR-0007). Ver
   * ADR-0024.
   */
  tasks?: BacklogProposalTask[];
}

/**
 * Rascunho de uma task dentro de uma story da proposta. **Não é um novo modelo**
 * — é só o rascunho que vira um card `type:task` (já existente) via `/apply`.
 * `id` estável (como o da story) para suportar patch cirúrgico por índice.
 * Task não tem story points (invariante do domínio).
 */
export interface BacklogProposalTask {
  /** Id estável da task dentro da story; gerado/preservado ao persistir. */
  id: string;
  title: string;
}

/**
 * Proposta estruturada de backlog (Epic + Stories) que a AI emite e o humano
 * revisa. É **versionada** — cada refinamento cirúrgico gera uma nova versão
 * (model `BacklogProposalRevision`).
 */
export interface BacklogProposal {
  /** Versão da proposta; incrementa a cada patch aplicado. */
  version: number;
  epic: {
    title: string;
    description?: string;
    points?: StoryPoints;
  };
  stories: BacklogProposalStory[];
  /** 1 linha do porquê desta decomposição (exibida ao expandir detalhes). */
  rationale?: string;
}

/**
 * Operação de patch cirúrgico sobre um `BacklogProposal`, estilo JSON Pointer.
 * A AI emite estas ops (em vez de reescrever a proposta) quando o humano pede
 * mudança num ponto específico — garante que só o solicitado muda.
 *
 * `path` aponta para um campo editável: `/epic/title`, `/epic/description`,
 * `/epic/points`, `/stories/<i>/title`, `/stories/<i>/description`,
 * `/stories/<i>/aiSummary`, `/stories/<i>/aiNotes`, `/stories/<i>/points`,
 * `/stories/<i>/tasks` (array inteiro). `add`/`remove` operam sobre
 * `/stories/<i>` e sobre `/stories/<i>/tasks/<j>` (`add` em
 * `/stories/<i>/tasks/-`).
 */
export interface BacklogPatchOp {
  op: 'replace' | 'add' | 'remove';
  path: string;
  value?: unknown;
}

/** Conjunto de ops de patch com a versão-base sobre a qual se aplicam. */
export interface BacklogProposalPatch {
  baseVersion: number;
  ops: BacklogPatchOp[];
}

/** Resumo de um card criado pelo `/apply` (retorno da materialização). */
export interface BacklogAppliedCard {
  id: string;
  key: string;
  type: 'epic' | 'story' | 'task';
  title: string;
  parentId: string | null;
}

/**
 * Marcadores dos blocos de controle emitidos pela skill no stdout da CLI e
 * consumidos pelo wrapper (`docker/copilot-cli-adapter.mjs`). Reutilizam o
 * mesmo padrão de `<<<KANBAN_QUESTION>>>` do loop engine.
 */
export const BACKLOG_PROPOSAL_MARKERS = {
  open: '<<<KANBAN_BACKLOG>>>',
  close: '<<<END_KANBAN_BACKLOG>>>',
} as const;

export const BACKLOG_PATCH_MARKERS = {
  open: '<<<KANBAN_BACKLOG_PATCH>>>',
  close: '<<<END_KANBAN_BACKLOG_PATCH>>>',
} as const;
