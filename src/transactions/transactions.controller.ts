import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { Roles } from '../common/decorators';
import { Role } from '../common/enums';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Roles(Role.ADMIN, Role.BRANCH)
  @Post()
  create(@Body() createTransactionDto: any) {
    return this.transactionsService.create(createTransactionDto);
  }

  @Get()
  findAll() {
    return this.transactionsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.transactionsService.findOne(id);
  }
}
