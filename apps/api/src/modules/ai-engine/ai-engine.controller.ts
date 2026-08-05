import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { AgentChatMessage } from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { Orchestrator } from './orchestrator';
import { stopAutoSchema, answerSchema, type StopAutoDto, type AnswerDto } from './ai-engine.schema';

/**
 * Endpoints REST do loop engine (fatia 3). Rotas sob o recurso card, mas em
 * controller dedicado (decisão de arquitetura — mais coeso que inflar o
 * CardsController). Disparam o orchestrator server-side.
 */
@Controller('cards')
export class AiEngineController {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly prisma: PrismaService,
  ) {}

  /** Executa 1 iteração (passo manual). O id é o da STORY. */
  @Post(':id/loop/step')
  async step(@Param('id') id: string): Promise<{ ran: boolean }> {
    await this.ensureStory(id);
    const ran = await this.orchestrator.stepOnce(id);
    return { ran };
  }

  /** Inicia o auto-play server-side de uma story. */
  @Post(':id/loop/auto/start')
  async startAuto(@Param('id') id: string): Promise<{ running: boolean }> {
    await this.ensureStory(id);
    if (!this.orchestrator.loopState(id).session) {
      await this.orchestrator.onStoryEnterInProgress(id);
    } else {
      this.orchestrator.startAuto(id);
    }
    return { running: this.orchestrator.isAutoRunning(id) };
  }

  /** Para o auto-play (graceful termina o passo atual; hard aborta). */
  @Post(':id/loop/auto/stop')
  async stopAuto(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(stopAutoSchema)) dto: StopAutoDto,
  ): Promise<{ running: boolean }> {
    await this.ensureStory(id);
    await this.orchestrator.stop(id, dto.mode);
    return { running: this.orchestrator.isAutoRunning(id) };
  }

  /** Estado do loop de uma story. */
  @Get(':id/loop/state')
  async state(@Param('id') id: string) {
    await this.ensureStory(id);
    return this.orchestrator.loopState(id);
  }

  /** #8: métricas de qualidade do loop de uma story (agregadas sobre as tasks). */
  @Get(':id/loop/metrics')
  async metrics(@Param('id') id: string) {
    await this.ensureStory(id);
    return this.orchestrator.computeStoryMetrics(id);
  }

  /**
   * HITL: responde à pergunta pendente de uma story (o id é o da STORY). A
   * resposta é encaminhada ao subprocesso via stdin, retomando a iteração.
   */
  @Post(':id/loop/answer')
  async answer(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(answerSchema)) dto: AnswerDto,
  ): Promise<{ accepted: boolean }> {
    await this.ensureStory(id);
    const accepted = await this.orchestrator.answerQuestion(id, dto.questionId, dto.answer);
    if (!accepted) {
      throw new NotFoundException('nenhuma pergunta pendente para essa story/questionId');
    }
    return { accepted };
  }

  /**
   * Histórico persistido do chat de uma TASK (id = taskId). Reidrata o
   * transcript ao abrir a task, mesclando depois com os chunks ao vivo (WS).
   * Ordenado por `ts` ascendente para render cronológico direto.
   */
  @Get(':id/chat')
  async chat(@Param('id') id: string): Promise<AgentChatMessage[]> {
    await this.ensureTask(id);
    const rows = await this.prisma.agentMessage.findMany({
      where: { cardId: id },
      orderBy: { ts: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      role: r.role as AgentChatMessage['role'],
      kind: (r.kind ?? undefined) as AgentChatMessage['kind'],
      phase: (r.phase ?? undefined) as AgentChatMessage['phase'],
      text: r.text,
      questionId: r.questionId ?? undefined,
      options: Array.isArray(r.options)
        ? (r.options as unknown[]).map((o) => String(o))
        : undefined,
      ts: r.ts.getTime(),
    }));
  }

  private async ensureStory(id: string): Promise<void> {
    const card = await this.prisma.card.findUnique({
      where: { id },
      select: { type: true },
    });
    if (!card) throw new NotFoundException('card inexistente');
    if (card.type !== 'story') {
      throw new NotFoundException('o loop opera sobre stories');
    }
  }

  private async ensureTask(id: string): Promise<void> {
    const card = await this.prisma.card.findUnique({
      where: { id },
      select: { type: true },
    });
    if (!card) throw new NotFoundException('card inexistente');
    if (card.type !== 'task') {
      throw new NotFoundException('o chat opera sobre tasks');
    }
  }
}
