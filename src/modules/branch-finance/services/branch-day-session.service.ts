import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role, TransactionPurpose } from '../../../common/enums';
import {
  getPhCalendarDateString,
  getPhWallClockTimeString,
} from '../../../common/utils/branch-calendar-date.util';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { BranchBusinessSessionSnapshot } from './branch-business-session.service';
import { FinanceDailyBalanceService } from './finance-daily-balance.service';
import {
  type DataEnvironment,
  getEnvironment,
} from '../../../common/utils/authorization.util';

type Tx = Prisma.TransactionClient;

/** Open/close day runs many ledger reads; default 5s Prisma tx timeout is too low on remote DB. */
const BRANCH_DAY_TX_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

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

  private async resolveActorEnvironmentFields(
    tx: Tx,
    actorUserId?: string | null,
  ): Promise<{ environment: DataEnvironment; created_by: string | null }> {
    if (!actorUserId) {
      return { environment: 'production', created_by: null };
    }

    const actor = await tx.users.findUnique({
      where: { id: actorUserId },
      select: { auth_id: true, email: true, is_developer: true },
    });

    if (!actor) {
      return { environment: 'production', created_by: null };
    }

    return {
      environment: getEnvironment({
        email: actor.email,
        isDeveloper: actor.is_developer,
      }),
      created_by: actor.auth_id,
    };
  }

  /** `daily_opening` may be absent on older DBs; end-day must still close the session. */
  private async safeClearDailyOpeningInTx(
    tx: Tx,
    branchId: string,
    openingDate: Date,
  ): Promise<void> {
    try {
      await tx.daily_opening.deleteMany({
        where: { branch_id: branchId, opening_date: openingDate },
      });
    } catch (e: unknown) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2021' || e.code === 'P2022')
      ) {
        this.logger.warn(
          `[EndDay] daily_opening unavailable (${e.code}); skipping checklist clear`,
        );
        return;
      }
      throw e;
    }
  }

  private async closeBranchDaySessionInTx(
    tx: Tx,
    sessionId: string,
    params: {
      actorUserId: string | null;
      closeCutoff: Date;
      sealedAtClose: string[];
    },
  ): Promise<void> {
    const base = {
      is_closed: true,
      closed_at: params.closeCutoff,
      closed_by_user_id: params.actorUserId,
      updated_at: new Date(),
    };
    try {
      await tx.branch_day_sessions.update({
        where: { id: sessionId },
        data: {
          ...base,
          operational_cutoff_at: params.closeCutoff,
          sealed_transaction_ids: params.sealedAtClose,
        },
      });
    } catch (e: unknown) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2021' || e.code === 'P2022')
      ) {
        this.logger.warn(
          `[EndDay] shift columns unavailable (${e.code}); closing without seal metadata`,
        );
        await tx.branch_day_sessions.update({
          where: { id: sessionId },
          data: base,
        });
        return;
      }
      throw e;
    }
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

  /**
   * Suggested starting cash for the next shift on businessDateStr.
   *
   * Uses {@link FinanceDailyBalanceService.expectedOpeningCashBeforeStartDay} so validation,
   * business-session snapshot, and opening checklist all share one book-position source.
   */
  private async resolveSuggestedStartingBalance(
    branchId: string,
    businessDateStr: string,
  ): Promise<number> {
    const amount =
      await this.financeDailyBalance.expectedOpeningCashBeforeStartDay(
        branchId,
        businessDateStr,
      );
    this.logger.debug(
      `[ResolveSuggestedStart] branch=${branchId} date=${businessDateStr} amount=${amount}`,
    );
    return Number(Number(amount).toFixed(2));
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

    let dbBalToday: { ending_balance: unknown } | null = null;
    if (dayRow) {
      dbBalToday = await this.prisma.daily_balances.findUnique({
        where: {
          branch_id_record_date: {
            branch_id: branchId,
            record_date: todayDate,
          },
        },
        select: { ending_balance: true },
      });
    }

    let pendingStartingSession: BranchBusinessSessionSnapshot['pendingStartingSession'] =
      null;
    if (needsStarting) {
      const suggestedStartingBalance =
        await this.resolveSuggestedStartingBalance(
          branchId,
          manilaCalendarDate,
        );
      pendingStartingSession = {
        businessDate: manilaCalendarDate,
        suggestedStartingBalance,
      };
    }

    let todaySession: BranchBusinessSessionSnapshot['todaySession'] = null;
    if (dayRow) {
      todaySession = {
        status: dayRow.is_closed ? 'CLOSED' : 'OPEN',
        businessDate: this.formatBusinessDate(dayRow.session_date),
        startingBalance: Number(this.dec(dayRow.starting_balance).toFixed(2)),
        endingBalance: dbBalToday
          ? Number(this.dec(dbBalToday.ending_balance).toFixed(2))
          : null,
        startedAt: dayRow.opened_at.toISOString(),
        endedAt: dayRow.closed_at?.toISOString() ?? null,
        autoClosed: false,
        locked: dayRow.is_closed,
      };
    }

    let systemEndingBalanceToday: number | null = null;
    let operationalCutoffAt: string | null = null;
    let sealedTransactionIds: string[] = [];
    if (operationalCashAllowed && dayRow) {
      sealedTransactionIds = dayRow.sealed_transaction_ids ?? [];
      operationalCutoffAt =
        dayRow.operational_cutoff_at?.toISOString() ??
        (await this.financeDailyBalance.resolveOperationalCutoffIso(
          branchId,
          manilaCalendarDate,
        ));
      systemEndingBalanceToday =
        await this.financeDailyBalance.computeOpenSessionBookEnding(
          branchId,
          manilaCalendarDate,
        );
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
      operationalCutoffAt,
      sealedTransactionIds,
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
      /** When provided, bypasses actor-based environment resolution and uses this value directly.
       *  Used by the auto-close cron so each session's End marker inherits the session's own environment.
       */
      overrideEnvironment?: DataEnvironment | null;
    },
  ): Promise<void> {
    const date = this.toRecordDate(params.businessDateStr);
    const now = new Date();
    const timeStr = getPhWallClockTimeString(now);
    const environmentFields = params.overrideEnvironment
      ? { environment: params.overrideEnvironment, created_by: null as string | null }
      : await this.resolveActorEnvironmentFields(tx, params.createdByUserId);

    const existing = await tx.transactions.findFirst({
      where: {
        branch_id: params.branchId,
        transaction_date: date,
        purpose: params.purpose,
        environment: environmentFields.environment,
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
      ...environmentFields,
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
    actorRole?: Role | null;
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

    const todayStr = getPhCalendarDateString();
    if (params.actorRole !== Role.SUPER_ADMIN) {
      const expected = await this.resolveSuggestedStartingBalance(
        params.branchId,
        todayStr,
      );
      this.logger.debug(
        `[StartingBalance] check branch=${params.branchId} businessDate=${todayStr} expected=${expected} entered=${confirmedAmount}`,
      );
      if (Math.abs(expected - confirmedAmount) > 0.009) {
        this.logger.warn(
          `[StartingBalance] MISMATCH branch=${params.branchId} businessDate=${todayStr} expected=${expected} entered=${confirmedAmount}`,
        );
        throw new UnprocessableEntityException({
          code: 'STARTING_BALANCE_MISMATCH',
          message:
            'Starting cash does not match the expected amount from the last closed business day. File an incident report.',
          expectedAmount: expected,
          enteredAmount: confirmedAmount,
          businessDate: todayStr,
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
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
        select: { name: true, environment: true },
      });
      const env = (branch?.environment as DataEnvironment) ?? 'production';

      const shiftCutoff = new Date();
      const sealedTransactionIds =
        await this.financeDailyBalance.listOperationalTransactionIdsSealedBeforeCutoffInTx(
          tx,
          params.branchId,
          todayDate,
          shiftCutoff,
        );

      const balances =
        await this.financeDailyBalance.persistConfirmationBalancesInTx(tx, {
          branchId: params.branchId,
          businessDateStr: todayStr,
          mode: 'starting',
          confirmedAmount,
          environment: env,
        });

      this.logger.log(
        `[StartingBalance] persisted branch=${params.branchId} businessDate=${todayStr} starting=${balances.startingBalance} ending=${balances.endingBalance} operationalCutoff=${shiftCutoff.toISOString()}`,
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
          opened_at: shiftCutoff,
          operational_cutoff_at: shiftCutoff,
          sealed_transaction_ids: sealedTransactionIds,
          updated_at: new Date(),
          environment: env,
        },
        update: {
          starting_balance: new Prisma.Decimal(confirmedAmount),
          is_closed: false,
          closed_at: null,
          closed_by_user_id: null,
          started_by_user_id: params.actorUserId,
          opened_at: shiftCutoff,
          operational_cutoff_at: shiftCutoff,
          sealed_transaction_ids: sealedTransactionIds,
          updated_at: new Date(),
          environment: env,
        },
      });

      await this.upsertJournalMarker(tx, {
        branchId: params.branchId,
        branchName: branch?.name ?? 'Unknown',
        businessDateStr: todayStr,
        purpose: TransactionPurpose.START,
        details: `Opening balance confirmed: ₱${confirmedAmount.toLocaleString('en-PH')}`,
        createdByUserId: params.actorUserId,
        overrideEnvironment: env,
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
          status: 'pending',
          employee_id: params.actorUserId,
          last_updated_by_user_id: params.actorUserId,
          environment: env,
        },
        update: {
          starting_cash: new Prisma.Decimal(confirmedAmount),
          status: 'pending',
          employee_id: params.actorUserId,
          last_updated_by_user_id: params.actorUserId,
          updated_at: new Date(),
          environment: env,
        },
      });

      return {
        success: true,
        businessDate: todayStr,
        startingBalance: balances.startingBalance,
        endingBalance: balances.endingBalance,
      };
    }, BRANCH_DAY_TX_OPTIONS);
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

      const env = (row.environment as DataEnvironment) ?? 'production';

      const branch = await tx.branches.findUnique({
        where: { id: params.branchId },
        select: { name: true },
      });

      const closeCutoff = new Date();
      const sealedAtClose =
        await this.financeDailyBalance.listOperationalTransactionIdsSealedBeforeCutoffInTx(
          tx,
          params.branchId,
          closeDate,
          closeCutoff,
        );

      const systemEnding =
        await this.financeDailyBalance.computeOpenSessionBookEnding(
          params.branchId,
          closeDateStr,
          tx,
        );

      const persistConfirmed =
        params.physicalEndingAmount != null
          ? Number(params.physicalEndingAmount.toFixed(2))
          : Number((systemEnding ?? 0).toFixed(2));

      const balances =
        await this.financeDailyBalance.persistConfirmationBalancesInTx(tx, {
          branchId: params.branchId,
          businessDateStr: closeDateStr,
          mode: 'ending',
          confirmedAmount: persistConfirmed,
          environment: env,
        });

      await this.closeBranchDaySessionInTx(tx, row.id, {
        actorUserId: params.actorUserId,
        closeCutoff,
        sealedAtClose,
      });

      await this.safeClearDailyOpeningInTx(tx, params.branchId, closeDate);

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
        overrideEnvironment: env,
      });

      return {
        skipped: false,
        closureApplied: true,
        businessDate: closeDateStr,
        endingBalance: balances.endingBalance,
        nextBusinessDate: closeDateStr,
      };
    }, BRANCH_DAY_TX_OPTIONS);
  }

  /**
   * Auto-close open Manila sessions due for the 6 PM PH end-day sweep.
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
        session_date: { lte: todayDate },
        is_closed: false,
      },
      select: { id: true, branch_id: true, session_date: true, environment: true },
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
              environment: locked.environment,
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

          await this.safeClearDailyOpeningInTx(tx, locked.branch_id, closeDate);

          await this.upsertJournalMarker(tx, {
            branchId: locked.branch_id,
            branchName: branch?.name ?? 'Unknown',
            businessDateStr: closeDateStr,
            purpose: TransactionPurpose.END,
            details: `Branch business day auto-closed at 6:00 PM Manila time — closing balance: ₱${balances.endingBalance.toLocaleString('en-PH')}`,
            createdByUserId: null,
            // Use the session's own environment so dev-branch End markers stay in 'development'
            // and are never visible to production users.
            overrideEnvironment: (s.environment as DataEnvironment) ?? 'production',
          });

          return balances.endingBalance;
        }, BRANCH_DAY_TX_OPTIONS);

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
