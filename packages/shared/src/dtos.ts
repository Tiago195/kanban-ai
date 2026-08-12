/**
 * DTOs de mutação trafegados de web → api. São o contrato de request; os schemas
 * Zod do backend (apps/api) devem validar exatamente estes formatos.
 *
 * Fonte da verdade dos formatos: schemas Zod em apps/api/src/modules/cards.
 */

import type { CardType, StoryPoints } from './enums';
import type { AgentId, Neuron, Owner } from './domain';

/** Payload para criar um card (POST /cards). */
export interface CreateCardDto {
  boardId: string;
  type: CardType;
  title: string;
  description?: string;
  parentId?: string | null;
  /** Coluna do board (story/epic) — obrigatória p/ story/epic. */
  columnId?: string;
  /** Coluna do mini-kanban (task) — obrigatória p/ task. */
  taskColumnId?: string;
  points?: StoryPoints | null;
  /** Story: caminho absoluto do repositório-alvo (aiProject) do loop engine. */
  aiProject?: string;
  /** Story: resumo de contexto de AI. */
  aiSummary?: string;
  /** Story: notas de AI. */
  aiNotes?: string;
  /** Loop profile do card (validado contra profiles builtin/custom). */
  loopType?: string;
}

/** Payload para mover um card entre colunas (PATCH /cards/:id/move). */
export interface MoveCardDto {
  /** Coluna de destino (board ou mini-kanban). */
  columnId: string;
  /** Posição desejada na coluna de destino (0-based). Se ausente, vai ao fim. */
  position?: number;
}

/** Payload para editar campos de um card (PATCH /cards/:id). */
export interface UpdateCardDto {
  title?: string;
  description?: string;
  points?: StoryPoints | null;
  blocked?: boolean;
  /** Story: contexto de AI. */
  aiSummary?: string;
  aiProject?: string;
  aiNotes?: string;
  /** Modelo de AI deste card (null = herdar do pai/board). */
  model?: string | null;
}

/** Criar item de DOD (POST /cards/:id/dod). */
export interface CreateDodItemDto {
  text: string;
}

/** Editar item de DOD (PATCH /dod/:id). */
export interface UpdateDodItemDto {
  text?: string;
  done?: boolean;
}

/** Anexar label a um card (POST /cards/:id/labels). */
export interface AttachLabelDto {
  labelId: string;
}

/** Anexar assignee a um card (POST /cards/:id/assignees). */
export interface AttachAssigneeDto {
  assigneeId: string;
}

/** Criar affectedFlow numa story (POST /cards/:id/flows). */
export interface CreateFlowDto {
  name: string;
  files?: string[];
  note?: string;
}

/**
 * Leitura de um neurônio da memória viva (ver ADR-0027). A leitura é sempre
 * GLOBAL e livre: não passa por lock nem exige `owner`. Serve tanto para o
 * agent obter o `baseCommit` de referência antes de propor uma escrita quanto
 * para inspeção pela UI/MCP.
 */
export interface ReadNeuronRequest {
  /**
   * Identidade LÓGICA do neurônio a ler (o `.md` versionado — ver `Neuron.path`).
   * É a chave fina da leitura.
   */
  path: string;
  /**
   * SHA do commit a ler. Opcional: quando ausente, lê o `headCommit` atual
   * (HEAD) do path; quando presente, lê o neurônio naquela versão histórica
   * específica da Camada 1.
   */
  commit?: string;
}

/** Resposta de {@link ReadNeuronRequest}: a projeção type-safe do neurônio lido. */
export interface ReadNeuronResponse {
  neuron: Neuron;
}

/**
 * Escrita otimista de um neurônio da memória viva (ver board §22-24 e ADR-0027).
 * A escrita é compare-and-swap: o `baseCommit` é OBRIGATÓRIO e é o que habilita a
 * proteção contra sobrescrita cega. O serviço compara o `baseCommit` (o
 * `headCommit` que o agent LEU antes de propor a mutação) com o `headCommit`
 * ATUAL do `path`; se forem iguais o write procede, se divergiram o serviço
 * recusa com 409 (o head andou para frente enquanto o agent editava).
 */
