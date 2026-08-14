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

/**
 * Monta a chave de canal de uma thread focada numa **task** (dentro do chat da
 * story). Segue o mesmo espírito de `story:<id>` (ADR-0023): mesma sessão do
 * Copilot, transcript particionado por canal. `taskId` pode ser o id estável do
 * rascunho de task na proposta (`BacklogProposalTask.id`) ou o id do card
 * `type:task` já materializado. Ver ADR-0026.
 */
export function backlogTaskChannel(taskId: string): string {
  return `task:${taskId}`;
}

/** Extrai o taskId de uma chave de canal `task:<id>`, ou null caso contrário. */
export function parseBacklogTaskChannel(channel: string): string | null {
  return channel.startsWith('task:') ? channel.slice('task:'.length) : null;
}

/**
 * DTO de retorno de "abrir (ou reusar) a sessão de chat de uma story". Ver
 * ADR-0026 e o endpoint `POST /backlog-chat/story/:storyId/session`.
 */
export interface StoryChatSession {
  /** Id da `BacklogChatSession` (reusada ou recém-criada) da story. */
  sessionId: string;
  /** Board ao qual a sessão/story pertence. */
  boardId: string;
  /** Id estável da story dentro da proposta — âncora do canal `story:<id>`. */
  storyId: string;
  /**
   * `true` quando a story veio de um backlog-chat e a sessão original foi
   * **reusada** (mesmo transcript/contexto); `false` quando a story era manual
   * e uma sessão **zerada** foi criada e vinculada. Ver ADR-0026.
   */
  reused: boolean;
  /**
   * Snapshot da proposta de tasks corrente desta story (se já houver), para o
   * front reidratar a lista clicável de tasks sem esperar um novo turno da AI.
   * Ver {@link BacklogTaskProposal} e ADR-0026.
   */
  taskProposal?: BacklogTaskProposal;
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
  kind?: 'thought' | 'output' | 'proposal' | 'task_proposal';
  text: string;
  /** Vincula pergunta (role=ai) e resposta (role=user) do mesmo par HITL. */
  questionId?: string;
  /** Opções de resposta rápida (quick replies) da pergunta de refinamento. */
  options?: string[];
  /** Quando `kind=proposal`: snapshot da proposta na versão corrente. */
  proposal?: BacklogProposal;
  /** Quando `kind=task_proposal`: snapshot da proposta de tasks da story. */
  taskProposal?: BacklogTaskProposal;
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
   * Definition of Done sugerido para a story (3–7 itens objetivos e
   * verificáveis). Cada string vira um `DodItem` do card story ao aplicar
   * (`/apply`), na ordem em que aparecem (position incremental). É o **único**
   * checklist do v1 — NÃO é DoR nem acceptance (proibidos — ADR-0007).
   * Opcional para manter compatibilidade retroativa com propostas antigas.
   */
  dod?: string[];
  /**
   * Fluxos/áreas do código que a story afeta (usados na validação final). Cada
   * item vira um `AffectedFlow` do card story ao aplicar (`/apply`). Opcional
   * para manter compatibilidade retroativa com propostas antigas.
   */
  affectedFlows?: { name: string; files: string[]; note?: string }[];
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
  /** Descrição da task; preservada ao materializar/aplicar (vira o corpo do card). */
  description?: string;
}

/**
 * Um item de uma **proposta de tasks do chat da story** (ADR-0026). É o mesmo
 * conceito de task do board (vira um card `type:task` ao materializar), mas aqui
 * carrega um pouco mais de contexto que o humano pode refinar numa thread
 * dedicada (`task:<id>`) antes de materializar. Task não tem story points nem
 * DoD (invariantes do domínio — ADR-0007).
 */
export interface BacklogTaskProposalItem {
  /**
   * Id estável do item dentro da proposta de tasks; gerado/preservado pelo
   * backend ao persistir. É a **âncora do canal `task:<id>`** — sobrevive a
   * reordenação/patch para a thread de refinamento continuar apontando à mesma
   * task. Ver ADR-0026.
   */
  id: string;
  /** Título curto e acionável da task (o que vira o título do card). */
  title: string;
  /** Detalhamento opcional (o que fazer / critérios) refinado na thread. */
  description?: string;
}

/**
 * Proposta estruturada de **tasks** emitida pelo PO dentro do **chat da story**
 * (ADR-0026). Diferente de {@link BacklogProposal} (Epic + Stories), esta é
 * escopada a UMA story: uma lista de tasks acionáveis que o humano revisa, refina
 * task-a-task (thread `task:<id>`) e materializa como cards `type:task` em To Do.
 *
 * NÃO é persistida como revisão versionada em tabela própria: o snapshot corrente
 * vive numa `BacklogChatMessage` (`kind:'task_proposal'`, JSON em `proposal`) —
 * sem migração. É **versionada** logicamente pelo campo `version` (incrementa a
 * cada refinamento cirúrgico).
 */
export interface BacklogTaskProposal {
  /** Versão da proposta de tasks; incrementa a cada patch aplicado. */
  version: number;
  /** Lista de tasks propostas (ordem = ordem de materialização). */
  tasks: BacklogTaskProposalItem[];
  /** 1 linha do porquê desta decomposição (opcional). */
  rationale?: string;
}

