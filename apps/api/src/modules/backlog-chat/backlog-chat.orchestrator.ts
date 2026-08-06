import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  BacklogChatMessage,
  BacklogChatSessionSummary,
  BacklogChatSessionStatus,
  BacklogProposal,
  BacklogProposalPatch,
  BacklogProposalStory,
  BacklogAppliedCard,
} from '@kanban-ai/shared';
import { BACKLOG_MAIN_CHANNEL, parseBacklogStoryChannel } from '@kanban-ai/shared';
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
 * Orquestra o chat de criação de backlog (Epic + Stories).
 *
 * Diferente do loop engine (autônomo, iterativo), aqui cada turno é disparado
 * por uma mensagem do humano: monta o prompt (persona PO + histórico), invoca a
 * `BacklogCliRunner`, transmite chunks via WS, trata perguntas de descoberta
 * (HITL) e materializa a proposta/patch como revisão versionada. Nada cria
 * cards — só o `apply()` (server-side, via `CardsService`).
 */
@Injectable()
export class BacklogChatOrchestrator {
  private readonly logger = new Logger(BacklogChatOrchestrator.name);
  /** Perguntas HITL pendentes por sessão. */
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly runner: BacklogCliRunner,
    private readonly cards: CardsService,
  ) {}

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
    // Caminho rápido: promise viva no mesmo processo.
    const p = this.pending.get(sessionId);
    if (p && p.questionId === questionId) {
      clearTimeout(p.timer);
      this.pending.delete(sessionId);
      p.resolve(answer);
      return true;
    }

    // Caminho de resiliência: a pergunta existe no histórico persistido e ainda
    // não foi respondida, mas não há turno vivo esperando (restart). Retoma.
    const question = await this.prisma.backlogChatMessage.findFirst({
      where: { sessionId, role: 'ai', questionId },
    });
    if (!question) return false;
    const alreadyAnswered = await this.prisma.backlogChatMessage.findFirst({
      where: { sessionId, role: 'user', questionId },
    });
    if (alreadyAnswered) return false;

    const session = await this.ensureSession(sessionId);

    // Persiste a resposta humana (marcando-a como resposta desta pergunta) no
    // MESMO canal (thread) da pergunta — assim a resposta fica na thread certa.
    const channel = question.channel ?? BACKLOG_MAIN_CHANNEL;
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
    this.logger.log(
      `HITL retomado após restart (sessão ${sessionId}, pergunta ${questionId})`,
    );
    void this.runTurn(sessionId, session.boardId, answer, channel).catch((err) => {
      this.logger.error(
        `runTurn (retomada HITL) falhou (sessão ${sessionId}): ${String(err)}`,
      );
    });
    return true;
  }

  private async runTurn(
    sessionId: string,
    boardId: string,
    userText: string,
    channel: string = BACKLOG_MAIN_CHANNEL,
  ): Promise<void> {
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

    const prompt = buildBacklogPrompt({
      boardTitle: board?.title ?? '(board)',
      history,
      userText,
      currentProposalJson: current
        ? JSON.stringify(current, null, 2)
        : undefined,
      focusStory,
    });

    // Buffer de consolidação de chunks (persiste o transcript por kind).
    let chunkBuffer: { kind: 'thought' | 'output'; text: string } | null = null;
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
              this.realtime.broadcast({
                type: 'backlog.answered',
                sessionId,
                channel,
                questionId,
              });
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
        },
      });
    } finally {
      await flushChunk();
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
    const epic = await this.cards.create({
      boardId: session.boardId,
      type: 'epic',
      title: proposal.epic.title,
      description: proposal.epic.description ?? '',
      points: proposal.epic.points,
      parentId: null,
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
          description: '',
          parentId: s.id,
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
      .filter((r) => r.kind !== 'proposal') // proposta vai via currentProposalJson
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
