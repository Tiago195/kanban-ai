import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type {
  BacklogAppliedCard,
  BacklogChatMessage,
  BacklogChatSessionSummary,
  BacklogProposal,
  StoryChatSession,
} from '@kanban-ai/shared';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { BacklogChatOrchestrator } from './backlog-chat.orchestrator';
import {
  backlogAnswerSchema,
  backlogApplySchema,
  backlogMessageSchema,
  createBacklogSessionSchema,
  materializeStoryTasksSchema,
  resolveStoryCardSchema,
  type BacklogAnswerDto,
  type BacklogApplyDto,
  type BacklogMessageDto,
  type CreateBacklogSessionDto,
  type MaterializeStoryTasksDto,
  type ResolveStoryCardDto,
} from './backlog-chat.schema';

/**
 * Endpoints do ecossistema "Chat de criação de Épicos/Histórias".
 *
 * O turno de conversa é síncrono do ponto de vista do disparo (POST /messages
 * resolve quando a AI termina de responder ou faz uma pergunta), mas o
 * streaming e as propostas chegam ao front via WebSocket (`backlog.*`).
 */
@Controller('backlog-chat/sessions')
export class BacklogChatController {
  constructor(private readonly orchestrator: BacklogChatOrchestrator) {}

  /** Cria uma nova sessão de chat de backlog. */
  @Post()
  create(
    @Body(new ZodValidationPipe(createBacklogSessionSchema))
    dto: CreateBacklogSessionDto,
  ): Promise<{ id: string; title: string }> {
    return this.orchestrator.createSession(dto.boardId);
  }

  /** Lista as sessões de um board (mais recentes primeiro) para retomar conversas. */
  @Get()
  list(@Query('boardId') boardId: string): Promise<BacklogChatSessionSummary[]> {
    if (!boardId) throw new NotFoundException('boardId é obrigatório');
    return this.orchestrator.listSessions(boardId);
  }

  /** Transcript persistido da sessão (reidrata o chat no F5). */
  @Get(':cid/messages')
  messages(
    @Param('cid') cid: string,
    @Query('channel') channel?: string,
  ): Promise<BacklogChatMessage[]> {
    return this.orchestrator.getMessages(cid, channel);
  }

  /** Envia uma mensagem do humano; dispara um turno da AI. */
  @Post(':cid/messages')
  async send(
    @Param('cid') cid: string,
    @Body(new ZodValidationPipe(backlogMessageSchema)) dto: BacklogMessageDto,
  ): Promise<{ ok: true }> {
    await this.orchestrator.sendMessage(cid, dto.text, dto.channel);
    return { ok: true };
  }

  /** Responde a uma pergunta de descoberta pendente (HITL). */
  @Post(':cid/answer')
  async answer(
    @Param('cid') cid: string,
    @Body(new ZodValidationPipe(backlogAnswerSchema)) dto: BacklogAnswerDto,
  ): Promise<{ accepted: boolean }> {
    const accepted = await this.orchestrator.answerQuestion(cid, dto.questionId, dto.answer);
    if (!accepted) {
      throw new NotFoundException('nenhuma pergunta pendente para essa sessão/questionId');
    }
    return { accepted };
  }

  /** Proposta corrente (maior versão), ou null se ainda em descoberta. */
  @Get(':cid/proposal')
  proposal(@Param('cid') cid: string): Promise<BacklogProposal | null> {
    return this.orchestrator.getCurrentProposal(cid);
  }

  /** Aprova e materializa a proposta: cria Epic + Stories no board. */
  @Post(':cid/apply')
  apply(
    @Param('cid') cid: string,
    @Body(new ZodValidationPipe(backlogApplySchema)) dto: BacklogApplyDto,
  ): Promise<{ cards: BacklogAppliedCard[] }> {
    return this.orchestrator.apply(cid, dto.version);
  }

  /**
   * Resolve o card `type:story` do board materializado por esta sessão (já
   * applied), casando pelo título da story da proposta. Habilita o redirect da
   * thread da proposta para o "chat da story", onde a materialização de tasks
   * cria cards de verdade (fecha o bug de "tasks fantasma"). Retorna 404 se
   * nenhuma story-card correspondente existir.
   */
  @Post(':cid/story-card')
  async resolveStoryCard(
    @Param('cid') cid: string,
    @Body(new ZodValidationPipe(resolveStoryCardSchema)) dto: ResolveStoryCardDto,
  ): Promise<StoryChatSession> {
    const resolved = await this.orchestrator.resolveAppliedStoryCard(cid, dto.title);
    if (!resolved) throw new NotFoundException('story-card não encontrada para esta sessão');
    return resolved;
  }
}

/**
 * Endpoints do "chat da story" (ADR-0026) — ancorados numa story-card do board,
 * não numa sessão. Reusam o `BacklogChatOrchestrator`.
 */
@Controller('backlog-chat/story')
export class BacklogStoryChatController {
  constructor(private readonly orchestrator: BacklogChatOrchestrator) {}

  /**
   * Abre (ou reusa) a sessão de chat de uma story. Reusa a sessão original se a
   * story veio de um backlog-chat; cria uma sessão zerada e vincula se a story é
   * manual. Ver ADR-0026.
   */
  @Post(':storyId/session')
  openSession(@Param('storyId') storyId: string): Promise<StoryChatSession> {
    return this.orchestrator.openStorySession(storyId);
  }

  /**
   * Materializa tasks rascunhadas no chat da story como cards `type:task` filhos
   * em To Do. Limpa `needsHuman` da story ao criar ≥1 task. Ver ADR-0026.
   */
  @Post(':storyId/tasks')
  materializeTasks(
    @Param('storyId') storyId: string,
    @Body(new ZodValidationPipe(materializeStoryTasksSchema)) dto: MaterializeStoryTasksDto,
  ): Promise<{ cards: BacklogAppliedCard[] }> {
    return this.orchestrator.materializeStoryTasks(storyId, dto.tasks);
  }
}
