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
  getPhWallClockTimeString,
} from '../../../common/utils/branch-calendar-date.util';
import {
  inventoryLineValue,
  isStatusIncludedInInventoryValuation,
  type InventoryValuationMode,
} from '../../../common/utils/inventory-valuation.util';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { BranchSessionStatus } from '../constants/branch-session-status';
import { FinanceDailyBalanceService } from './finance-daily-balance.service';
import {
  type DataEnvironment,
  getEnvironment,
} from '../../../common/utils/authorization.util';

type Tx = Prisma.TransactionClient;

export interface BranchBusinessSessionSnapshot {
  manilaCalendarDate: string;
  todaySession: {
    status: string;
    businessDate: string;
    startingBalance: number | null;
    endingBalance: number | null;
    startedAt: string | null;
    endedAt: string | null;
    autoClosed: boolean;
    locked: boolean;
  } | null;
  pendingStartingSession: {
    businessDate: string;
    suggestedStartingBalance: number;
  } | null;
  operationalCashAllowed: boolean;
  /** ISO timestamp — operational cash counts only for txs at or after this instant. */
  operationalCutoffAt: string | null;
  /** Transaction ids sealed before the current shift (excluded from operational net). */
  sealedTransactionIds: string[];
  systemEndingBalanceToday: number | null;
  lastEnd: {
    businessDate: string;
    endedAt: string;
    autoClosed: boolean;
    status: string;
  } | null;
}

/**
 * Branch-wide Manila business-day lifecycle: OPEN → end-day may reset same calendar date to
 * PENDING_START_BALANCE (same-day reopen) or CLOSED → next calendar PENDING_START_BALANCE → OPEN after
 * shared starting balance. Coordinates daily_balances, journal Start/End markers (Prisma), daily_opening,
 * inventory snapshot on close, and concurrency locks on session rows.
 */
@Injectable()
export class BranchBusinessSessionService {
  private readonly logger = new Logger(BranchBusinessSessionService.name);

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

  private dec(n: unknown): Prisma.Decimal {
    return new Prisma.Decimal(String(n ?? 0));
  }