export interface WriteNeuronRequest {
  /**
   * Identidade LÓGICA do neurônio a escrever (o `.md` versionado — ver
   * `Neuron.path`). É a chave fina da escrita.
   */
  path: string;
  /**
   * Novo conteúdo textual (markdown) a persistir como o corpo do neurônio. Vira
   * o `content` do commit resultante na Camada 1.
   */
  content: string;
  /**
   * SHA do commit HEAD que o agent LEU antes de propor esta escrita — a âncora do
   * compare-and-swap. OBRIGATÓRIO: nunca se sobrescreve cego. Se este `baseCommit`
   * diverge do `headCommit` atual do `path`, o serviço responde 409 em vez de
   * gravar (ver {@link WriteNeuronConflict}).
   */
  baseCommit: string;
}

/**
 * Resposta de {@link WriteNeuronRequest} em caso de sucesso: o novo `headCommit`
 * gerado pela escrita. Vira o próximo `baseCommit` de referência para a AI
 * encadear a iteração seguinte.
 */
export interface WriteNeuronResponse {
  /** SHA do commit HEAD resultante da escrita aceita na Camada 1. */
  headCommit: string;
}

/**
 * Código de erro estruturado usado quando um move é recusado por faltarem
 * campos obrigatórios (ex.: mover story→In Progress sem `aiProject`). O backend
 * inclui este código no corpo do erro para o front saber exatamente qual campo
 * exigir do usuário (sem parsear a mensagem textual).
 */
export const MISSING_REQUIRED_FIELDS = 'MISSING_REQUIRED_FIELDS' as const;

/** Campos que o gate de move pode exigir antes de permitir a transição. */
export type RequiredCardField = 'aiProject';

/**
 * Corpo de erro (400) emitido pelo gate de move quando faltam campos
 * obrigatórios para a transição pretendida.
 */
export interface MissingRequiredFieldsError {
  code: typeof MISSING_REQUIRED_FIELDS;
  /** Campos ausentes que precisam ser preenchidos antes de refazer o move. */
  fields: RequiredCardField[];
  /** Mensagem legível (fallback caso o front não trate o código). */
  message: string;
}

/**
 * Código de erro estruturado do compare-and-swap: o `baseCommit` enviado no
 * {@link WriteNeuronRequest} está _stale_ — o `headCommit` do `path` divergiu
 * desde que o agent leu. O backend inclui este código no corpo do 409 para o
 * consumidor (AI/MCP) reagir sem parsear a mensagem textual.
 */
export const STALE_BASE_COMMIT = 'STALE_BASE_COMMIT' as const;

/**
 * Corpo de conflito (HTTP 409) devolvido por {@link WriteNeuronRequest} quando o
 * compare-and-swap falha: o `headCommit` ATUAL do `path` divergiu do `baseCommit`
 * que o agent enviou (outro holder fechou uma mutação no meio do trabalho — ver
 * board §22-24 e ADR-0027 §"`409` anti-stale"). O serviço NUNCA sobrescreve cego:
 * em vez de gravar, devolve o `headCommit` novo + o `diff` para a AI reconciliar.
 *
 * O consumidor reage com o ciclo **re-ler → rebase → retry**: re-lê o `path` no
 * novo `headCommit` (obtendo um `baseCommit` atualizado), rebaseia seu ramo
 * efêmero sobre ele usando o `diff`, e refaz o {@link WriteNeuronRequest} com o
 * `baseCommit` novo. Repete até o CAS suceder. É um contrato de erro reutilizável:
 * qualquer superfície de escrita otimista (api/web/mcp) discrimina pelo `code`.
 *
 * Distinto do evento `memory.conflict` (conflito semântico no mesmo trecho, que
 * leva o neurônio a `REVIEW`): este 409 é o anti-stale de `baseCommit` divergente.
 */
export interface WriteNeuronConflict {
  /** Discriminante estável do conflito de escrita. */
  code: typeof STALE_BASE_COMMIT;
  /**
   * Identidade LÓGICA do neurônio cuja escrita foi recusada (ver `Neuron.path`).
   */
  path: string;
  /**
   * SHA do commit HEAD ATUAL do `path` no momento da recusa — o estado mais novo
   * que a AI deve re-ler para obter o próximo `baseCommit`.
   */
  headCommit: string;
  /**
   * O `baseCommit` _stale_ que o agent enviou no {@link WriteNeuronRequest} e que
   * não bate mais com o `headCommit` atual. Ecoado para depuração/telemetria.
   */
  baseCommit: string;
  /**
   * Diff textual (unified) entre o `baseCommit` stale e o `headCommit` atual do
   * `path` — o que mudou enquanto a AI editava. Insumo para o rebase/reconciliação
   * antes do retry. Nunca sobrescrever cego: usar o diff para reaplicar a mutação.
   */
  diff: string;
  /** Mensagem legível (fallback caso o consumidor não trate o `code`). */
  message: string;
}

