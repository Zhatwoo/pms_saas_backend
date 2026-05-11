import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FinanceAuditService } from './services/finance-audit.service';
import { BranchDaySessionService } from './services/branch-day-session.service';

/**
 * At 00:00 Asia/Manila: close branch_day_sessions rows before today's Manila date that are still open.
 */
@Injectable()
export class BranchFinanceEndDayCronService {
  private readonly logger = new Logger(BranchFinanceEndDayCronService.name);

  constructor(
    private readonly branchDaySessions: BranchDaySessionService,
    private readonly financeAudit: FinanceAuditService,
  ) {}

  @Cron('0 0 * * *', { timeZone: 'Asia/Manila' })
  async handleManilaMidnight() {
    this.logger.log('Running Manila midnight branch day-session sweep…');

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
          `Manila midnight sweep closed ${rows.length} stale branch day session(s).`,
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`BranchFinance midnight job failed: ${msg}`);
    }

    this.logger.log('Manila midnight branch day-session sweep finished.');
  }
}