  async computeInventoryValuationSnapshot(
    branchId: string,
  ): Promise<Prisma.InputJsonValue> {
    const branch = await this.prisma.branches.findUnique({
      where: { id: branchId },
      select: { inventory_valuation_mode: true },
    });
    const mode: InventoryValuationMode =
      branch?.inventory_valuation_mode === 'APPRAISED_VALUE'
        ? 'APPRAISED_VALUE'
        : 'LOAN_AMOUNT';

    const items = await this.prisma.pawned_items.findMany({
      where: { branch_id: branchId },
      select: {
        status: true,
        amount: true,
        appraised_value: true,
        estimated_resale_value: true,
      },
    });

    let pawnBookValue = new Prisma.Decimal(0);
    let pawnCount = 0;
    for (const row of items) {
      if (!isStatusIncludedInInventoryValuation(row.status)) continue;
      pawnCount += 1;
      pawnBookValue = pawnBookValue.plus(inventoryLineValue(row, mode));
    }

    const sales = await this.prisma.sale_items.findMany({
      where: { branch_id: branchId, status: 'Available' },
      select: { price: true },
    });
    let saleValue = new Prisma.Decimal(0);
    let saleCount = 0;
    for (const s of sales) {
      saleCount += 1;
      saleValue = saleValue.plus(new Prisma.Decimal(String(s.price ?? 0)));
    }

    return {
      computedAt: new Date().toISOString(),
      pawnBookValue: Number(pawnBookValue.toFixed(2)),
      pawnCount,
      availableSaleValue: Number(saleValue.toFixed(2)),
      availableSaleCount: saleCount,
      valuationMode: mode,
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
    const timeStr = getPhWallClockTimeString(now);
    const environmentFields = await this.resolveActorEnvironmentFields(
      tx,
      params.createdByUserId,
    );

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

  async getSnapshot(branchId: string): Promise<BranchBusinessSessionSnapshot> {
    await this.reconcileStaleFuturePendingWhenTodayClosed(branchId);
    await this.reconcileStalePriorPendingWhenCalendarAdvanced(branchId);

    const manilaCalendarDate = getPhCalendarDateString();
    const todayDate = this.toRecordDate(manilaCalendarDate);

    let todaySessionRow = await this.prisma.branch_business_sessions.findUnique(
      {
        where: {
          branch_id_business_date: {
            branch_id: branchId,
            business_date: todayDate,
          },
        },
      },
    );

    let pendingRow = await this.prisma.branch_business_sessions.findFirst({
      where: {
        branch_id: branchId,
        status: BranchSessionStatus.PENDING_START_BALANCE,
        business_date: todayDate,
      },
    });

    if (!pendingRow) {
      pendingRow = await this.prisma.branch_business_sessions.findFirst({
        where: {
          branch_id: branchId,
          status: BranchSessionStatus.PENDING_START_BALANCE,
        },
        orderBy: { business_date: 'asc' },
      });
    }

    if (!todaySessionRow && !pendingRow) {
      this.logger.warn(
        `[BranchSession] No session row for Manila=${manilaCalendarDate} branch=${branchId}; creating PENDING_START_BALANCE bootstrap row.`,
      );
      await this.ensureSessionRowForManilaDate(branchId, manilaCalendarDate);
      todaySessionRow = await this.prisma.branch_business_sessions.findUnique({
        where: {
          branch_id_business_date: {
            branch_id: branchId,
            business_date: todayDate,
          },
        },
      });
      pendingRow = await this.prisma.branch_business_sessions.findFirst({
        where: {
          branch_id: branchId,
          status: BranchSessionStatus.PENDING_START_BALANCE,
          business_date: todayDate,
        },
      });
      if (!pendingRow) {
        pendingRow = await this.prisma.branch_business_sessions.findFirst({
          where: {
            branch_id: branchId,
            status: BranchSessionStatus.PENDING_START_BALANCE,
          },
          orderBy: { business_date: 'asc' },
        });
      }
      if (!todaySessionRow && !pendingRow) {
        this.logger.error(
          `[BranchSession] Bootstrap still missing rows branch=${branchId} manila=${manilaCalendarDate}`,
        );
      }
    }

    if (
      todaySessionRow?.status === BranchSessionStatus.PENDING_START_BALANCE &&
      !pendingRow
    ) {
      pendingRow = todaySessionRow;
    }

    let suggestedStartingBalance = 0;
    if (pendingRow) {
      const pendingStr = this.formatBusinessDate(pendingRow.business_date);
      suggestedStartingBalance =
        await this.financeDailyBalance.suggestedStartingCashForBusinessDate(
          branchId,
          pendingStr,
        );
    }

    let systemEndingBalanceToday: number | null = null;
    let operationalCutoffAt: string | null = null;
    const sealedTransactionIds: string[] = [];
    if (todaySessionRow?.status === BranchSessionStatus.OPEN) {
      operationalCutoffAt =
        await this.financeDailyBalance.resolveOperationalCutoffIso(
          branchId,
          manilaCalendarDate,
        );
      let startNum = 0;
      if (todaySessionRow.starting_balance != null) {
        startNum = Number(
          this.dec(todaySessionRow.starting_balance).toFixed(2),
        );
      } else {
        const dbRow = await this.prisma.daily_balances.findUnique({
          where: {
            branch_id_record_date: {
              branch_id: branchId,
              record_date: todayDate,
            },
          },
          select: { starting_balance: true },
        });
        startNum = dbRow
          ? Number(this.dec(dbRow.starting_balance).toFixed(2))
          : 0;
      }
      const net = await this.financeDailyBalance.sumOperationalNetCash(
        branchId,
        manilaCalendarDate,
      );
      systemEndingBalanceToday = Number((startNum + net).toFixed(2));
    }

    const lastEnd = await this.prisma.branch_business_sessions.findFirst({
      where: {
        branch_id: branchId,
        ended_at: { not: null },
      },
      orderBy: { ended_at: 'desc' },
    });

    const operationalCashAllowed = true;

    return {
      manilaCalendarDate,
      todaySession: todaySessionRow
        ? {
            status: todaySessionRow.status,
            businessDate: this.formatBusinessDate(
              todaySessionRow.business_date,
            ),
            startingBalance: todaySessionRow.starting_balance
              ? Number(this.dec(todaySessionRow.starting_balance).toFixed(2))
              : null,
            endingBalance: todaySessionRow.ending_balance
              ? Number(this.dec(todaySessionRow.ending_balance).toFixed(2))
              : null,
            startedAt: todaySessionRow.started_at?.toISOString() ?? null,
            endedAt: todaySessionRow.ended_at?.toISOString() ?? null,
            autoClosed: todaySessionRow.auto_closed,
            locked: todaySessionRow.locked,
          }
        : null,
      pendingStartingSession: pendingRow
        ? {
            businessDate: this.formatBusinessDate(pendingRow.business_date),
            suggestedStartingBalance,
          }
        : null,
      operationalCashAllowed,
      operationalCutoffAt,
      sealedTransactionIds,
      systemEndingBalanceToday,
      lastEnd: lastEnd
        ? {
            businessDate: this.formatBusinessDate(lastEnd.business_date),
            endedAt: lastEnd.ended_at!.toISOString(),
            autoClosed: lastEnd.auto_closed,
            status: lastEnd.status,
          }
        : null,
    };
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

    return this.prisma.$transaction(async (tx) => {
      const todayStr = getPhCalendarDateString();
      const todayDate = this.toRecordDate(todayStr);

      let pending = await tx.branch_business_sessions.findFirst({
        where: {
          branch_id: params.branchId,
          status: BranchSessionStatus.PENDING_START_BALANCE,
          business_date: todayDate,
        },
      });

      if (!pending) {
        pending = await tx.branch_business_sessions.findFirst({
          where: {
            branch_id: params.branchId,
            status: BranchSessionStatus.PENDING_START_BALANCE,
          },
          orderBy: { business_date: 'asc' },
        });
      }

      if (!pending) {
        throw new BadRequestException({
          code: 'NO_PENDING_STARTING_SESSION',
          message:
            'No pending starting balance is required for this branch, or the business day is already open.',
        });
      }

      await tx.$executeRaw`
        SELECT id FROM branch_business_sessions
        WHERE id = ${pending.id}::uuid
        FOR UPDATE
      `;

      const locked = await tx.branch_business_sessions.findUnique({
        where: { id: pending.id },
      });

      if (
        !locked ||
        locked.status !== BranchSessionStatus.PENDING_START_BALANCE
      ) {
        throw new ConflictException({
          code: 'BRANCH_STARTING_BALANCE_RACE',
          message:
            'Starting balance was already submitted for this business day. Refresh and continue.',
        });
      }

      const businessDateStr = this.formatBusinessDate(locked.business_date);

      const branch = await tx.branches.findUnique({
        where: { id: params.branchId },
        select: { name: true },
      });

      const balances =
        await this.financeDailyBalance.persistConfirmationBalancesInTx(tx, {
          branchId: params.branchId,
          businessDateStr,
          mode: 'starting',
          confirmedAmount,
        });

      await tx.branch_business_sessions.update({
        where: { id: locked.id },
        data: {
          status: BranchSessionStatus.OPEN,
          starting_balance: new Prisma.Decimal(confirmedAmount),
          ending_balance: new Prisma.Decimal(balances.endingBalance),
          started_at: new Date(),
          started_by_user_id: params.actorUserId,
          locked: false,
          auto_closed: false,
          updated_at: new Date(),
        },
      });

      await this.upsertJournalMarker(tx, {
        branchId: params.branchId,
        branchName: branch?.name ?? 'Unknown',
        businessDateStr,
        purpose: TransactionPurpose.START,
        details: `Opening balance confirmed: ₱${confirmedAmount.toLocaleString('en-PH')}`,
        createdByUserId: params.actorUserId,
      });

      const openingDate = this.toRecordDate(businessDateStr);
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
        },
        update: {
          starting_cash: new Prisma.Decimal(confirmedAmount),
          status: 'pending',
          employee_id: params.actorUserId,
          last_updated_by_user_id: params.actorUserId,
          updated_at: new Date(),
        },
      });

      return {
        success: true,
        businessDate: businessDateStr,
        startingBalance: balances.startingBalance,
        endingBalance: balances.endingBalance,
      };
    });
  }

  async endBranchDayManual(params: {
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
    return this.finalizeBranchDay({
      branchId: params.branchId,
      closeDateStr,
      actorUserId: params.actorUserId,
      autoClosed: false,
      physicalEndingAmount: params.physicalEndingAmount,
    });
  }

  async endBranchDayAutoForYesterday(branchId: string): Promise<{
    yesterdayStr: string;
    closureApplied: boolean;
    skipped: boolean;
    endingBalance: number;
  }> {
    const todayStr = getPhCalendarDateString();
    const yesterdayStr = addManilaCalendarDays(todayStr, -1);
    const result = await this.finalizeBranchDay({
      branchId,
      closeDateStr: yesterdayStr,
      actorUserId: null,
      autoClosed: true,
    });
    if (!result.closureApplied) {
      this.logger.debug(
        `[BranchSession] Auto end-day skip branch=${branchId} date=${yesterdayStr}`,
      );
    } else {
      this.logger.log(
        `[BranchSession] Auto end-day branch=${branchId} date=${yesterdayStr} ending=${result.endingBalance}`,
      );
    }
    return {
      yesterdayStr,
      closureApplied: result.closureApplied,
      skipped: result.skipped,
      endingBalance: result.endingBalance,
    };
  }

  async ensureSessionRowForManilaDate(
    branchId: string,
    manilaDateStr: string,
  ): Promise<void> {
    const d = this.toRecordDate(manilaDateStr);
    try {
      await this.prisma.branch_business_sessions.create({
        data: {
          branch_id: branchId,
          business_date: d,
          status: BranchSessionStatus.PENDING_START_BALANCE,
          locked: false,
          auto_closed: false,
        },
      });
    } catch (e: unknown) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return;
      }
      throw e;
    }
  }

  /**
   * Legacy state: today's session is CLOSED but a future calendar PENDING row exists (e.g. next day
   * was created while Manila calendar is still "today"). Removes the future row and resets today to
   * PENDING so staff can submit starting balance again on the same Manila date.
   */
  private async reconcileStaleFuturePendingWhenTodayClosed(
    branchId: string,
  ): Promise<void> {
    const manilaCalendarDate = getPhCalendarDateString();
    const todayDate = this.toRecordDate(manilaCalendarDate);

    const todayRow = await this.prisma.branch_business_sessions.findUnique({
      where: {
        branch_id_business_date: {
          branch_id: branchId,
          business_date: todayDate,
        },
      },
    });

    if (
      !todayRow ||
      (todayRow.status !== BranchSessionStatus.CLOSED &&
        todayRow.status !== BranchSessionStatus.AUTO_CLOSED)
    ) {
      return;
    }

    const pendingRows = await this.prisma.branch_business_sessions.findMany({
      where: {
        branch_id: branchId,
        status: BranchSessionStatus.PENDING_START_BALANCE,
      },
    });

    const futurePending = pendingRows.find(
      (p) => this.formatBusinessDate(p.business_date) > manilaCalendarDate,
    );

    if (!futurePending) {
      return;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM branch_business_sessions
          WHERE branch_id = ${branchId}::uuid AND business_date = ${todayDate}::date
          FOR UPDATE
        `;

        await tx.branch_business_sessions.delete({
          where: { id: futurePending.id },
        });

        await tx.branch_business_sessions.update({
          where: { id: todayRow.id },
          data: {
            status: BranchSessionStatus.PENDING_START_BALANCE,
            locked: false,
            ended_at: null,
            ended_by_user_id: null,
            auto_closed: false,
            starting_balance: null,
            ending_balance: null,
            started_at: null,
            started_by_user_id: null,
            inventory_valuation_snapshot: {},
            updated_at: new Date(),
          },
        });
      });
      this.logger.warn(
        `[BranchSession] Reconciled same-Manila-date reopen branch=${branchId} date=${manilaCalendarDate}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `[BranchSession] reconcileStaleFuturePending skipped branch=${branchId}: ${msg}`,
      );
    }
  }

  /**
   * After a same-calendar-day end-day, the session row stays PENDING with ended_at set until someone
   * submits starting balance again. If the Manila calendar advances first, finalize that prior date as
   * CLOSED and ensure today's row exists as PENDING_START_BALANCE.
   */
  private async reconcileStalePriorPendingWhenCalendarAdvanced(
    branchId: string,
  ): Promise<void> {
    const manilaCalendarDate = getPhCalendarDateString();
    const todayDate = this.toRecordDate(manilaCalendarDate);

    const todayRow = await this.prisma.branch_business_sessions.findUnique({
      where: {
        branch_id_business_date: {
          branch_id: branchId,
          business_date: todayDate,
        },
      },
    });

    if (todayRow?.status === BranchSessionStatus.OPEN) {
      return;
    }

    const stalePreview = await this.prisma.branch_business_sessions.findFirst({
      where: {
        branch_id: branchId,
        status: BranchSessionStatus.PENDING_START_BALANCE,
        business_date: { lt: todayDate },
        ended_at: { not: null },
      },
      orderBy: { business_date: 'asc' },
    });

    if (!stalePreview) {
      return;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        for (let i = 0; i < 12; i += 1) {
          const stale = await tx.branch_business_sessions.findFirst({
            where: {
              branch_id: branchId,
              status: BranchSessionStatus.PENDING_START_BALANCE,
              business_date: { lt: todayDate },
              ended_at: { not: null },
            },
            orderBy: { business_date: 'asc' },
          });

          if (!stale) {
            break;
          }

          await tx.$executeRaw`
            SELECT id FROM branch_business_sessions WHERE id = ${stale.id}::uuid FOR UPDATE
          `;

          const row = await tx.branch_business_sessions.findUnique({
            where: { id: stale.id },
          });
          if (
            !row ||
            row.status !== BranchSessionStatus.PENDING_START_BALANCE ||
            !row.ended_at ||
            row.business_date >= todayDate
          ) {
            break;
          }

          const dbBal = await tx.daily_balances.findUnique({
            where: {
              branch_id_record_date: {
                branch_id: branchId,
                record_date: row.business_date,
              },
            },
            select: { ending_balance: true },
          });
          const endBal = dbBal?.ending_balance;

          const closeData: Prisma.branch_business_sessionsUpdateInput = {
            status: BranchSessionStatus.CLOSED,
            locked: true,
            updated_at: new Date(),
          };
          if (endBal != null) {
            closeData.ending_balance = new Prisma.Decimal(endBal);
          }
          await tx.branch_business_sessions.update({
            where: { id: row.id },
            data: closeData,
          });
        }

        await tx.branch_business_sessions.upsert({
          where: {
            branch_id_business_date: {
              branch_id: branchId,
              business_date: todayDate,
            },
          },
          create: {
            branch_id: branchId,
            business_date: todayDate,
            status: BranchSessionStatus.PENDING_START_BALANCE,
            locked: false,
            auto_closed: false,
          },
          update: {},
        });
      });
      this.logger.warn(
        `[BranchSession] Finalized prior PENDING-after-close for new Manila date branch=${branchId} today=${manilaCalendarDate}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `[BranchSession] reconcileStalePriorPending skipped branch=${branchId}: ${msg}`,
      );
    }
  }

  private async finalizeBranchDay(params: {
    branchId: string;
    closeDateStr: string;
    actorUserId: string | null;
    autoClosed: boolean;
    physicalEndingAmount?: number;
  }): Promise<{
    skipped: boolean;
    closureApplied: boolean;
    businessDate: string;
    endingBalance: number;
    nextBusinessDate: string;
  }> {
    const { branchId, closeDateStr, actorUserId, autoClosed } = params;
    const closeDate = this.toRecordDate(closeDateStr);
    const nextBusinessDateStr = addManilaCalendarDays(closeDateStr, 1);
    const nextBusinessDate = this.toRecordDate(nextBusinessDateStr);

    const inventorySnapshot =
      await this.computeInventoryValuationSnapshot(branchId);

    const txResult = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT id FROM branch_business_sessions
        WHERE branch_id = ${branchId}::uuid AND business_date = ${closeDate}::date
        FOR UPDATE
      `;

      const sessionRow = await tx.branch_business_sessions.findUnique({
        where: {
          branch_id_business_date: {
            branch_id: branchId,
            business_date: closeDate,
          },
        },
      });

      if (!sessionRow) {
        if (autoClosed) {
          return { kind: 'auto_skip' as const };
        }
        throw new BadRequestException({
          code: 'BRANCH_SESSION_MISSING',
          message:
            'Branch business session is not initialized. Contact support or run database migrations.',
        });
      }

      if (
        sessionRow.status === BranchSessionStatus.CLOSED ||
        sessionRow.status === BranchSessionStatus.AUTO_CLOSED
      ) {
        await tx.branch_business_sessions.upsert({
          where: {
            branch_id_business_date: {
              branch_id: branchId,
              business_date: nextBusinessDate,
            },
          },
          create: {
            branch_id: branchId,
            business_date: nextBusinessDate,
            status: BranchSessionStatus.PENDING_START_BALANCE,
          },
          update: {},
        });
        return {
          kind: 'already_closed' as const,
          endingBalance: Number(
            this.dec(sessionRow.ending_balance ?? 0).toFixed(2),
          ),
        };
      }

      if (sessionRow.status !== BranchSessionStatus.OPEN) {
        if (autoClosed) {
          return { kind: 'auto_skip' as const };
        }
        throw new BadRequestException({
          code: 'BRANCH_DAY_NOT_OPEN',
          message:
            'The branch business day is not open for closing. Submit starting balance first.',
        });
      }

      const branch = await tx.branches.findUnique({
        where: { id: branchId },
        select: { name: true },
      });

      const persistConfirmed =
        params.physicalEndingAmount != null
          ? Number(params.physicalEndingAmount.toFixed(2))
          : 0;

      const balances =
        await this.financeDailyBalance.persistConfirmationBalancesInTx(tx, {
          branchId,
          businessDateStr: closeDateStr,
          mode: 'ending',
          confirmedAmount: persistConfirmed,
        });

      const sameManilaCalendarDay = closeDateStr === getPhCalendarDateString();

      if (sameManilaCalendarDay) {
        await tx.branch_business_sessions.update({
          where: { id: sessionRow.id },
          data: {
            status: BranchSessionStatus.PENDING_START_BALANCE,
            starting_balance: null,
            ending_balance: null,
            started_at: null,
            started_by_user_id: null,
            auto_closed: false,
            locked: false,
            inventory_valuation_snapshot: inventorySnapshot,
            updated_at: new Date(),
          },
        });
        this.logger.log(
          `[BranchSession] Same-Manila-date end-day → pending restart branch=${branchId} date=${closeDateStr}`,
        );
      } else {
        await tx.branch_business_sessions.update({
          where: { id: sessionRow.id },
          data: {
            status: autoClosed
              ? BranchSessionStatus.AUTO_CLOSED
              : BranchSessionStatus.CLOSED,
            ending_balance: new Prisma.Decimal(balances.endingBalance),
            ended_at: new Date(),
            ended_by_user_id: actorUserId,
            auto_closed: autoClosed,
            locked: true,
            inventory_valuation_snapshot: inventorySnapshot,
            updated_at: new Date(),
          },
        });

        await tx.branch_business_sessions.upsert({
          where: {
            branch_id_business_date: {
              branch_id: branchId,
              business_date: nextBusinessDate,
            },
          },
          create: {
            branch_id: branchId,
            business_date: nextBusinessDate,
            status: BranchSessionStatus.PENDING_START_BALANCE,
          },
          update: {},
        });
      }

      await tx.daily_opening.deleteMany({
        where: {
          branch_id: branchId,
          opening_date: closeDate,
        },
      });

      const detailAmt =
        params.physicalEndingAmount != null
          ? params.physicalEndingAmount
          : balances.endingBalance;

      await this.upsertJournalMarker(tx, {
        branchId,
        branchName: branch?.name ?? 'Unknown',
        businessDateStr: closeDateStr,
        purpose: TransactionPurpose.END,
        details: `Branch business day ended — closing balance confirmed: ₱${Number(detailAmt).toLocaleString('en-PH')}`,
        createdByUserId: actorUserId,
      });

      return {
        kind: 'closed' as const,
        endingBalance: balances.endingBalance,
        sameDayReopen: sameManilaCalendarDay,
      };
    });

    if (txResult.kind === 'auto_skip') {
      return {
        skipped: true,
        closureApplied: false,
        businessDate: closeDateStr,
        endingBalance: 0,
        nextBusinessDate: nextBusinessDateStr,
      };
    }

    if (txResult.kind === 'already_closed') {
      return {
        skipped: true,
        closureApplied: false,
        businessDate: closeDateStr,
        endingBalance: txResult.endingBalance,
        nextBusinessDate: nextBusinessDateStr,
      };
    }

    const closed = txResult;

    return {
      skipped: false,
      closureApplied: true,
      businessDate: closeDateStr,
      endingBalance: closed.endingBalance,
      nextBusinessDate: closed.sameDayReopen
        ? closeDateStr
        : nextBusinessDateStr,
    };
  }
}
