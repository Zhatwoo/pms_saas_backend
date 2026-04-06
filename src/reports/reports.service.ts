import { Injectable } from '@nestjs/common';

@Injectable()
export class ReportsService {
  getSystemReport() {
    return { message: 'System-wide report — superadmin only' };
  }

  getBranchSummary() {
    return { message: 'Branch summary report' };
  }

  getTransactionReport() {
    return { message: 'Transaction report' };
  }
}
