import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../infrastructure/supabase/supabase.module';
import { BranchFinanceController } from './branch-finance.controller';
import { BranchFinanceService } from './branch-finance.service';
import { FinanceAuditService } from './services/finance-audit.service';
import { FinanceDailyBalanceService } from './services/finance-daily-balance.service';
import { BranchBusinessSessionService } from './services/branch-business-session.service';
import { BranchFinanceSessionGateService } from './services/branch-finance-session-gate.service';
import { BranchDaySessionService } from './services/branch-day-session.service';
import { OpeningChecklistGateService } from './services/opening-checklist-gate.service';

import { BranchFinanceEndDayCronService } from './branch-finance-end-day.cron';

@Module({
  imports: [SupabaseModule],
  controllers: [BranchFinanceController],
  providers: [
    BranchFinanceSessionGateService,
    FinanceDailyBalanceService,
    BranchDaySessionService,
    BranchBusinessSessionService,
    BranchFinanceService,
    FinanceAuditService,
    BranchFinanceEndDayCronService,
    OpeningChecklistGateService,
  ],
  exports: [
    BranchFinanceService,
    BranchDaySessionService,
    FinanceDailyBalanceService,
    FinanceAuditService,
    BranchBusinessSessionService,
    OpeningChecklistGateService,
  ],
})
export class BranchFinanceModule {}
