import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { BranchSessionStatus } from '../constants/branch-session-status';

type Tx = Prisma.TransactionClient;

@Injectable()
export class BranchFinanceSessionGateService {
  private readonly logger = new Logger(BranchFinanceSessionGateService.name);

  constructor(private readonly prisma: PrismaService) {}

  private toRecordDate(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  /**
   * Operational cash postings require an OPEN session for the Manila business date.
   * Locks the session row when present so close/start flows serialize with postings.
   */
  async assertOperationalPostingAllowed(
    tx: Tx,
    branchId: string,
    businessDateStr: string,
  ): Promise<void> {
    const date = this.toRecordDate(businessDateStr);

    await tx.$executeRaw`
      SELECT id FROM branch_business_sessions
      WHERE branch_id = ${branchId}::uuid AND business_date = ${date}::date
      FOR UPDATE
    `;

    const row = await tx.branch_business_sessions.findUnique({
      where: {
        branch_id_business_date: { branch_id: branchId, business_date: date },
      },
      select: { status: true },
    });

    if (row?.status === BranchSessionStatus.OPEN) {
      return;
    }

    this.logger.warn(
      `Blocked operational cash for branch=${branchId} date=${businessDateStr} session=${row?.status ?? 'MISSING'}`,
    );

    throw new ForbiddenException({
      code: 'BRANCH_FINANCE_SESSION_BLOCKED',
      message:
        'This branch business day is not open for cash transactions. Submit starting balance for the new business day or wait until the branch day opens.',
      sessionStatus: row?.status ?? 'MISSING',
      businessDate: businessDateStr,
    });
  }
}
