import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FinanceAuditService } from './services/finance-audit.service';
import { BranchDaySessionService } from './services/branch-day-session.service';

/**
 * At 18:00 Asia/Manila: close open branch_day_sessions for the current Manila business date.
 */
@Injectable()
export class BranchFinanceEndDayCronService {
  private readonly logger = new Logger(BranchFinanceEndDayCronService.name);

  constructor(
    private readonly branchDaySessions: BranchDaySessionService,
    private readonly financeAudit: FinanceAuditService,
  ) {}

  @Cron('0 18 * * *', { timeZone: 'Asia/Manila' })
  async handleManilaSixPm() {
    this.logger.log('Running Manila 6 PM branch day-session sweep…');

    try {
      const rows = await this.branchDaySessions.autoCloseStaleOpenSessions();
      for (const r of rows) {
        await this.financeAudit.log({
          branchId: r.branchId,
          userId: null,
          eventType: 'BRANCH_DAY_END_AUTO',
          payload: {
            businessDate: r.businessDate,
            endingBalance: r.endingBalance,
          },
        });
      }
      if (rows.length > 0) {
        this.logger.log(
          `Manila 6 PM sweep closed ${rows.length} branch day session(s).`,
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`BranchFinance 6 PM job failed: ${msg}`);
    }

    this.logger.log('Manila 6 PM branch day-session sweep finished.');
  }
}