/**
 * Um dos dois lados de um {@link MemoryConflict} — o "ours"/"theirs" do merge
 * 3-way que parou (ver ADR-0027 §"Resolução de conflito semântico"). Cada lado é
 * um PONTEIRO (ref git + projeção do texto) sobre o qual o árbitro decide, não um
 * novo estado de verdade: enquanto o `REVIEW` não fecha, quem serve leitura é o
 * `HEAD` estável, não estes lados.
 */
export interface MemoryConflictSide {
  /**
   * Referência git deste lado da disputa. Para o lado `ours` é o `headCommit`
   * ATUAL do path (o que está estável no git da memória); para o lado `theirs` é
   * a ponta do ramo efêmero do agent (`mem/ai/<sessao>/<path>`), a proposta que
   * parou no merge 3-way. É a âncora que o árbitro usa junto do `baseCommit`.
   */
  ref: string;
  /**
   * Projeção (cache) do conteúdo markdown deste lado no `ref` — o texto que o
   * árbitro compara. A fonte da verdade continua sendo o git da Camada 1: como
   * todo evento da Camada 2, este payload carrega referências/ponteiros e o
   * conteúdo é uma projeção reindexável, não a verdade canônica.
   */
  content: string;
}

/**
 * MemoryConflict — payload que descreve um **conflito semântico** de um neurônio:
 * **duas verdades no mesmo trecho** que o merge 3-way não resolve, levando o
 * neurônio de `EDITING` a `REVIEW` para arbitragem (ver ADR-0027 §"Resolução de
 * conflito semântico" e board §22-24). É o dado que o evento `memory.conflict`
 * transporta para que um **árbitro** (agent revisor ou humano) decida sem
 * re-derivar o contexto. Só o CONTRATO — a lógica de arbitragem vive fora deste
 * pacote.
 *
 * Distingue-se do {@link WriteNeuronConflict}: aquele é o **409 anti-stale de
 * _timing_** (o `baseCommit` ficou para trás do `headCommit` e o CAS recusa a
 * escrita, mantendo `EDITING`); este é uma **disputa de conteúdo** — o CAS
 * SUCEDEU, mas as duas mudanças colidem no mesmo trecho e o neurônio vai a
 * `REVIEW`. Ambos reusam a mesma âncora (`path` + `baseCommit`), mas resolvem
 * problemas diferentes.
 */
export interface MemoryConflict {
  /**
   * Identidade LÓGICA do neurônio em disputa (o `.md` versionado — ver
   * `Neuron.path`). É a CHAVE fina que identifica QUAL neurônio parou em `REVIEW`.
   */
  path: string;
  /**
   * SHA do **ancestral comum** sobre o qual os dois lados foram calculados — o
   * `headCommit` que o holder LEU no `acquire` (a `base` do merge 3-way). É a
   * ÂNCORA que o árbitro usa para comparar `base`/`ours`/`theirs` e enxergar
   * exatamente o conflito de 3 vias. Mesma convenção do `baseCommit` de
   * {@link WriteNeuronRequest}/{@link WriteNeuronConflict}.
   */
  baseCommit: string;
  /**
   * Lado A da disputa ("ours"): o `HEAD` ATUAL do path — a verdade que está
   * estável no git da memória e que continua servindo leitura enquanto o `REVIEW`
   * não fecha.
   */
  ours: MemoryConflictSide;
  /**
   * Lado B da disputa ("theirs"): a proposta do agent que parou no merge — a
   * ponta do ramo efêmero `mem/ai/<sessao>/<path>`. É a mutação que afirma a
   * segunda verdade no mesmo trecho.
   */
  theirs: MemoryConflictSide;
  /**
   * Quem propôs a mutação em disputa (`ai:<sessao>` ou `human:<user>`; ver
   * `Owner`). Serve para atribuição e para notificar o autor quando a arbitragem
   * fechar. Reusa o mesmo tipo de identidade do holder do lock (US-114).
   */
  holder: Owner;
}

