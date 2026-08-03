import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
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

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { loopProfileId?: string | null; name?: string; color?: string }) {
    return this.labels.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.labels.remove(id);
  }
}
