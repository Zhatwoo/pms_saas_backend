import { Controller, Get, Post, Query, Req, Body, Param } from '@nestjs/common';
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
    @Query('period') period?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.dashboardService.getPawnKpis(req.user, branch, period, startDate, endDate);
  }

  @Get('expiration-monitoring')
  getExpirationMonitoring(
    @Req() req: { user: AuthenticatedUserProfile },
    @Query('branch') branch?: string,
  ) {
    return this.dashboardService.getExpirationMonitoring(req.user, branch);
  }

  @Post('expiration-monitoring/email-blast')
  async emailBlast(
    @Req() req: { user: AuthenticatedUserProfile },
    @Body() body: { bucket: string },
    @Query('branch') branch?: string
  ) {
    return this.dashboardService.sendExpirationEmailBlast(
      req.user,
      body?.bucket,
      branch,
    );
  }

  @Post('expiration-monitoring/:id/send-email')
  async sendEmail(
    @Req() req: { user: AuthenticatedUserProfile },
    @Param('id') id: string,
    @Query('branch') branch?: string,
  ) {
    return this.dashboardService.sendExpirationReminder(req.user, id, branch);
  }
}