/**
 * Aquisição de lock de edição de um neurônio da memória viva (ver ADR-0027
 * §"Locks de edição" e board §22-23). O `acquire` é a transição `FREE → EDITING`:
 * marca PRESENÇA/AVISO advisory ("estou editando isto agora") — NÃO é um portão
 * de escrita. O que protege contra _lost-update_ é o compare-and-swap do write
 * (ver {@link WriteNeuronRequest}), não este lock: dois holders só serão
 * arbitrados no `write`/merge, e a única garantia do lock é coordenação social.
 *
 * O acquire devolve o `baseCommit` (o `headCommit` ATUAL do path no instante da
 * aquisição — ver {@link AcquireLockResponse}), que o holder guarda e reenvia no
 * write como âncora do compare-and-swap.
 */
export interface AcquireLockRequest {
  /**
   * Identidade LÓGICA do neurônio a travar (o `.md` versionado — ver
   * `Neuron.path`). É a CHAVE fina do lock e o nome do ramo efêmero de escrita
   * (`mem/ai/<sessao>/<path>`).
   */
  path: string;
  /**
   * Identidade estável de quem adquire o lock (vira o `holder`/`owner` do lease;
   * ver `AgentId`/`Owner`). Opcional: quando ausente, a Camada 2 deriva o holder
   * da sessão+story corrente. Só o CONTRATO — a derivação/autorização vivem fora
   * deste pacote.
   */
  agentId?: AgentId;
}

/**
 * Resposta de {@link AcquireLockRequest}: confirma a aquisição do lease advisory
 * e devolve os dados que o holder precisa para editar e para renovar/soltar o
 * lock (ver ADR-0027 §"Lease com TTL + heartbeat").
 */
export interface AcquireLockResponse {
  /**
   * SHA do commit HEAD do `path` NO MOMENTO da aquisição — o `baseCommit` que o
   * holder deve guardar e reenviar no {@link WriteNeuronRequest} como âncora do
   * compare-and-swap. Se o `headCommit` do path andar para frente enquanto o
   * holder edita, o write responde 409 anti-stale (ver {@link WriteNeuronConflict}).
   */
  baseCommit: string;
  /**
   * Identificador do lease concedido. O holder o usa para renovar o lock via
   * heartbeat e para o release explícito ao fechar a edição.
   */
  leaseId: string;
  /**
   * Epoch (ms) em que o lease expira se não for renovado por heartbeat. Passado
   * esse instante sem renovação, a Camada 2 faz auto-release (`EDITING → FREE`),
   * evitando estado preso quando a sessão holder morre.
   */
  expiresAt: number;
}

/**
 * Liberação explícita do lock de edição de um neurônio (transição
 * `EDITING → REVIEW/FREE` — ver ADR-0027 §"Locks de edição" e board §22-23). O
 * `release` é o **gatilho do merge**: ao soltar o lock, a Camada 2 promove o ramo
 * efêmero de escrita (`mem/ai/<sessao>/<path>`) e integra a edição na fonte da
 * verdade (git da Camada 1). Diferente do auto-release por expiração de lease
 * (sessão morta), este é o encerramento intencional da edição pelo holder. Só o
 * CONTRATO — o merge/promoção e a autorização vivem fora deste pacote.
 */
export interface ReleaseLockRequest {
  /**
   * Identidade LÓGICA do neurônio a liberar (o `.md` versionado — ver
   * `Neuron.path`). Mesma CHAVE fina usada no {@link AcquireLockRequest}.
   */
  path: string;
  /**
   * Identidade estável de quem solta o lock (deve ser o `holder`/`owner` do
   * lease; ver `AgentId`/`Owner`). Opcional: quando ausente, a Camada 2 deriva o
   * holder da sessão+story corrente. Só o CONTRATO — a verificação de que quem
   * solta é o holder vive fora deste pacote.
   */
  agentId?: AgentId;
}

/**
 * Renovação do lease de um lock de edição ativo (ver ADR-0027 §"Lease com TTL +
 * heartbeat" e board §22-23). Enquanto o holder trabalha num neurônio, ele envia
 * `heartbeat` periodicamente para empurrar o `expiresAt` (ver
 * {@link AcquireLockResponse}) para frente e evitar o **auto-release** que a
 * Camada 2 faz quando o lease vence (`EDITING → FREE`). Ou seja: o heartbeat
 * distingue uma **sessão viva** (que continua editando) de uma **sessão morta**
 * (que travou o neurônio e sumiu). NÃO é gatilho de merge — só sinaliza presença
 * (para isso, ver {@link ReleaseLockRequest}). Só o CONTRATO — a renovação do TTL
 * e o cálculo do novo `expiresAt` vivem fora deste pacote.
 */
