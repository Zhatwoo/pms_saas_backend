import { Controller, Get, Req } from '@nestjs/common';
import { DashboardService } from '../services/dashboard.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  getDashboard(@Req() req: { user: AuthenticatedUserProfile }) {
    return this.dashboardService.getDashboard(req.user);
  }
}
