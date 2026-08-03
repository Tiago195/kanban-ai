import { Module } from '@nestjs/common';
import { LoopProfilesController } from './loop-profiles.controller';
import { LoopProfilesService } from './loop-profiles.service';

@Module({
  controllers: [LoopProfilesController],
  providers: [LoopProfilesService],
  exports: [LoopProfilesService],
})
export class LoopProfilesModule {}
