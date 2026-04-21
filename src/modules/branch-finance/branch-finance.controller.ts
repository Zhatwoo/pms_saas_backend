import { Controller, Get, Query, Req } from '@nestjs/common';
import { Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import type { AuthenticatedUserProfile } from '../../infrastructure/supabase/supabase.service';
import { BranchFinanceService } from './branch-finance.service';

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
}
