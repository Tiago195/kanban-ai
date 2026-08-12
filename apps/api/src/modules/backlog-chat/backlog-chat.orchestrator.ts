import { Injectable, Logger, NotFoundException, ConflictException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  BacklogChatMessage,
  BacklogChatSessionSummary,
  BacklogChatSessionStatus,
  BacklogProposal,
  BacklogProposalPatch,
  BacklogProposalStory,
  BacklogAppliedCard,
  BacklogTaskProposal,
  BacklogTaskProposalItem,
  BacklogTaskProposalPatch,
  MaterializeStoryTaskInput,
  StoryChatSession,
} from '@kanban-ai/shared';
import {
  BACKLOG_MAIN_CHANNEL,
  parseBacklogStoryChannel,
  parseBacklogTaskChannel,
} from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { CardsService } from '../cards/cards.service';
import { BacklogCliRunner } from './runner/backlog-cli.runner';
import { buildBacklogPrompt, type BacklogPromptTurn } from './skill/backlog-po.prompt';
import { applyBacklogPatch } from './backlog-patch';

/** Pergunta HITL pendente numa sessão (aguardando resposta do humano). */
interface PendingQuestion {
  questionId: string;
  /** Canal (thread) em que o turno roda — a resposta é persistida nele. */
  channel: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const HITL_TIMEOUT_MS = 600_000; // 10min, alinhado ao loop engine

/**
 * Sentinela usada para encerrar graciosamente o turno HITL "morto".
 *
 * bug-backlog-hitl-hang: o adapter da CLI é ONE-SHOT — ao fazer uma pergunta,
 * o processo `copilot` já saiu (a pergunta é emitida no `close`). Escrever a
 * resposta no `child.stdin` é no-op e o turno termina sem proposta. A correção
 * é SEMPRE re-spawnar um turno novo com a resposta (idempotente via
 * `--session-id`, que resume o contexto). Para isso, ao responder rejeitamos a
 * promise de `waitForAnswer` com este sentinela: o `runTurn` em curso o
 * reconhece e encerra sem erro e SEM persistir a resposta (quem persiste é o
 * novo turno disparado por `answerQuestion`).
 */
class HitlRespawnSignal extends Error {
  constructor() {
    super('hitl-respawn');
    this.name = 'HitlRespawnSignal';
  }
}

/**
 * Orquestra o chat de criação de backlog (Epic + Stories).
 *
 * Diferente do loop engine (autônomo, iterativo), aqui cada turno é disparado
 * por uma mensagem do humano: monta o prompt (persona PO + histórico), invoca a
 * `BacklogCliRunner`, transmite chunks via WS, trata perguntas de descoberta
 * (HITL) e materializa a proposta/patch como revisão versionada. Nada cria
 * cards — só o `apply()` (server-side, via `CardsService`).
 */
@Injectable()
export class BacklogChatOrchestrator implements OnModuleInit {
  private readonly logger = new Logger(BacklogChatOrchestrator.name);
  /** Perguntas HITL pendentes por sessão. */
  private readonly pending = new Map<string, PendingQuestion>();
  /**
   * Sessões com um turno rodando AGORA neste processo. Usado para (a) não
   * disparar dois turnos concorrentes na mesma sessão e (b) o reconcile de boot
   * não ressuscitar um turno que já está vivo. Chave = sessionId.
   */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly runner: BacklogCliRunner,
    private readonly cards: CardsService,
  ) {}

  /**
   * bug-dropped-turn: ao subir, retoma turnos que ficaram "no ar". Se o browser
   * fechou (ou a API reiniciou) DURANTE um turno normal — não uma pergunta HITL
   * — a sessão fica `open` com uma mensagem do humano como ÚLTIMA do canal e
   * nenhuma resposta da AI depois. Como o turno roda com `--session-id` (a
   * sessão do Copilot é persistida em disco), basta redisparar `runTurn` com o
   * texto do humano: o CLI resume o contexto e conclui. Perguntas HITL
   * pendentes NÃO são retomadas aqui — seguem o caminho de `answerQuestion`.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.reconcileOpenTurns();
    } catch (err) {
      this.logger.warn(
        `reconcileOpenTurns falhou no boot (seguindo de pé): ${String(err)}`,
      );
    }
  }

  /** Ver `onModuleInit`. Extraído para ser testável em isolamento. */
  async reconcileOpenTurns(): Promise<number> {
    const openSessions = await this.prisma.backlogChatSession.findMany({
      where: { status: 'open', messages: { some: {} } },
      select: { id: true, boardId: true },
    });
    let resumed = 0;
    for (const session of openSessions) {
      if (this.running.has(session.id)) continue;
      const last = await this.prisma.backlogChatMessage.findFirst({
        where: { sessionId: session.id },
        orderBy: { ts: 'desc' },
      });
      // Turno pendente = última mensagem é do humano. Se for uma resposta a uma
      // pergunta HITL (`questionId`), também retomamos (o turno que a aguardava
      // morreu). Se a última for da AI, o turno já concluiu — nada a fazer.
      if (!last || last.role !== 'user') continue;
      const channel = last.channel ?? BACKLOG_MAIN_CHANNEL;
      this.logger.log(
        `retomando turno pendente da sessão ${session.id} (canal ${channel}) após restart`,
      );
      void this.runTurn(session.id, session.boardId, last.text, channel).catch((err) => {
        this.logger.error(`runTurn (reconcile) falhou (sessão ${session.id}): ${String(err)}`);
      });
      resumed += 1;
    }
    if (resumed > 0) this.logger.log(`reconcileOpenTurns: ${resumed} turno(s) retomado(s).`);
    return resumed;
  }

  // ── Sessões ─────────────────────────────────────────────────────────────

