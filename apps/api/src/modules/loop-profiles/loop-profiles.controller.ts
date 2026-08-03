import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { ValidationStrategy } from '@kanban-ai/shared';
import { LoopProfilesService } from './loop-profiles.service';

@Controller('loop-profiles')
export class LoopProfilesController {
  constructor(private readonly loopProfiles: LoopProfilesService) {}

  @Get()
  findAll(@Query('boardId') boardId?: string) {
    return this.loopProfiles.findAll(boardId);
  }

  @Post()
  create(
    @Body()
    body: {
      boardId: string;
      name: string;
      description?: string;
      phases?: string[];
      validation?: ValidationStrategy;
      firstStep?: string;
    },
  ) {
    return this.loopProfiles.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      phases?: string[];
      validation?: ValidationStrategy;
      firstStep?: string;
    },
  ) {
    return this.loopProfiles.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.loopProfiles.remove(id);
  }
}