export interface HeartbeatRequest {
  /**
   * Identidade LÓGICA do neurônio cujo lease deve ser renovado (o `.md`
   * versionado — ver `Neuron.path`). Mesma CHAVE fina do {@link AcquireLockRequest}.
   */
  path: string;
  /**
   * Identidade estável de quem renova o lease (deve ser o `holder`/`owner`
   * corrente; ver `AgentId`/`Owner`). Opcional: quando ausente, a Camada 2 deriva
   * o holder da sessão+story corrente. Só o CONTRATO — a checagem de que quem
   * renova é o holder vive fora deste pacote.
   */
  agentId?: AgentId;
}

/**
 * Fecha um `REVIEW` arbitrando o texto final de um neurônio (transição
 * `REVIEW → FREE` — ver ADR-0027 §"Resolução de conflito semântico" e board §24).
 * É a chamada `memory.resolve`: o **árbitro** (agent revisor ou humano — ver
 * {@link MemoryReviewItem}) decide o desfecho de uma disputa descrita por um
 * {@link MemoryConflict}. Modela os **dois desfechos** do ADR: aceitar a mutação
 * arbitrada (com o texto final) ou descartar a proposta (mantendo o `HEAD`
 * estável). Só o CONTRATO — a arbitragem, o commit da mutação e a poda do ramo
 * `mem/ai/<sessao>/<path>` vivem fora deste pacote.
 *
 * O `baseCommit` é validado como no {@link WriteNeuronRequest} (compare-and-swap
 * anti-stale): se o `HEAD` estável avançou enquanto o `REVIEW` estava aberto, a
 * decisão é reconciliada contra o novo `HEAD` antes de commitar, preservando o
 * invariante de que o git nunca fica atrás.
 */
export interface ResolveRequest {
  /**
   * Identidade LÓGICA do neurônio em `REVIEW` cuja disputa está sendo fechada (o
   * `.md` versionado — ver `Neuron.path`). Mesma CHAVE fina do
   * {@link MemoryConflict} e do {@link AcquireLockRequest}.
   */
  path: string;
  /**
   * SHA do **ancestral comum** da disputa — o `baseCommit` que o
   * {@link MemoryConflict} carregava (o `HEAD` lido no `acquire`). Serve de âncora
   * do compare-and-swap anti-stale: idêntico à convenção do
   * {@link WriteNeuronRequest}/{@link WriteNeuronConflict}, garante que a decisão
   * do árbitro foi calculada sobre o estado que ele examinou.
   */
  baseCommit: string;
  /**
   * Desfecho **aceitar**: o texto markdown FINAL escolhido pelo árbitro (a
   * reconciliação das duas verdades ou a escolha de um dos lados `ours`/`theirs`
   * do {@link MemoryConflict}). Quando presente, o serviço commita esta mutação
   * arbitrada seguindo a ordem de escrita canônica. Quando AUSENTE, o desfecho é
   * **descartar**: nada é commitado, o `HEAD` estável permanece e a proposta em
   * disputa não entra — em ambos os casos o neurônio volta a `FREE`.
   */
  content?: string;
  /**
   * Identidade estável do **árbitro** que fecha a disputa (`ai:<sessao>` de um
   * agent revisor ou `human:<user>`; ver `AgentId`/`Owner`). Serve para
   * atribuição/auditoria da decisão. Opcional: quando ausente, a Camada 2 deriva o
   * árbitro da sessão corrente. Só o CONTRATO — a autorização de quem pode arbitrar
   * vive fora deste pacote.
   */
  arbiter?: AgentId;
}

/**
 * Resposta de {@link ResolveRequest} — o resultado da transição de lock
 * `REVIEW → FREE` (ver ADR-0027 §"Resolução de conflito semântico"). Expõe o
 * `HEAD` estável **resultante** da decisão do árbitro, fechando o
 * compare-and-swap iniciado no {@link MemoryConflict}. Só o CONTRATO — a
 * arbitragem e o commit da mutação vivem fora deste pacote.
 */
export interface ResolveResponse {
  /**
   * SHA do commit que passa a ser o `HEAD` estável do neurônio após o `REVIEW`
   * fechar. No desfecho **aceitar** (havia `content` no {@link ResolveRequest}) é
   * o **novo** commit da mutação arbitrada — mesma semântica do `headCommit` do
   * {@link WriteNeuronResponse}. No desfecho **descartar** é o `HEAD` estável
   * INALTERADO (nada foi commitado). Em ambos os casos o neurônio volta a `FREE`.
   */
  headCommit: string;
}

