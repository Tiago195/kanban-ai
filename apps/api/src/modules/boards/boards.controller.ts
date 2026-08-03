import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { BoardsService } from './boards.service';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { setBoardModelSchema, type SetBoardModelDto } from './boards.schema';

@Controller('boards')
export class BoardsController {
  constructor(private readonly boards: BoardsService) {}

  @Get()
  findAll() {
    return this.boards.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.boards.findOne(id);
  }

  @Patch(':id/model')
  setDefaultModel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setBoardModelSchema)) dto: SetBoardModelDto,
  ) {
    return this.boards.setDefaultModel(id, dto.defaultModel);
  }
}
