import { Controller, Get, Post, Body, Param, Query, Req } from '@nestjs/common';
import { TransactionsService } from '../services/transactions.service';
import { CreateTransactionDto } from '../dto/create-transaction.dto';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post()
  create(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() createTransactionDto: CreateTransactionDto,
  ) {
    return this.transactionsService.create(
      req.user,
      createTransactionDto as any,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get()
  findAll(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
    @Query('date') date?: string,
    @Query('range') range?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.transactionsService.findAll(
      req.user,
      branch,
      date,
      range,
      customerId,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get(':id')
  findOne(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
  ) {
    return this.transactionsService.findOne(req.user, id);
  }
}
