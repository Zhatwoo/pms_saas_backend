import { Controller, Get } from '@nestjs/common';
import { ReportsService } from '../services/reports.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Roles(Role.SUPER_ADMIN)
  @Get('system')
  getSystemReport() {
    return this.reportsService.getSystemReport();
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Get('branch-summary')
  getBranchSummary() {
    return this.reportsService.getBranchSummary();
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.EMPLOYEE)
  @Get('transactions')
  getTransactionReport() {
    return this.reportsService.getTransactionReport();
  }
}
