import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { TransactionsService } from '../services/transactions.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post()
  create(@Body() createTransactionDto: any) {
    return this.transactionsService.create(createTransactionDto);
  }

  @Get()
  findAll(@Query('branch') branch?: string) {
    return this.transactionsService.findAll(branch);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.transactionsService.findOne(id);
  }
}