  async createSession(boardId: string): Promise<{ id: string; title: string }> {
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board) throw new NotFoundException('board inexistente');
    const session = await this.prisma.backlogChatSession.create({
      data: { boardId, title: 'Novo backlog' },
    });
    return { id: session.id, title: session.title };
  }

  /**
   * Lista as sessões de um board (mais recentes primeiro), para o seletor de
   * sessões do painel. Só metadados — não carrega o transcript. Ignora sessões
   * vazias (sem mensagens): são conversas abertas mas nunca iniciadas (ex.: o
   * usuário abriu o chat e fechou), que só poluiriam a lista.
   */
  async listSessions(boardId: string): Promise<BacklogChatSessionSummary[]> {
    const rows = await this.prisma.backlogChatSession.findMany({
      where: { boardId, messages: { some: {} } },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      boardId: r.boardId,
      title: r.title,
      status: r.status as BacklogChatSessionStatus,
      currentProposalVersion: r.currentProposalVersion,
      messageCount: r._count.messages,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Transcript persistido. Se `channel` for informado, filtra pelo canal
   * (thread) — ex.: `main` ou `story:<id>`; caso contrário devolve TODAS as
   * mensagens da sessão (transcript completo, atravessando canais). Ver
   * ADR-0023.
   */
  async getMessages(
    sessionId: string,
    channel?: string,
  ): Promise<BacklogChatMessage[]> {
    await this.ensureSession(sessionId);
    const rows = await this.prisma.backlogChatMessage.findMany({
      where: channel ? { sessionId, channel } : { sessionId },
      orderBy: { ts: 'asc' },
    });
    return rows.map((r) => this.toMessage(r));
  }

  async getCurrentProposal(sessionId: string): Promise<BacklogProposal | null> {
    const session = await this.ensureSession(sessionId);
    if (session.currentProposalVersion == null) return null;
    const rev = await this.prisma.backlogProposalRevision.findUnique({
      where: {
        sessionId_version: {
          sessionId,
          version: session.currentProposalVersion,
        },
      },
    });
    if (!rev) return null;
    return this.ensureStoryIds(rev.proposal as unknown as BacklogProposal);
  }

  /**
   * Garante que toda story da proposta tenha um `id`. Propostas NOVAS já são
   * gravadas com ids estáveis (ver `persistProposal`/`applyBacklogPatch`); este
   * backfill cobre apenas revisões antigas (pré-feature) — nesses casos usamos
   * `s${index}` como âncora determinística de leitura. Não é estável a
   * reordenação, mas essas linhas legadas não têm threads associadas. Ver
   * ADR-0023.
   */
  private ensureStoryIds(proposal: BacklogProposal): BacklogProposal {
    if (!proposal?.stories) return proposal;
    const needs = proposal.stories.some((s) => !s?.id);
    if (!needs) return proposal;
    return {
      ...proposal,
      stories: proposal.stories.map((s, i) => (s.id ? s : { ...s, id: `s${i}` })),
    };
  }

  // ── Turno de conversa ───────────────────────────────────────────────────

  /** Processa uma mensagem nova do humano (turno completo). */
  async sendMessage(
    sessionId: string,
    text: string,
    channel: string = BACKLOG_MAIN_CHANNEL,
  ): Promise<void> {
    const session = await this.ensureSession(sessionId);

    // Persiste a mensagem do humano no canal (thread) em que foi disparada.
    await this.prisma.backlogChatMessage.create({
      data: { sessionId, role: 'user', text, channel },
    });

    // Dá um título significativo à sessão a partir da 1ª mensagem do humano
    // (enquanto ainda for o placeholder "Novo backlog"), para o seletor de
    // sessões ficar legível em vez de uma lista de "Novo backlog".
    if (session.title === 'Novo backlog') {
      const title = text.trim().replace(/\s+/g, ' ').slice(0, 60) || 'Novo backlog';
      await this.prisma.backlogChatSession.update({
        where: { id: sessionId },
        data: { title },
      });
    }

    // O turno é disparado em background: a CLI faz streaming e pode FAZER UMA
    // PERGUNTA (HITL), bloqueando em `waitForAnswer` até o humano responder via
    // POST /answer. Se `await`ássemos aqui, a request de /messages ficaria
    // aberta o turno inteiro — travando o front (busy) e impedindo a resposta.
    // Por isso retornamos assim que a mensagem foi persistida.
    void this.runTurn(sessionId, session.boardId, text, channel).catch((err) => {
      this.logger.error(
        `runTurn falhou (sessão ${sessionId}): ${String(err)}`,
      );
    });
  }

  /**
   * Responde a uma pergunta de descoberta pendente (HITL).
   *
   * Caminho rápido: existe uma Promise viva de `waitForAnswer` (mesmo processo,
   * turno ainda parado) → resolve e o turno segue de onde parou.
   *
   * Caminho de resiliência: NÃO há promise viva (a API reiniciou enquanto
   * aguardava a resposta — o Map em memória e o processo do Copilot morreram).
   * Como cada turno roda com `--session-id` (a sessão do Copilot é persistida em
   * disco), retomamos: persistimos a resposta do humano e disparamos um turno
   * novo com ela. O CLI resume o contexto — inclusive a pergunta feita — e
   * continua a conversa naturalmente, sem o usuário perceber a costura.
   *
   * @returns `true` se aceito por qualquer um dos caminhos; `false` só se a
   * pergunta nem existe/não bate no histórico persistido.
   */
  async answerQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
  ): Promise<boolean> {
    // Só aceita responder uma pergunta que EXISTE no histórico persistido e que
    // ainda NÃO foi respondida — vale para ambos os caminhos (mesmo processo ou
    // pós-restart), evitando respostas duplicadas ou órfãs.
    const question = await this.prisma.backlogChatMessage.findFirst({
      where: { sessionId, role: 'ai', questionId },
    });
    if (!question) return false;
    const alreadyAnswered = await this.prisma.backlogChatMessage.findFirst({
      where: { sessionId, role: 'user', questionId },
    });
    if (alreadyAnswered) return false;

    const session = await this.ensureSession(sessionId);
    const channel = question.channel ?? BACKLOG_MAIN_CHANNEL;

    // bug-backlog-hitl-hang: como o adapter da CLI é one-shot (o processo já
    // morreu quando a pergunta chegou), NÃO adianta resolver a promise e deixar
    // o runner escrever no stdin morto — a resposta some e o turno termina sem
    // proposta. A correção é SEMPRE tratar a resposta como um turno novo. Se há
    // uma promise viva no mesmo processo (fast-path), a encerramos com o
    // sentinela `HitlRespawnSignal` para o turno "morto" desistir sem erro e SEM
    // persistir a resposta em duplicidade — quem persiste é este método, logo
    // abaixo, e o novo `runTurn` faz o Copilot resumir o contexto (--session-id)
    // e finalmente produzir a proposta.
    const p = this.pending.get(sessionId);
    if (p && p.questionId === questionId) {
      clearTimeout(p.timer);
      this.pending.delete(sessionId);
      p.reject(new HitlRespawnSignal());
    }

    // Persiste a resposta humana (marcando-a como resposta desta pergunta) no
    // MESMO canal (thread) da pergunta — assim a resposta fica na thread certa.
    await this.prisma.backlogChatMessage.create({
      data: { sessionId, role: 'user', text: answer, questionId, channel },
    });
    this.realtime.broadcast({
      type: 'backlog.answered',
      sessionId,
      questionId,
      channel,
    });

    // Dispara um turno novo com a resposta como entrada. O `--session-id` faz o
    // Copilot resumir o contexto (incluindo a pergunta) — a conversa continua.
    // Aguardamos o turno "morto" liberar o lock `running` antes de disparar o
    // novo (o `finally` do runTurn em curso roda logo após a rejeição acima).
    this.logger.log(
      `HITL respondido → re-spawn de turno (sessão ${sessionId}, pergunta ${questionId})`,
    );
    void this.respawnAfterAnswer(sessionId, session.boardId, answer, channel);
    return true;
  }

  /**
   * Dispara o turno de continuação após uma resposta HITL, esperando o turno
   * "morto" liberar o lock `running`. Sem essa espera, a guarda de concorrência
   * do `runTurn` recusaria o novo turno (o antigo ainda não terminou seu
   * `finally`). Faz um curto polling (o turno morto encerra em ms, pois o child
   * já saiu). Ver bug-backlog-hitl-hang.
   */
  private async respawnAfterAnswer(
    sessionId: string,
    boardId: string,
    answer: string,
    channel: string,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (this.running.has(sessionId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    try {
      await this.runTurn(sessionId, boardId, answer, channel);
    } catch (err) {
      this.logger.error(
        `runTurn (retomada HITL) falhou (sessão ${sessionId}): ${String(err)}`,
      );
    }
  }

  private async runTurn(
    sessionId: string,
    boardId: string,
    userText: string,
    channel: string = BACKLOG_MAIN_CHANNEL,
  ): Promise<void> {
    // Guarda de concorrência (bug-dropped-turn): no máximo um turno vivo por
    // sessão neste processo — evita que o reconcile de boot e um POST /messages
    // (ou dois disparos) rodem turnos concorrentes que embaralhariam o
    // transcript e a sessão do Copilot.
    if (this.running.has(sessionId)) {
      this.logger.warn(
        `runTurn ignorado: já há um turno vivo para a sessão ${sessionId}.`,
      );
      return;
    }
    this.running.add(sessionId);
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    // Histórico por canal: como o turno roda com `--session-id` (o Copilot já
    // resume TODO o contexto real da sessão), passamos ao prompt apenas o
    // histórico persistido DESTE canal — evita duplicar contexto e mantém a
    // thread coesa; o escopo fino vem do `focusStory`. Ver ADR-0023.
    const history = await this.buildHistory(sessionId, channel);
    const current = await this.getCurrentProposal(sessionId);

    // Thread focada de uma story (channel = story:<id>): localiza a story na
    // proposta corrente para injetar `focusStory` no prompt. Se não achar
    // (proposta ainda inexistente ou story removida), omite — trata como main.
    const focusStory = this.resolveFocusStory(channel, current);

    // Chat da story (ADR-0026): se ESTA sessão está ancorada numa story-card do
    // board (via `Card.backlogChatSessionId`), injeta o contexto real da story —
    // assim a IA já conhece a história e ajuda a decompô-la em tasks, sem
    // perguntar "qual é a história?". Funciona tanto para story manual (sessão
    // zerada) quanto para sessão reusada de um backlog-chat.
    const storyCard = await this.resolveStoryCardContext(sessionId);

    // Chat da story (ADR-0026): a proposta de TASKS é escopada a esta sessão de
    // story. Injeta a proposta corrente (para refinamento cirúrgico) e, se o
    // canal é uma thread task:<id>, o item em foco — assim a IA edita apenas
    // aquela task via KANBAN_TASKS_PATCH.
    const currentTasks = await this.getCurrentTaskProposal(sessionId);
    const focusTask = this.resolveFocusTask(channel, currentTasks);

    const prompt = buildBacklogPrompt({
      boardTitle: board?.title ?? '(board)',
      history,
      userText,
      currentProposalJson: current
        ? JSON.stringify(current, null, 2)
        : undefined,
      focusStory,
      storyCard,
      currentTaskProposalJson: currentTasks
        ? JSON.stringify(currentTasks, null, 2)
        : undefined,
      focusTask,
    });

    // Buffer de consolidação de chunks (persiste o transcript por kind).
    let chunkBuffer: { kind: 'thought' | 'output'; text: string } | null = null;
    // BUG-01: quando true, o turno cedeu lugar a um re-spawn HITL e NÃO deve
    // emitir `backlog.turn_done` (o novo turno segue o streaming).
    let hitlRespawn = false;
    const flushChunk = async () => {
      if (!chunkBuffer || chunkBuffer.text.trim().length === 0) {
        chunkBuffer = null;
        return;
      }
      await this.prisma.backlogChatMessage.create({
        data: {
          sessionId,
          role: 'ai',
          kind: chunkBuffer.kind,
          text: chunkBuffer.text,
          channel,
        },
      });
      chunkBuffer = null;
    };

    try {
      await this.runner.run({
        prompt,
        cliSessionId: sessionId,
        handlers: {
          onChunk: (chunk) => {
            this.realtime.broadcast({
              type: 'backlog.chunk',
              sessionId,
              channel,
              role: 'ai',
              kind: chunk.kind,
              delta: chunk.delta,
            });
            if (chunkBuffer && chunkBuffer.kind !== chunk.kind) {
              void flushChunk();
            }
            if (!chunkBuffer) chunkBuffer = { kind: chunk.kind, text: chunk.delta };
            else chunkBuffer.text += chunk.delta;
          },
          onQuestion: async (question) => {
            const questionId = question.id || randomUUID();
            await flushChunk();
            this.realtime.broadcast({
              type: 'backlog.question',
              sessionId,
              channel,
              questionId,
              prompt: question.prompt,
              options: question.options,
            });
            await this.prisma.backlogChatMessage.create({
              data: {
                sessionId,
                role: 'ai',
                text: question.prompt,
                questionId,
                options: question.options ?? undefined,
                channel,
              },
            });
            try {
              const answer = await this.waitForAnswer(sessionId, questionId, channel);
              await this.prisma.backlogChatMessage.create({
                data: { sessionId, role: 'user', text: answer, questionId, channel },
              });
              this.realtime.broadcast({
                type: 'backlog.answered',
                sessionId,
                channel,
                questionId,
              });
              return answer;
            } catch (err) {
              // bug-backlog-hitl-hang: `HitlRespawnSignal` NÃO é falha — é o sinal
              // de que a resposta chegou e será entregue por um turno NOVO (o
              // adapter one-shot já morreu). Encerramos este turno "morto" sem
              // persistir a resposta (o novo turno cuida disso) e sem broadcast
              // de `answered` (idem). Repropagamos para desfazer o turno atual.
              if (!(err instanceof HitlRespawnSignal)) {
                this.realtime.broadcast({
                  type: 'backlog.answered',
                  sessionId,
                  channel,
                  questionId,
                });
              }
              throw err;
            }
          },
          onProposal: async (proposal) => {
            await flushChunk();
            await this.persistProposal(sessionId, proposal);
          },
          onPatch: async (patch) => {
            await flushChunk();
            await this.applyPatch(sessionId, patch);
          },
          onTaskProposal: async (taskProposal) => {
            await flushChunk();
            await this.persistTaskProposal(sessionId, taskProposal);
          },
          onTaskPatch: async (taskPatch) => {
            await flushChunk();
            await this.applyTaskPatch(sessionId, taskPatch);
          },
        },
      });
    } catch (err) {
      // Encerramento gracioso quando a resposta HITL foi entregue via re-spawn:
      // o turno "morto" desiste com `HitlRespawnSignal` — não é erro. Qualquer
      // outra falha é repropagada.
      if (err instanceof HitlRespawnSignal) {
        this.logger.debug(
          `turno HITL encerrado para re-spawn (sessão ${sessionId}).`,
        );
        hitlRespawn = true;
        return;
      }
      throw err;
    } finally {
      await flushChunk();
      this.running.delete(sessionId);
      // BUG-01: um turno que encerra sem `proposal`/`question` deixaria o
      // indicador de streaming ligado para sempre. Emitimos `backlog.turn_done`
      // no fim de TODO turno — exceto quando ele apenas cede lugar a um re-spawn
      // HITL (nesse caso o novo turno continua o streaming).
      if (!hitlRespawn) {
        this.realtime.broadcast({
          type: 'backlog.turn_done',
          sessionId,
          channel,
        });
      }
    }
  }

  /**
   * Resolve a story em foco quando o canal é uma thread `story:<id>`. Casa o
   * `id` estável contra a proposta corrente e devolve o shape que o prompt
   * espera (com o índice atual para os paths de patch). Retorna `undefined`
   * quando o canal é `main` ou a story não foi encontrada. Ver ADR-0023.
   */
  private resolveFocusStory(
    channel: string,
    current: BacklogProposal | null,
  ):
    | {
        id: string;
        title: string;
        description?: string;
        aiSummary?: string;
        aiNotes?: string;
        points?: number;
        tasks?: { id: string; title: string }[];
        index: number;
      }
    | undefined {
    const storyId = parseBacklogStoryChannel(channel);
    if (!storyId || !current) return undefined;
    const index = current.stories.findIndex((s) => s.id === storyId);
    if (index < 0) return undefined;
    const story = current.stories[index];
    return {
      id: story.id,
      title: story.title,
      description: story.description,
      aiSummary: story.aiSummary,
      aiNotes: story.aiNotes,
      points: story.points,
      tasks: story.tasks,
      index,
    };
  }

  /**
   * Resolve o contexto da story-card do board ancorada a ESTA sessão de chat
   * (via `Card.backlogChatSessionId`, tipo `story`). Retorna o shape que o
   * prompt usa para o "chat da story" (ADR-0026): título, descrição, contexto
   * de AI, DoD, épico-pai e tasks já existentes. Retorna `undefined` quando a
   * sessão não é o chat de uma story (ex.: backlog-chat geral que ainda não foi
   * aplicado, ou sessão sem card vinculado).
   *
   * IMPORTANTE: se uma sessão de backlog-chat foi aplicada, ela pode ter
   * MÚLTIPLAS stories-cards vinculadas (todas carimbadas no `apply`). Nesse
   * caso NÃO há uma única "story em foco" — o chat é geral, não o de uma story.
   * Só tratamos como "chat da story" quando existe EXATAMENTE uma story-card
   * vinculada (o caso do `openStorySession`: manual zerada, ou reuso de um
   * backlog-chat de story única).
   */
  private async resolveStoryCardContext(sessionId: string): Promise<
    | {
        key: string;
        title: string;
        description?: string;
        aiSummary?: string;
        aiNotes?: string;
        points?: number;
        dod?: string[];
        epicTitle?: string;
        existingTasks?: string[];
      }
    | undefined
  > {
    const stories = await this.prisma.card.findMany({
      where: { backlogChatSessionId: sessionId, type: 'story' },
      select: {
        id: true,
        key: true,
        title: true,
        description: true,
        aiSummary: true,
        aiNotes: true,
        points: true,
        parent: { select: { title: true, type: true } },
      },
    });
    if (stories.length !== 1) return undefined;
    const story = stories[0];

    const [dodItems, taskCards] = await Promise.all([
      this.prisma.dodItem.findMany({
        where: { cardId: story.id },
        orderBy: { position: 'asc' },
        select: { text: true },
      }),
      this.prisma.card.findMany({
        where: { parentId: story.id, type: 'task' },
        orderBy: { position: 'asc' },
        select: { title: true },
      }),
    ]);

    return {
      key: story.key,
      title: story.title,
      description: story.description ?? undefined,
      aiSummary: story.aiSummary ?? undefined,
      aiNotes: story.aiNotes ?? undefined,
      points: story.points ?? undefined,
      dod: dodItems.map((d) => d.text),
      epicTitle: story.parent?.type === 'epic' ? story.parent.title : undefined,
      existingTasks: taskCards.map((t) => t.title),
    };
  }

  // ── Proposta e patch (S5 core) ──────────────────────────────────────────

  /** Persiste uma proposta completa como nova revisão e reemite o evento. */
  private async persistProposal(
    sessionId: string,
    proposal: BacklogProposal,
  ): Promise<void> {
    const session = await this.ensureSession(sessionId);
    // A versão autoritativa é definida pelo backend (a AI só sugere).
    const nextVersion = (session.currentProposalVersion ?? 0) + 1;
    // A AI emite stories SEM id; o backend atribui um id estável (âncora das
    // threads story:<id>). Preserva ids que já venham preenchidos. Ver ADR-0023.
    // Tasks rascunhadas também ganham id estável (viram cards type:task no apply).
    const stories: BacklogProposalStory[] = (proposal.stories ?? []).map((s) => ({
      ...s,
      id: s.id && s.id.length > 0 ? s.id : randomUUID(),
      tasks: Array.isArray(s.tasks)
        ? s.tasks.map((t) => ({
            ...t,
            id: t.id && t.id.length > 0 ? t.id : randomUUID(),
          }))
        : s.tasks,
    }));
    const normalized: BacklogProposal = {
      ...proposal,
      version: nextVersion,
      stories,
    };
    await this.saveRevision(sessionId, normalized);
    await this.emitProposal(sessionId, normalized);
  }

  /** Aplica um patch cirúrgico sobre a proposta corrente (imutável, +1 versão). */
  async applyPatch(sessionId: string, patch: BacklogProposalPatch): Promise<void> {
    const current = await this.getCurrentProposal(sessionId);
    if (!current) {
      // Sem proposta corrente não há o que refinar — ignora silenciosamente.
      this.logger.warn(`patch recebido sem proposta corrente (session=${sessionId})`);
      return;
    }
    const next = applyBacklogPatch(current, patch);
    await this.saveRevision(sessionId, next);
    await this.emitProposal(sessionId, next);
  }

  private async saveRevision(
    sessionId: string,
    proposal: BacklogProposal,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.backlogProposalRevision.create({
        data: {
          sessionId,
          version: proposal.version,
          proposal: proposal as unknown as object,
        },
      }),
      this.prisma.backlogChatSession.update({
        where: { id: sessionId },
        data: { currentProposalVersion: proposal.version },
      }),
      this.prisma.backlogChatMessage.create({
        data: {
          sessionId,
          role: 'ai',
          kind: 'proposal',
          text: proposal.epic.title,
          proposal: proposal as unknown as object,
          // A proposta pertence à timeline geral (independe da thread que
          // disparou o patch) — grava sempre no canal main. Ver ADR-0023.
          channel: BACKLOG_MAIN_CHANNEL,
        },
      }),
    ]);
  }

  private async emitProposal(
    sessionId: string,
    proposal: BacklogProposal,
  ): Promise<void> {
    this.realtime.broadcast({ type: 'backlog.proposal', sessionId, proposal });
  }

  // ── Proposta de TASKS do chat da story (ADR-0026) ───────────────────────

  /**
   * Resolve o item em foco quando o canal é uma thread `task:<id>`. Retorna o
   * task correspondente na proposta corrente + seu índice, ou undefined.
   */
  private resolveFocusTask(
    channel: string,
    current: BacklogTaskProposal | null,
  ):
    | { id: string; title: string; description?: string; index: number }
    | undefined {
    const taskId = parseBacklogTaskChannel(channel);
    if (!taskId || !current) return undefined;
    const index = current.tasks.findIndex((t) => t.id === taskId);
    if (index < 0) return undefined;
    const task = current.tasks[index];
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      index,
    };
  }

  /**
   * Recupera a proposta de tasks corrente da sessão: a última mensagem
   * `kind:'task_proposal'` (a coluna `proposal Json?` guarda o JSON). Retorna
   * null se ainda não houve proposta de tasks.
   */
  async getCurrentTaskProposal(
    sessionId: string,
  ): Promise<BacklogTaskProposal | null> {
    const last = await this.prisma.backlogChatMessage.findFirst({
      where: { sessionId, kind: 'task_proposal' },
      orderBy: { ts: 'desc' },
    });
    if (!last || last.proposal == null) return null;
    return last.proposal as unknown as BacklogTaskProposal;
  }

  /**
   * Persiste uma proposta de tasks: atribui ids estáveis (âncora das threads
   * `task:<id>`), incrementa a versão, grava uma `BacklogChatMessage`
   * `kind:'task_proposal'` e reemite via WS. NÃO cria cards — a materialização
   * é explícita (`materializeStoryTasks`). Sem migração de schema (reusa a
   * coluna `proposal Json?`).
   */
  private async persistTaskProposal(
    sessionId: string,
    proposal: BacklogTaskProposal,
  ): Promise<void> {
    const prev = await this.getCurrentTaskProposal(sessionId);
    const nextVersion = (prev?.version ?? 0) + 1;
    const tasks: BacklogTaskProposalItem[] = (proposal.tasks ?? []).map((t) => ({
      ...t,
      id: t.id && t.id.length > 0 ? t.id : randomUUID(),
    }));
    const normalized: BacklogTaskProposal = {
      ...proposal,
      version: nextVersion,
      tasks,
    };
    await this.prisma.backlogChatMessage.create({
      data: {
        sessionId,
        role: 'ai',
        kind: 'task_proposal',
        text: proposal.rationale ?? 'Tasks sugeridas',
        proposal: normalized as unknown as object,
        channel: BACKLOG_MAIN_CHANNEL,
      },
    });
    this.realtime.broadcast({
      type: 'backlog.task_proposal',
      sessionId,
      taskProposal: normalized,
    });
  }

  /**
   * Aplica um patch cirúrgico sobre a proposta de tasks corrente. Suporta ops
   * `replace`/`add`/`remove` sobre `title`/`description` de uma task (endereçada
   * por `/tasks/<idx>/<field>`). Persiste como nova proposta (+1 versão).
   */
  async applyTaskPatch(
    sessionId: string,
    patch: BacklogTaskProposalPatch,
  ): Promise<void> {
    const current = await this.getCurrentTaskProposal(sessionId);
    if (!current) {
      this.logger.warn(
        `task_patch recebido sem proposta de tasks corrente (session=${sessionId})`,
      );
      return;
    }
    const tasks = current.tasks.map((t) => ({ ...t }));
    let rationale = current.rationale;
    for (const op of patch.ops ?? []) {
      const path = op.path ?? '';
      // /rationale
      if (path === '/rationale') {
        rationale = op.op === 'remove' ? undefined : String(op.value ?? '');
        continue;
      }
      // add nova task em /tasks/-
      if (path === '/tasks/-' && op.op === 'add' && op.value && typeof op.value === 'object') {
        const v = op.value as { id?: string; title?: string; description?: string };
        tasks.push({
          id: v.id && v.id.length > 0 ? v.id : randomUUID(),
          title: String(v.title ?? ''),
          description: v.description,
        });
        continue;
      }
      // remove task inteira em /tasks/<i>
      const rm = /^\/tasks\/(\d+)$/.exec(path);
      if (rm && op.op === 'remove') {
        const idx = Number(rm[1]);
        if (idx >= 0 && idx < tasks.length) tasks.splice(idx, 1);
        continue;
      }
      // replace/add/remove de campo em /tasks/<i>/<field>
      const m = /^\/tasks\/(\d+)\/(title|description)$/.exec(path);
      if (!m) continue;
      const idx = Number(m[1]);
      const field = m[2] as 'title' | 'description';
      if (idx < 0 || idx >= tasks.length) continue;
      if (op.op === 'remove') {
        if (field === 'description') delete tasks[idx].description;
      } else if (typeof op.value === 'string') {
        tasks[idx][field] = op.value;
      }
    }
    const next: BacklogTaskProposal = {
      ...current,
      version: (current.version ?? 0) + 1,
      tasks,
      rationale,
    };
    await this.prisma.backlogChatMessage.create({
      data: {
        sessionId,
        role: 'ai',
        kind: 'task_proposal',
        text: current.rationale ?? 'Tasks refinadas',
        proposal: next as unknown as object,
        channel: BACKLOG_MAIN_CHANNEL,
      },
    });
    this.realtime.broadcast({
      type: 'backlog.task_proposal',
      sessionId,
      taskProposal: next,
    });
  }

  // ── Apply: materializa Epic + Stories via CardsService ──────────────────

  async apply(
    sessionId: string,
    version: number,
  ): Promise<{ cards: BacklogAppliedCard[] }> {
    const session = await this.ensureSession(sessionId);
    if (session.status === 'applied') {
      // Estado inválido, não "recurso inexistente": a sessão existe, mas já foi
      // materializada no board — reaplicar duplicaria épico/stories/tasks.
      throw new ConflictException('sessão já aplicada');
    }
    const rev = await this.prisma.backlogProposalRevision.findUnique({
      where: { sessionId_version: { sessionId, version } },
    });
    if (!rev) throw new NotFoundException(`proposta versão ${version} inexistente`);
    const proposal = rev.proposal as unknown as BacklogProposal;

    const created: BacklogAppliedCard[] = [];

    // Epic primeiro (parentId=null, sem columnId — vive por hierarquia).
    // O `aiProject` (repo-alvo descoberto pelo PO na fase de discovery) é
    // persistido aqui; as stories filhas o herdam no loop engine (fallback
    // epic→story). Ver finding imp-aiproject-missing.
    const epicAiProject = proposal.epic.aiProject?.trim();
    const epic = await this.cards.create({
      boardId: session.boardId,
      type: 'epic',
      title: proposal.epic.title,
      description: proposal.epic.description ?? '',
      points: proposal.epic.points,
      parentId: null,
      backlogChatSessionId: sessionId,
      ...(epicAiProject ? { aiProject: epicAiProject } : {}),
    });
    created.push({
      id: epic.id,
      key: epic.key,
      type: 'epic',
      title: epic.title,
      parentId: null,
    });

    // Stories filhas do epic.
    for (const story of proposal.stories) {
      const s = await this.cards.create({
        boardId: session.boardId,
        type: 'story',
        title: story.title,
        description: story.description ?? '',
        points: story.points,
        parentId: epic.id,
        aiSummary: story.aiSummary,
        aiNotes: story.aiNotes,
        backlogChatSessionId: sessionId,
      });
      created.push({
        id: s.id,
        key: s.key,
        type: 'story',
        title: s.title,
        parentId: epic.id,
      });

      // DoD sugerido pela proposta vira DodItem do card story, na ordem
      // proposta (position incremental). É o único checklist do v1 (ADR-0007).
      const dod = story.dod ?? [];
      for (let i = 0; i < dod.length; i++) {
        const text = dod[i]?.trim();
        if (!text) continue;
        await this.prisma.dodItem.create({
          data: { cardId: s.id, text, position: i },
        });
      }

      // affectedFlows sugeridos viram AffectedFlow do card story.
      for (const flow of story.affectedFlows ?? []) {
        const name = flow?.name?.trim();
        if (!name) continue;
        await this.prisma.affectedFlow.create({
          data: {
            cardId: s.id,
            name,
            files: flow.files ?? [],
            note: flow.note ?? '',
          },
        });
      }

      // Tasks rascunhadas viram cards type:task filhos da story (caem em "To Do"
      // automaticamente — ver CardsService.create). Task não tem pontos nem DoD:
      // o refinamento e o DoD acontecem depois, no board. Ver ADR-0024.
      for (const task of story.tasks ?? []) {
        const t = await this.cards.create({
          boardId: session.boardId,
          type: 'task',
          title: task.title,
          description: task.description ?? '',
          parentId: s.id,
          backlogChatSessionId: sessionId,
        });
        created.push({
          id: t.id,
          key: t.key,
          type: 'task',
          title: t.title,
          parentId: s.id,
        });
      }
    }

    await this.prisma.backlogChatSession.update({
      where: { id: sessionId },
      data: { status: 'applied', title: proposal.epic.title },
    });

    return { cards: created };
  }

  /**
   * Resolve o card `type:story` do board que foi materializado por uma sessão
   * de backlog-chat já aplicada, casando pelo título da story da proposta.
   *
   * Usado pelo fluxo "sugerir tasks numa sessão applied" (bug tasks-fantasma):
   * a thread da proposta (`StoryThreadSheet`) só tem a story da PROPOSTA (id
   * instável), mas o board já tem o card real (carimbado com
   * `backlogChatSessionId = sessionId` no `apply`). Casamos pelo título para
   * redirecionar o usuário ao "chat da story", onde a materialização
   * incremental (`materializeStoryTasks`) cria as tasks de fato — em vez de
   * apenas rascunhá-las na proposta (que não vira card e gera "tasks fantasma").
   *
   * @returns o `StoryChatSession` da story-card resolvida, ou `null` se nenhum
   *          card correspondente existir (ex.: sessão ainda não aplicada).
   */
  async resolveAppliedStoryCard(
    sessionId: string,
    title: string,
  ): Promise<StoryChatSession | null> {
    const wanted = title?.trim();
    if (!wanted) return null;
    const stories = await this.prisma.card.findMany({
      where: { backlogChatSessionId: sessionId, type: 'story' },
      select: { id: true, title: true, boardId: true },
    });
    // Casa primeiro por título exato (trim); nenhuma outra âncora estável existe
    // entre a story da proposta e o card do board.
    const match =
      stories.find((s) => s.title.trim() === wanted) ??
      (stories.length === 1 ? stories[0] : undefined);
    if (!match) return null;
    return {
      sessionId,
      boardId: match.boardId,
      storyId: match.id,
      reused: true,
    };
  }

  // ── Chat da story: abrir (ou reusar) a sessão de uma story ──────────────

  /**
   * Abre (ou reusa) a `BacklogChatSession` do "chat da story" para um card
   * `type:story` existente no board. Ver ADR-0026.
   *
   * Regra de origem:
   * - Se a story tem `backlogChatSessionId` (veio de um backlog-chat), **reusa**
   *   essa sessão — mesmo transcript/contexto — focando no canal `story:<id>`.
   * - Se a story é manual (`backlogChatSessionId=null`), cria uma
   *   `BacklogChatSession` **zerada** dedicada e já a vincula ao card via
   *   `backlogChatSessionId` (rastreio consistente para materializações futuras).
   *
   * @param storyId id do card `type:story` (não é o id estável da proposta).
   */
  async openStorySession(storyId: string): Promise<StoryChatSession> {
    const story = await this.prisma.card.findUnique({
      where: { id: storyId },
      select: { id: true, type: true, title: true, boardId: true, backlogChatSessionId: true },
    });
    if (!story) throw new NotFoundException('story inexistente');
    if (story.type !== 'story') {
      throw new ConflictException('o chat da story só existe para cards do tipo story');
    }

    // Caminho A: story veio de um backlog-chat → reusa a sessão original.
    if (story.backlogChatSessionId) {
      const existing = await this.prisma.backlogChatSession.findUnique({
        where: { id: story.backlogChatSessionId },
      });
      if (existing) {
        return {
          sessionId: existing.id,
          boardId: story.boardId,
          storyId: story.id,
          reused: true,
          taskProposal:
            (await this.getCurrentTaskProposal(existing.id)) ?? undefined,
        };
      }
      // Sessão original foi apagada (SetNull deixou o vínculo pendurado): cai no
      // caminho manual e recria uma sessão zerada.
    }

    // Caminho B: story manual (ou sessão original inexistente) → cria uma
    // sessão zerada e vincula ao card. Não usamos createSession() porque
    // queremos um título derivado da story e o vínculo imediato.
    const session = await this.prisma.backlogChatSession.create({
      data: { boardId: story.boardId, title: story.title },
    });
    await this.prisma.card.update({
      where: { id: story.id },
      data: { backlogChatSessionId: session.id },
    });

    return {
      sessionId: session.id,
      boardId: story.boardId,
      storyId: story.id,
      reused: false,
    };
  }

  /**
   * Materializa as tasks rascunhadas de uma story-card como cards `type:task`
   * filhos, em To Do. Ver ADR-0026.
   *
   * Reusa `CardsService.create` (invariante "task só em Backlog/To Do" e "task
   * sem pontos" já garantidos lá). Ao criar ≥1 task, limpa o flag `needsHuman`
   * do card story (BUG-08/09) — o board fica consistente para o loop retomar; o
   * broadcast `card.updated`/retomada de loop já é emitido por
   * `CardsService.create` → `maybeResumeLoopOnTaskAdded`.
   *
   * @param storyCardId id do card `type:story` que recebe as tasks.
   * @param tasks       tasks a criar `{ title, description? }` (títulos vazios são ignorados).
   */
  async materializeStoryTasks(
    storyCardId: string,
    tasks: MaterializeStoryTaskInput[],
  ): Promise<{ cards: BacklogAppliedCard[] }> {
    const story = await this.prisma.card.findUnique({
      where: { id: storyCardId },
      select: { id: true, type: true, boardId: true, backlogChatSessionId: true },
    });
    if (!story) throw new NotFoundException('story inexistente');
    if (story.type !== 'story') {
      throw new ConflictException('só é possível materializar tasks numa story');
    }

    const clean = (tasks ?? [])
      .map((t) => ({ title: (t?.title ?? '').trim(), description: t?.description }))
      .filter((t) => t.title.length > 0);
    const created: BacklogAppliedCard[] = [];
    for (const task of clean) {
      const t = await this.cards.create({
        boardId: story.boardId,
        type: 'task',
        title: task.title,
        description: task.description ?? '',
        parentId: story.id,
        ...(story.backlogChatSessionId
          ? { backlogChatSessionId: story.backlogChatSessionId }
          : {}),
      });
      created.push({ id: t.id, key: t.key, type: 'task', title: t.title, parentId: story.id });
    }

    // Ao ganhar ≥1 task, a story não está mais "sem o que executar": limpa o
    // badge "Precisa de você" se ainda estiver setado. (CardsService.create já
    // faz isso quando a story está em In Progress via maybeResumeLoopOnTaskAdded;
    // aqui garantimos o mesmo mesmo fora de In Progress — outra US cuida do badge
    // na UI, aqui garantimos o backend consistente.)
    if (created.length > 0) {
      await this.clearStoryNeedsHuman(story.id);
    }

    return { cards: created };
  }

  /**
   * Limpa `needsHuman`/`needsHumanReason` do card story (se setado) e emite
   * `card.updated` para o badge sumir no board. Idempotente.
   */
  private async clearStoryNeedsHuman(storyId: string): Promise<void> {
    const story = await this.prisma.card.findUnique({
      where: { id: storyId },
      select: { needsHuman: true },
    });
    if (!story?.needsHuman) return;
    await this.prisma.card.update({
      where: { id: storyId },
      data: { needsHuman: false, needsHumanReason: null },
    });
    const full = await this.prisma.card.findUnique({ where: { id: storyId } });
    this.realtime.broadcast({ type: 'card.updated', cardId: storyId, card: full as never });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private waitForAnswer(
    sessionId: string,
    questionId: string,
    channel: string = BACKLOG_MAIN_CHANNEL,
  ): Promise<string> {
    // Substitui qualquer pendência anterior da mesma sessão.
    const prev = this.pending.get(sessionId);
    if (prev) {
      clearTimeout(prev.timer);
      prev.reject(new Error('substituída por nova pergunta'));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.get(sessionId)?.questionId === questionId) {
          this.pending.delete(sessionId);
        }
        reject(new Error(`HITL timeout (${HITL_TIMEOUT_MS}ms)`));
      }, HITL_TIMEOUT_MS);
      this.pending.set(sessionId, { questionId, channel, resolve, reject, timer });
    });
  }

  private async buildHistory(
    sessionId: string,
    channel: string = BACKLOG_MAIN_CHANNEL,
  ): Promise<BacklogPromptTurn[]> {
    const rows = await this.prisma.backlogChatMessage.findMany({
      where: { sessionId, channel },
      orderBy: { ts: 'asc' },
    });
    return rows
      .filter((r) => r.kind !== 'proposal' && r.kind !== 'task_proposal') // propostas vão via *ProposalJson
      .map((r) => ({
        role: r.role as BacklogPromptTurn['role'],
        text: r.text,
      }));
  }

  private async ensureSession(sessionId: string) {
    const session = await this.prisma.backlogChatSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundException('sessão de backlog inexistente');
    return session;
  }

  private toMessage(r: {
    id: string;
    sessionId: string;
    role: string;
    kind: string | null;
    text: string;
    questionId: string | null;
    options: unknown;
    proposal: unknown;
    channel: string | null;
    ts: Date;
  }): BacklogChatMessage {
    return {
      id: r.id,
      sessionId: r.sessionId,
      channel: r.channel ?? BACKLOG_MAIN_CHANNEL,
      role: r.role as BacklogChatMessage['role'],
      kind: (r.kind ?? undefined) as BacklogChatMessage['kind'],
      text: r.text,
      questionId: r.questionId ?? undefined,
      options: Array.isArray(r.options)
        ? (r.options as unknown[]).map((o) => String(o))
        : undefined,
      proposal: r.proposal
        ? this.ensureStoryIds(r.proposal as unknown as BacklogProposal)
        : undefined,
      ts: r.ts.getTime(),
    };
  }
}
