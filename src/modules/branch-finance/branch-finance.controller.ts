import { Controller, Get, Post, Body, Query, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';
import { BranchFinanceService } from './branch-finance.service';
import { ConfirmDailyBalanceDto } from './dto/confirm-daily-balance.dto';
import { EndBranchDayDto } from './dto/end-branch-day.dto';

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
  @Get('business-session')
  getBusinessSession(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
  ) {
    return this.branchFinanceService.getBusinessSession(req.user, branch);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('end-day')
  endBranchDay(
    @Req() req: { user: AuthenticatedUserProfile; ip?: string; headers?: Record<string, unknown> },
    @Body() body: EndBranchDayDto,
  ) {
    return this.branchFinanceService.endBranchDay(req.user, body, {
      ipAddress: req.ip ?? null,
      userAgent:
        typeof req.headers?.['user-agent'] === 'string'
          ? req.headers['user-agent']
          : null,
    });
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('daily-balance')
  confirmDailyBalance(
    @Req() req: { user: AuthenticatedUserProfile; ip?: string; headers?: Record<string, unknown> },
    @Body() body: ConfirmDailyBalanceDto,
  ) {
    return this.branchFinanceService.confirmDailyBalance(
      req.user,
      body.type,
      body.amount,
      {
        ipAddress: req.ip ?? null,
        userAgent:
          typeof req.headers?.['user-agent'] === 'string'
            ? req.headers['user-agent']
            : null,
      },
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

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @SkipThrottle()
  @Get('daily-opening/status')
  getDailyOpeningStatus(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.branchFinanceService.getEmployeeDailyOpeningStatus(req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Post('daily-opening/complete')
  completeDailyOpening(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.branchFinanceService.completeEmployeeDailyOpening(req.user);
  }
}
