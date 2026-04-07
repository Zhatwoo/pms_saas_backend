import { Controller, Get } from '@nestjs/common';
import { ReportsService } from '../services/reports.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Roles(Role.SUPERADMIN)
  @Get('system')
  getSystemReport() {
    return this.reportsService.getSystemReport();
  }

  @Roles(Role.SUPERADMIN, Role.ADMIN)
  @Get('branch-summary')
  getBranchSummary() {
    return this.reportsService.getBranchSummary();
  }

  @Roles(Role.SUPERADMIN, Role.ADMIN, Role.BRANCH)
  @Get('transactions')
  getTransactionReport() {
    return this.reportsService.getTransactionReport();
  }
}
