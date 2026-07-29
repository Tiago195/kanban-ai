import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { AssigneesService } from './assignees.service';

@Controller('assignees')
export class AssigneesController {
  constructor(private readonly assignees: AssigneesService) {}

  @Get()
  findAll(@Query('boardId') boardId?: string) {
    return this.assignees.findAll(boardId);
  }

  @Post()
  create(@Body() body: { boardId: string; name: string; model?: string }) {
    return this.assignees.create(body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.assignees.remove(id);
  }
}
