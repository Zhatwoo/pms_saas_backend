import { Controller, Get, Query, Req } from '@nestjs/common';
import { ReportsService } from '../services/reports.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('system')
  getSystemReport(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
    @Query('period') period?: string,
  ) {
    return this.reportsService.getSystemReport(req.user, branch, period);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get('branch-summary')
  getBranchSummary(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
    @Query('period') period?: string,
  ) {
    return this.reportsService.getBranchSummary(req.user, branch, period);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('transactions')
  getTransactionReport(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
    @Query('period') period?: string,
  ) {
    return this.reportsService.getTransactionReport(req.user, branch, period);
  }
}
