import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { LabelsService } from './labels.service';

@Controller('labels')
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  @Get()
  findAll(@Query('boardId') boardId?: string) {
    return this.labels.findAll(boardId);
  }

  @Post()
  create(
    @Body() body: { boardId: string; name: string; color?: string; loopProfileId?: string },
  ) {
    return this.labels.create(body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.labels.remove(id);
  }
}
