import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getPhCalendarDateString } from '../../common/utils/branch-calendar-date.util';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FinanceAuditService } from './services/finance-audit.service';
import { BranchBusinessSessionService } from './services/branch-business-session.service';

/**
 * At 00:00 Asia/Manila: auto-close any branch whose prior calendar session is still OPEN (idempotent if manual end ran earlier).
 */
@Injectable()
export class BranchFinanceEndDayCronService {
  private readonly logger = new Logger(BranchFinanceEndDayCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly branchSessions: BranchBusinessSessionService,
    private readonly financeAudit: FinanceAuditService,
  ) {}

  @Cron('0 0 * * *', { timeZone: 'Asia/Manila' })
  async handleManilaMidnight() {
    this.logger.log('Running Manila midnight branch end-day sweep…');

    const branches = await this.prisma.branches.findMany({
      where: { status: 'Active' },
      select: { id: true },
    });

    const todayStr = getPhCalendarDateString();

    for (const b of branches) {
      try {
        const r = await this.branchSessions.endBranchDayAutoForYesterday(b.id);
        if (r.closureApplied) {
          await this.financeAudit.log({
            branchId: b.id,
            userId: null,
            eventType: 'BRANCH_DAY_END_AUTO',
            payload: {
              businessDate: r.yesterdayStr,
              endingBalance: r.endingBalance,
            },
          });
        }
        await this.branchSessions.ensureSessionRowForManilaDate(b.id, todayStr);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `BranchFinance midnight job failed for branch=${b.id}: ${msg}`,
        );
      }
    }

    this.logger.log('Manila midnight branch end-day sweep finished.');
  }
}
