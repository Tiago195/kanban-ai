import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { BoardsService } from './boards.service';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import {
  setBoardAdapterSchema,
  setBoardModelSchema,
  setBoardProjectSchema,
  type SetBoardAdapterDto,
  type SetBoardModelDto,
  type SetBoardProjectDto,
} from './boards.schema';

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

  /** US-F3.10 — define (null limpa) o adapter default do quadro (cascata). */
  @Patch(':id/adapter')
  setDefaultAdapter(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setBoardAdapterSchema)) dto: SetBoardAdapterDto,
  ) {
    return this.boards.setDefaultAdapter(id, dto.defaultAdapter);
  }

  /** EP-PROJECT / US-PROJ6 — associa (null desassocia) o Project do quadro. */
  @Patch(':id/project')
  setProjectId(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setBoardProjectSchema)) dto: SetBoardProjectDto,
  ) {
    return this.boards.setProjectId(id, dto.projectId);
  }
}
