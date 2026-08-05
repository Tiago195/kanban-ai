import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { CardsService } from './cards.service';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import {
  attachAssigneeSchema,
  attachLabelSchema,
  createCardSchema,
  createCommentSchema,
  createDependencySchema,
  createDodItemSchema,
  createFlowSchema,
  moveCardSchema,
  updateCardSchema,
  updateDodItemSchema,
  type AttachAssigneeDto,
  type AttachLabelDto,
  type CreateCardDto,
  type CreateCommentDto,
  type CreateDependencyDto,
  type CreateDodItemDto,
  type CreateFlowDto,
  type MoveCardDto,
  type UpdateCardDto,
  type UpdateDodItemDto,
} from './cards.schema';

@Controller()
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get('cards')
  findAll(@Query('boardId') boardId?: string) {
    return this.cards.findAll(boardId);
  }

  @Get('cards/:id')
  findOne(@Param('id') id: string) {
    return this.cards.findOne(id);
  }

  @Post('cards')
  @UsePipes(new ZodValidationPipe(createCardSchema))
  create(@Body() dto: CreateCardDto) {
    return this.cards.create(dto);
  }

  @Patch('cards/:id/move')
  move(@Param('id') id: string, @Body(new ZodValidationPipe(moveCardSchema)) dto: MoveCardDto) {
    return this.cards.move(id, dto);
  }

  @Patch('cards/:id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCardSchema)) dto: UpdateCardDto,
  ) {
    return this.cards.update(id, dto);
  }

  @Delete('cards/:id')
  remove(@Param('id') id: string) {
    return this.cards.remove(id);
  }

  // ── DOD ──
  @Post('cards/:id/dod')
  addDod(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createDodItemSchema)) dto: CreateDodItemDto,
  ) {
    return this.cards.addDodItem(id, dto);
  }

  @Patch('dod/:itemId')
  updateDod(
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(updateDodItemSchema)) dto: UpdateDodItemDto,
  ) {
    return this.cards.updateDodItem(itemId, dto);
  }

  @Delete('dod/:itemId')
  removeDod(@Param('itemId') itemId: string) {
    return this.cards.removeDodItem(itemId);
  }

  // ── Labels ──
  @Post('cards/:id/labels')
  attachLabel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(attachLabelSchema)) dto: AttachLabelDto,
  ) {
    return this.cards.attachLabel(id, dto);
  }

  @Delete('cards/:id/labels/:labelId')
  detachLabel(@Param('id') id: string, @Param('labelId') labelId: string) {
    return this.cards.detachLabel(id, labelId);
  }

  // ── Assignees ──
  @Post('cards/:id/assignees')
  attachAssignee(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(attachAssigneeSchema)) dto: AttachAssigneeDto,
  ) {
    return this.cards.attachAssignee(id, dto);
  }

  @Delete('cards/:id/assignees/:assigneeId')
  detachAssignee(@Param('id') id: string, @Param('assigneeId') assigneeId: string) {
    return this.cards.detachAssignee(id, assigneeId);
  }

  // ── AffectedFlows ──
  @Post('cards/:id/flows')
  addFlow(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createFlowSchema)) dto: CreateFlowDto,
  ) {
    return this.cards.addFlow(id, dto);
  }

  @Delete('flows/:flowId')
  removeFlow(@Param('flowId') flowId: string) {
    return this.cards.removeFlow(flowId);
  }

  // ── Comments ──
  @Get('cards/:id/comments')
  listComments(@Param('id') id: string) {
    return this.cards.listComments(id);
  }

  @Post('cards/:id/comments')
  addComment(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createCommentSchema)) dto: CreateCommentDto,
  ) {
    return this.cards.addComment(id, dto);
  }

  // ── Task dependencies ──
  @Post('cards/:id/dependencies')
  addDependency(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createDependencySchema)) dto: CreateDependencyDto,
  ) {
    return this.cards.addDependency(id, dto);
  }

  @Delete('cards/:id/dependencies/:dependsOnId')
  removeDependency(@Param('id') id: string, @Param('dependsOnId') dependsOnId: string) {
    return this.cards.removeDependency(id, dependsOnId);
  }
}
