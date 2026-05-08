import { Controller, Get, Post, Body, Query, Req } from '@nestjs/common';
import { Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';
import { BranchFinanceService } from './branch-finance.service';
import { ConfirmDailyBalanceDto } from './dto/confirm-daily-balance.dto';

@Controller('branch-finance')
export class BranchFinanceController {
  constructor(private readonly branchFinanceService: BranchFinanceService) {}

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('summary')
  getSummary(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
  ) {
    return this.branchFinanceService.getSummary(req.user, branch);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('ledger')
  getLedger(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.branchFinanceService.getLedger(req.user, {
      branch,
      dateFrom,
      dateTo,
      type,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('daily-balance')
  confirmDailyBalance(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() body: ConfirmDailyBalanceDto,
  ) {
    return this.branchFinanceService.confirmDailyBalance(
      req.user,
      body.type,
      body.amount,
    );
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('latest-balance')
  getLatestBalance(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
  ) {
    return this.branchFinanceService.getLatestBalance(req.user, branch);
  }

  @Roles(Role.EMPLOYEE)
  @Get('daily-opening/status')
  getDailyOpeningStatus(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.branchFinanceService.getEmployeeDailyOpeningStatus(req.user);
  }

  @Roles(Role.EMPLOYEE)
  @Post('daily-opening/complete')
  completeDailyOpening(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.branchFinanceService.completeEmployeeDailyOpening(req.user);
  }
}
