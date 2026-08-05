import { Module } from '@nestjs/common';
import { BacklogChatController } from './backlog-chat.controller';
import { BacklogChatOrchestrator } from './backlog-chat.orchestrator';
import { BacklogCliRunner } from './runner/backlog-cli.runner';
import { CardsModule } from '../cards/cards.module';

/**
 * Módulo do ecossistema "Chat de criação de Épicos/Histórias".
 *
 * Separado do loop engine (ai-engine): a semântica de conversa/proposta é
 * distinta da execução de tasks. Reusa o transporte JSONL da CLI (runner
 * próprio) e o `CardsService` (executor seguro) para materializar o backlog.
 */
@Module({
  imports: [CardsModule],
  controllers: [BacklogChatController],
  providers: [BacklogChatOrchestrator, BacklogCliRunner],
  exports: [BacklogChatOrchestrator],
})
export class BacklogChatModule {}
