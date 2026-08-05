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
} from '@kanban-ai/shared';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { BacklogChatOrchestrator } from './backlog-chat.orchestrator';
import {
  backlogAnswerSchema,
  backlogApplySchema,
  backlogMessageSchema,
  createBacklogSessionSchema,
  type BacklogAnswerDto,
  type BacklogApplyDto,
  type BacklogMessageDto,
  type CreateBacklogSessionDto,
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
}
