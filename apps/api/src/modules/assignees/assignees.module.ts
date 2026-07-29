import { Module } from '@nestjs/common';
import { AssigneesController } from './assignees.controller';
import { AssigneesService } from './assignees.service';

@Module({
  controllers: [AssigneesController],
  providers: [AssigneesService],
  exports: [AssigneesService],
})
export class AssigneesModule {}