/**
 * Patch cirúrgico sobre uma {@link BacklogTaskProposal}. A AI emite estas ops
 * (em vez de reemitir a lista inteira) quando o humano refina UMA task numa
 * thread `task:<id>`. `path` aponta para: `/tasks/<i>/title`,
 * `/tasks/<i>/description`, `/rationale`; `add` em `/tasks/-` e `remove` em
 * `/tasks/<i>`.
 */
export interface BacklogTaskProposalPatch {
  baseVersion: number;
  ops: BacklogPatchOp[];
}

/**
 * Payload de uma task ao **materializar** (criar no board) tasks rascunhadas no
 * chat da story (ADR-0026). Carrega `title` e a `description` refinada na thread
 * `task:<id>` — a descrição é preservada no card `type:task` criado. Ver o bug
 * "descricoes das tasks propostas no chat sao descartadas ao materializar".
 */
export interface MaterializeStoryTaskInput {
  /** Título curto e acionável (vira o título do card). */
  title: string;
  /** Detalhamento opcional (vira a `description` do card). */
  description?: string;
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
    /**
     * Contexto de AI do épico — **mesmo campo do Card** (`Card.aiSummary`).
     * Resumo/objetivo do épico em linguagem natural. Ao aplicar (`/apply`) vai
     * direto para `aiSummary` do card épico. Opcional (retrocompatível). Ver
     * ADR-0024.
     */
    aiSummary?: string;
    /**
     * Notas de AI do épico — **mesmo campo do Card** (`Card.aiNotes`).
     * Contexto/escopo técnico do épico (dependências, restrições, pontos de
     * atenção). NÃO é acceptance/DoR (proibidos no v1 — ADR-0007). Ao aplicar
     * vai para `aiNotes` do card épico — a UI do painel do épico já expõe este
     * campo ("Notas para a AI"). Opcional (retrocompatível). Ver ADR-0024.
     */
    aiNotes?: string;
    /**
     * Caminho absoluto do repositório-alvo (aiProject) que o agente PO
     * inspecionou via shell durante a descoberta. Persistido no card épico ao
     * aplicar (`/apply`); as stories filhas herdam este valor no loop engine
     * (fallback epic→story). Opcional para compatibilidade com propostas
     * antigas. Ver finding imp-aiproject-missing.
     */
    aiProject?: string;
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
 * `/epic/points`, `/epic/aiSummary`, `/epic/aiNotes`, `/stories/<i>/title`, `/stories/<i>/description`,
 * `/stories/<i>/aiSummary`, `/stories/<i>/aiNotes`, `/stories/<i>/points`,
 * `/stories/<i>/dod`, `/stories/<i>/affectedFlows`, `/stories/<i>/tasks`
 * (arrays inteiros). `add`/`remove` operam sobre `/stories/<i>` e sobre
 * `/stories/<i>/tasks/<j>` (`add` em `/stories/<i>/tasks/-`).
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

/**
 * Marcadores do bloco de **proposta de tasks** do chat da story (ADR-0026). O PO
 * emite a lista estruturada de tasks (em vez de texto puro) para o front renderizar
 * cada task como um item clicável com thread própria de refinamento.
 */
export const BACKLOG_TASKS_MARKERS = {
  open: '<<<KANBAN_TASKS>>>',
  close: '<<<END_KANBAN_TASKS>>>',
} as const;

/** Marcadores do patch cirúrgico de uma proposta de tasks (thread `task:<id>`). */
export const BACKLOG_TASKS_PATCH_MARKERS = {
  open: '<<<KANBAN_TASKS_PATCH>>>',
  close: '<<<END_KANBAN_TASKS_PATCH>>>',
} as const;

/**
 * US-COLAB4 — uma diretiva de delegação extraída de uma mensagem do chat.
 *
 * Escrever `@<handle> <texto>` numa mensagem do backlog-chat delega trabalho a
 * um agent: cria uma task (via `CardsService.create`, invariantes garantidos) na
 * story da sessão e a atribui ao assignee/perfil mencionado. Ver ADR-0033 e a
 * seção US-COLAB4 de `docs/specs/ep-colab.md`.
 */
export interface MentionDirective {
  /** Handle mencionado, sem o '@' (ex.: 'backend', 'orchestrator'). */
  handle: string;
  /**
   * Título da task derivado do texto após a menção (até o fim da linha ou
   * próxima menção). Pode ser vazio se a menção estiver sozinha.
   */
  taskTitle: string;
}

/** Regex canônica de menção: '@' seguido de [A-Za-z0-9_-]+ (case-insensitive). */
export const MENTION_PATTERN = /@([A-Za-z0-9_-]+)/g;

/**
 * Extrai as diretivas de menção de um texto de chat. Retrocompatível: texto sem
 * '@' retorna `[]`. Usada pelo backlog-chat para delegar tasks a agents.
 *
 * O título de cada diretiva é o trecho entre a menção e a próxima menção (ou o
 * fim do texto), com espaços normalizados. Função **pura** (sem I/O), consumível
 * tanto pela api (delegação) quanto pela web (realce).
 */
export function parseMentions(text: string): MentionDirective[] {
  const out: MentionDirective[] = [];
  if (!text) return out;
  const matches = [...text.matchAll(MENTION_PATTERN)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const handle = m[1];
    const start = (m.index ?? 0) + m[0].length;
    const end = matches[i + 1]?.index ?? text.length;
    const taskTitle = text.slice(start, end).trim().replace(/\s+/g, ' ');
    out.push({ handle, taskTitle });
  }
  return out;
}