/**
 * Por que um neurônio entrou em `REVIEW` (ver ADR-0027 §"Transições de estado" —
 * os **dois gatilhos** de `EDITING → REVIEW`). Distingue a natureza da disputa
 * para que o árbitro (ver {@link MemoryReviewItem}) saiba o que está julgando:
 *
 * - `'semantic-conflict'` — **duas verdades no mesmo trecho**: o merge 3-way
 *   parou porque `ours` e `theirs` colidem (o caso descrito por um
 *   {@link MemoryConflict}). O CAS anti-stale sucedeu; o que falha é o conteúdo.
 * - `'out-of-scope'` — **escrita fora de escopo**: pela política padrão um agent
 *   só escreve DIRETO nos neurônios do módulo da sua story; uma proposta para
 *   fora do escopo não é aplicada direto e vira uma entrada em `REVIEW`.
 *
 * Só o CONTRATO — a política de escopo e a detecção do merge vivem fora do pacote.
 */
export type MemoryReviewReason = 'semantic-conflict' | 'out-of-scope';

/**
 * Item da **fila de REVIEW** — o registro do que entrou em revisão e quem o
 * arbitra (ver ADR-0027 §"Resolução de conflito semântico (REVIEW → árbitro)" e
 * board §24). É o dado que o evento `memory.review` transporta e que o árbitro
 * consome antes de emitir um {@link ResolveRequest}. Modela AMBOS os gatilhos de
 * `EDITING → REVIEW` via {@link MemoryReviewReason}. Só o CONTRATO — a lógica de
 * arbitragem e a política de fila vivem fora deste pacote.
 *
 * Distingue-se do {@link MemoryConflict}: aquele DESCREVE a disputa de conteúdo
 * (os dois lados do merge); este é a ENTRADA de fila que aponta para ela e
 * carrega quem arbitra (`arbiter`). Distingue-se também do
 * {@link WriteNeuronConflict} (409 anti-stale de _timing_, que mantém `EDITING`).
 */
export interface MemoryReviewItem {
  /**
   * Identidade LÓGICA do neurônio que está em `REVIEW` (o `.md` versionado — ver
   * `Neuron.path`). Mesma CHAVE fina do {@link MemoryConflict} e do
   * {@link ResolveRequest}: identifica QUAL neurônio aguarda arbitragem.
   */
  path: string;
  /**
   * SHA do **ancestral comum** sobre o qual a disputa foi calculada — o `HEAD`
   * lido no `acquire` (a `base` do merge 3-way). Mesma âncora do `baseCommit` de
   * {@link WriteNeuronRequest}/{@link MemoryConflict}: o árbitro a repassa no
   * {@link ResolveRequest} para o compare-and-swap anti-stale.
   */
  baseCommit: string;
  /**
   * Motivo da entrada em `REVIEW` (ver {@link MemoryReviewReason}): disputa de
   * conteúdo no mesmo trecho (`'semantic-conflict'`) ou proposta fora do escopo
   * do autor (`'out-of-scope'`). Direciona o julgamento do árbitro.
   */
  reason: MemoryReviewReason;
  /**
   * Ponteiro para a disputa de conteúdo que originou o `REVIEW` — o mesmo payload
   * que o evento `memory.conflict` transporta ({@link MemoryConflict}: `base`,
   * `ours`, `theirs`). Presente quando `reason` é `'semantic-conflict'`; pode
   * ficar AUSENTE em `'out-of-scope'`, onde não há colisão de merge a exibir.
   */
  conflict?: MemoryConflict;
  /**
   * Quem propôs a mutação que caiu em `REVIEW` (`ai:<sessao>` ou `human:<user>`;
   * ver `Owner`). Mesmo tipo de identidade do `holder` do {@link MemoryConflict} e
   * do lock (US-114). Serve para atribuição e para notificar o autor ao fechar.
   */
  holder: Owner;
  /**
   * Identidade estável de **quem arbitra** esta entrada — um **agent revisor**
   * (`ai:<sessao>`, com autoridade/escopo sobre o módulo) ou um **humano**
   * (`human:<user>`), sem diferença de protocolo (ver ADR-0027 §"O árbitro").
   * Opcional: quando ausente, a disputa ainda não foi atribuída a um árbitro.
   * Só o CONTRATO — a política de quem PODE arbitrar vive fora deste pacote.
   */
  arbiter?: AgentId;
}
