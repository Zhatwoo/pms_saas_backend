import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TransactionPurpose } from '../../../common/enums';
import {
  addManilaCalendarDays,
  getPhCalendarDateString,
} from '../../../common/utils/branch-calendar-date.util';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { BranchBusinessSessionSnapshot } from './branch-business-session.service';
import { FinanceDailyBalanceService } from './finance-daily-balance.service';

type Tx = Prisma.TransactionClient;

@Injectable()
export class BranchDaySessionService {
  private readonly logger = new Logger(BranchDaySessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly financeDailyBalance: FinanceDailyBalanceService,
  ) {}

  private toRecordDate(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  private formatBusinessDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private toDbTime(value: string): Date {
    return new Date(`1970-01-01T${value}.000Z`);
  }

  private dec(n: unknown): Prisma.Decimal {
    return new Prisma.Decimal(String(n ?? 0));
  }

  /**
   * Login flag: no Manila-day row yet, or same calendar day was explicitly ended.
   */
  async requiresStartingBalance(branchId: string): Promise<boolean> {
    const todayStr = getPhCalendarDateString();
    const todayDate = this.toRecordDate(todayStr);
    const row = await this.prisma.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: todayDate,
        },
      },
      select: { is_closed: true },
    });
    return !row || row.is_closed;
  }

  private async computeSuggestedStartingBalance(
    branchId: string,
    businessDateStr: string,
  ): Promise<number> {
    const priorStr = addManilaCalendarDays(businessDateStr, -1);
    const priorDate = this.toRecordDate(priorStr);
    const priorBal = await this.prisma.daily_balances.findUnique({
      where: {
        branch_id_record_date: {
          branch_id: branchId,
          record_date: priorDate,
        },
      },
      select: { ending_balance: true },
    });
    if (priorBal) {
      return Number(this.dec(priorBal.ending_balance).toFixed(2));
    }
    const b = await this.prisma.branches.findUnique({
      where: { id: branchId },
      select: { opening_cash_balance: true },
    });
    return Number(this.dec(b?.opening_cash_balance).toFixed(2));
  }

  async getSnapshot(branchId: string): Promise<BranchBusinessSessionSnapshot> {
    const manilaCalendarDate = getPhCalendarDateString();
    const todayDate = this.toRecordDate(manilaCalendarDate);

    const dayRow = await this.prisma.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: todayDate,
        },
      },
    });

    const needsStarting = !dayRow || dayRow.is_closed;
    const operationalCashAllowed = !!(dayRow && !dayRow.is_closed);

    let pendingStartingSession: BranchBusinessSessionSnapshot['pendingStartingSession'] =
      null;
    if (needsStarting) {
      pendingStartingSession = {
        businessDate: manilaCalendarDate,
        suggestedStartingBalance:
          await this.computeSuggestedStartingBalance(
            branchId,
            manilaCalendarDate,
          ),
      };
    }

    let todaySession: BranchBusinessSessionSnapshot['todaySession'] = null;
    if (dayRow) {
      const dbBal = await this.prisma.daily_balances.findUnique({
        where: {
          branch_id_record_date: {
            branch_id: branchId,
            record_date: todayDate,
          },
        },
        select: { ending_balance: true },
      });
      todaySession = {
        status: dayRow.is_closed ? 'CLOSED' : 'OPEN',
        businessDate: this.formatBusinessDate(dayRow.session_date),
        startingBalance: Number(this.dec(dayRow.starting_balance).toFixed(2)),
        endingBalance: dbBal
          ? Number(this.dec(dbBal.ending_balance).toFixed(2))
          : null,
        startedAt: dayRow.opened_at.toISOString(),
        endedAt: dayRow.closed_at?.toISOString() ?? null,
        autoClosed: false,
        locked: dayRow.is_closed,
      };
    }

    let systemEndingBalanceToday: number | null = null;
    if (operationalCashAllowed && dayRow) {
      const dbRow = await this.prisma.daily_balances.findUnique({
        where: {
          branch_id_record_date: {
            branch_id: branchId,
            record_date: todayDate,
          },
        },
        select: { starting_balance: true },
      });
      const startNum = dbRow
        ? Number(this.dec(dbRow.starting_balance).toFixed(2))
        : Number(this.dec(dayRow.starting_balance).toFixed(2));
      const net = await this.financeDailyBalance.sumOperationalNetCash(
        branchId,
        manilaCalendarDate,
      );
      systemEndingBalanceToday = Number((startNum + net).toFixed(2));
    }

    const lastEnd = await this.prisma.branch_day_sessions.findFirst({
      where: {
        branch_id: branchId,
        is_closed: true,
        closed_at: { not: null },
      },
      orderBy: [{ session_date: 'desc' }, { closed_at: 'desc' }],
    });

    return {
      manilaCalendarDate,
      todaySession,
      pendingStartingSession,
      operationalCashAllowed,
      systemEndingBalanceToday,
      lastEnd: lastEnd
        ? {
            businessDate: this.formatBusinessDate(lastEnd.session_date),
            endedAt: lastEnd.closed_at!.toISOString(),
            autoClosed: false,
            status: 'CLOSED',
          }
        : null,
    };
  }

  private async upsertJournalMarker(
    tx: Tx,
    params: {
      branchId: string;
      branchName: string;
      businessDateStr: string;
      purpose: TransactionPurpose.START | TransactionPurpose.END;
      details: string;
      createdByUserId?: string | null;
    },
  ): Promise<void> {
    const date = this.toRecordDate(params.businessDateStr);
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);

    const existing = await tx.transactions.findFirst({
      where: {
        branch_id: params.branchId,
        transaction_date: date,
        purpose: params.purpose,
      },
      select: { id: true },
    });

    const baseData = {
      branch_id: params.branchId,
      branch: params.branchName,
      purpose: params.purpose,
      transaction_date: date,
      transaction_time: this.toDbTime(timeStr),
      cash_in: new Prisma.Decimal(0),
      cash_out: new Prisma.Decimal(0),
      details: params.details,
      created_by_user_id: params.createdByUserId ?? null,
      updated_at: now,
    };

    if (existing) {
      await tx.transactions.update({
        where: { id: existing.id },
        data: {
          ...baseData,
          transaction_no: `${params.purpose.toUpperCase()}-${Date.now()}`,
        },
      });
    } else {
      await tx.transactions.create({
        data: {
          ...baseData,
          transaction_no: `${params.purpose.substring(0, 2).toUpperCase()}-${Date.now()}`,
        },
      });
    }
  }

  async submitStartingBalance(params: {
    branchId: string;
    actorUserId: string | null;
    amount: number;
  }): Promise<{
    success: boolean;
    businessDate: string;
    startingBalance: number;
    endingBalance: number;
  }> {
    const confirmedAmount = Number(params.amount.toFixed(2));
    if (!Number.isFinite(confirmedAmount) || confirmedAmount < 0) {
      throw new BadRequestException('amount must be a non-negative number');
    }

    return this.prisma.$transaction(async (tx) => {
      const todayStr = getPhCalendarDateString();
      const todayDate = this.toRecordDate(todayStr);

      await tx.$executeRaw`
        SELECT id FROM branches WHERE id = ${params.branchId}::uuid FOR UPDATE
      `;

      const existing = await tx.branch_day_sessions.findUnique({
        where: {
          branch_id_session_date: {
            branch_id: params.branchId,
            session_date: todayDate,
          },
        },
      });

      if (existing && !existing.is_closed) {
        throw new ConflictException({
          code: 'BRANCH_STARTING_BALANCE_RACE',
          message:
            'Starting balance was already submitted for this business day. Refresh and continue.',
        });
      }

      const branch = await tx.branches.findUnique({
        where: { id: params.branchId },
        select: { name: true },
      });

      const balances = await this.financeDailyBalance.persistConfirmationBalancesInTx(
        tx,
        {
          branchId: params.branchId,
          businessDateStr: todayStr,
          mode: 'starting',
          confirmedAmount,
        },
      );

      await tx.branch_day_sessions.upsert({
        where: {
          branch_id_session_date: {
            branch_id: params.branchId,
            session_date: todayDate,
          },
        },
        create: {
          branch_id: params.branchId,
          session_date: todayDate,
          starting_balance: new Prisma.Decimal(confirmedAmount),
          is_closed: false,
          started_by_user_id: params.actorUserId,
          opened_at: new Date(),
          updated_at: new Date(),
        },
        update: {
          starting_balance: new Prisma.Decimal(confirmedAmount),
          is_closed: false,
          closed_at: null,
          closed_by_user_id: null,
          started_by_user_id: params.actorUserId,
          opened_at: new Date(),
          updated_at: new Date(),
        },
      });

      await this.upsertJournalMarker(tx, {
        branchId: params.branchId,
        branchName: branch?.name ?? 'Unknown',
        businessDateStr: todayStr,
        purpose: TransactionPurpose.START,
        details: `Opening balance confirmed: ₱${confirmedAmount.toLocaleString('en-PH')}`,
        createdByUserId: params.actorUserId,
      });

      const openingDate = this.toRecordDate(todayStr);
      await tx.daily_opening.upsert({
        where: {
          branch_id_opening_date: {
            branch_id: params.branchId,
            opening_date: openingDate,
          },
        },
        create: {
          branch_id: params.branchId,
          opening_date: openingDate,
          starting_cash: new Prisma.Decimal(confirmedAmount),
          status: 'completed',
          employee_id: params.actorUserId,
          last_updated_by_user_id: params.actorUserId,
        },
        update: {
          starting_cash: new Prisma.Decimal(confirmedAmount),
          status: 'completed',
          employee_id: params.actorUserId,
          last_updated_by_user_id: params.actorUserId,
          updated_at: new Date(),
        },
      });

      return {
        success: true,
        businessDate: todayStr,
        startingBalance: balances.startingBalance,
        endingBalance: balances.endingBalance,
      };
    });
  }

  async closeTodayManual(params: {
    branchId: string;
    actorUserId: string | null;
    physicalEndingAmount?: number;
  }): Promise<{
    skipped?: boolean;
    closureApplied?: boolean;
    businessDate: string;
    endingBalance: number;
    nextBusinessDate: string;
  }> {
    const closeDateStr = getPhCalendarDateString();
    const closeDate = this.toRecordDate(closeDateStr);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT id FROM branch_day_sessions
        WHERE branch_id = ${params.branchId}::uuid AND session_date = ${closeDate}::date
        FOR UPDATE
      `;

      const row = await tx.branch_day_sessions.findUnique({
        where: {
          branch_id_session_date: {
            branch_id: params.branchId,
            session_date: closeDate,
          },
        },
      });

      if (!row) {
        throw new BadRequestException({
          code: 'BRANCH_DAY_SESSION_MISSING',
          message:
            'No branch day session found for today. Submit starting balance first.',
        });
      }

      if (row.is_closed) {
        const dbBal = await tx.daily_balances.findUnique({
          where: {
            branch_id_record_date: {
              branch_id: params.branchId,
              record_date: closeDate,
            },
          },
          select: { ending_balance: true },
        });
        return {
          skipped: true,
          closureApplied: false,
          businessDate: closeDateStr,
          endingBalance: dbBal
            ? Number(this.dec(dbBal.ending_balance).toFixed(2))
            : Number(this.dec(row.starting_balance).toFixed(2)),
          nextBusinessDate: closeDateStr,
        };
      }

      const branch = await tx.branches.findUnique({
        where: { id: params.branchId },
        select: { name: true },
      });

      const persistConfirmed =
        params.physicalEndingAmount != null
          ? Number(params.physicalEndingAmount.toFixed(2))
          : 0;

      const balances = await this.financeDailyBalance.persistConfirmationBalancesInTx(
        tx,
        {
          branchId: params.branchId,
          businessDateStr: closeDateStr,
          mode: 'ending',
          confirmedAmount: persistConfirmed,
        },
      );

      await tx.branch_day_sessions.update({
        where: { id: row.id },
        data: {
          is_closed: true,
          closed_at: new Date(),
          closed_by_user_id: params.actorUserId,
          updated_at: new Date(),
        },
      });

      await tx.daily_opening.deleteMany({
        where: {
          branch_id: params.branchId,
          opening_date: closeDate,
        },
      });

      const detailAmt =
        params.physicalEndingAmount != null
          ? params.physicalEndingAmount
          : balances.endingBalance;

      await this.upsertJournalMarker(tx, {
        branchId: params.branchId,
        branchName: branch?.name ?? 'Unknown',
        businessDateStr: closeDateStr,
        purpose: TransactionPurpose.END,
        details: `Branch business day ended — closing balance confirmed: ₱${Number(detailAmt).toLocaleString('en-PH')}`,
        createdByUserId: params.actorUserId,
      });

      return {
        skipped: false,
        closureApplied: true,
        businessDate: closeDateStr,
        endingBalance: balances.endingBalance,
        nextBusinessDate: closeDateStr,
      };
    });
  }

  /**
   * Auto-close historical Manila sessions left open (midnight PH rollover).
   */
  async autoCloseStaleOpenSessions(): Promise<
    Array<{
      branchId: string;
      businessDate: string;
      closureApplied: boolean;
      endingBalance: number;
    }>
  > {
    const todayStr = getPhCalendarDateString();
    const todayDate = this.toRecordDate(todayStr);

    const stale = await this.prisma.branch_day_sessions.findMany({
      where: {
        session_date: { lt: todayDate },
        is_closed: false,
      },
      select: { id: true, branch_id: true, session_date: true },
    });

    const results: Array<{
      branchId: string;
      businessDate: string;
      closureApplied: boolean;
      endingBalance: number;
    }> = [];

    for (const s of stale) {
      const closeDateStr = this.formatBusinessDate(s.session_date);
      try {
        const r = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            SELECT id FROM branch_day_sessions WHERE id = ${s.id}::uuid FOR UPDATE
          `;
          const locked = await tx.branch_day_sessions.findUnique({
            where: { id: s.id },
          });
          if (!locked || locked.is_closed) {
            return null;
          }

          const closeDate = locked.session_date;

          const branch = await tx.branches.findUnique({
            where: { id: locked.branch_id },
            select: { name: true },
          });

          const balances =
            await this.financeDailyBalance.persistConfirmationBalancesInTx(tx, {
              branchId: locked.branch_id,
              businessDateStr: closeDateStr,
              mode: 'ending',
              confirmedAmount: 0,
            });

          await tx.branch_day_sessions.update({
            where: { id: locked.id },
            data: {
              is_closed: true,
              closed_at: new Date(),
              closed_by_user_id: null,
              updated_at: new Date(),
            },
          });

          await tx.daily_opening.deleteMany({
            where: {
              branch_id: locked.branch_id,
              opening_date: closeDate,
            },
          });

          await this.upsertJournalMarker(tx, {
            branchId: locked.branch_id,
            branchName: branch?.name ?? 'Unknown',
            businessDateStr: closeDateStr,
            purpose: TransactionPurpose.END,
            details: `Branch business day auto-closed at Manila midnight — closing balance: ₱${balances.endingBalance.toLocaleString('en-PH')}`,
            createdByUserId: null,
          });

          return balances.endingBalance;
        });

        if (r != null) {
          results.push({
            branchId: s.branch_id,
            businessDate: closeDateStr,
            closureApplied: true,
            endingBalance: r,
          });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `[BranchDaySession] Auto-close failed branch=${s.branch_id} date=${closeDateStr}: ${msg}`,
        );
      }
    }

    return results;
  }
}
