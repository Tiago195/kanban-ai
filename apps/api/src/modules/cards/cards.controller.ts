import { Body, Controller, Get, Param, Post, Query, UsePipes } from '@nestjs/common';
import { CardsService } from './cards.service';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import { createCardSchema, type CreateCardDto } from './cards.schema';

@Controller('cards')
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  findAll(@Query('boardId') boardId?: string) {
    return this.cards.findAll(boardId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.cards.findOne(id);
  }

  @Post()
  @UsePipes(new ZodValidationPipe(createCardSchema))
  create(@Body() dto: CreateCardDto) {
    return this.cards.create(dto);
  }
}
