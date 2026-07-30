import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { Orchestrator } from './orchestrator';
import { stopAutoSchema, type StopAutoDto } from './ai-engine.schema';

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
}
