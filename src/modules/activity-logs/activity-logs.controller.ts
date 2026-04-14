import { Controller, Get, UseGuards, Request, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { ActivityLogsService } from './activity-logs.service';

@Controller('activity-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ActivityLogsController {
  constructor(private readonly activityLogsService: ActivityLogsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN) // Include admin so they can view branch logs 
  async getLogs(@Request() req: any, @Query('branchId') qBranchId?: string) {
    const user = req.user; // contains id, role, branchId
    
    // Normalize role string format to match DB if needed
    const roleNorm = user.role.toLowerCase();
    
    if (roleNorm === 'admin') {
      return this.activityLogsService.getLogs(user.branchId, 'admin');
    }
    
    // For superadmin, they can filter by branchId or get all
    return this.activityLogsService.getLogs(qBranchId, 'super_admin');
  }
}
