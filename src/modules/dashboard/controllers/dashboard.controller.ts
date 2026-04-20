import { Controller, Get, Query, Req } from '@nestjs/common';
import { DashboardService } from '../services/dashboard.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  getDashboard(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.dashboardService.getDashboard(req.user);
  }

  @Get('pawn-kpis')
  getPawnKpis(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
  ) {
    return this.dashboardService.getPawnKpis(req.user, branch);
  }

  @Get('expiration-monitoring')
  getExpirationMonitoring(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
  ) {
    return this.dashboardService.getExpirationMonitoring(req.user, branch);
  }
}
