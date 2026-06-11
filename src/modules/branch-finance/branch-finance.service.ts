import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from '../../common/enums';
import type { UserWithBranch } from '../../common/utils/branch-scope.util';
import {
  effectiveBranchIdForQuery,
  requireUserBranchId,
} from '../../common/utils/branch-scope.util';
import {
  addManilaCalendarDays,
  getPhCalendarDateString,
} from '../../common/utils/branch-calendar-date.util';
import {
  SupabaseService,
  type AuthenticatedUserProfile,
} from '../../infrastructure/supabase/supabase.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { buildBranchDaySnapshotFromFetched } from '../../common/utils/daily-balance-aggregate.util';
import { FinanceAuditService } from './services/finance-audit.service';
import { FinanceDailyBalanceService } from './services/finance-daily-balance.service';
import { BranchDaySessionService } from './services/branch-day-session.service';
import { OpeningChecklistGateService } from './services/opening-checklist-gate.service';

interface TransactionRow {
  id: string;
  transaction_no: string | null;
  branch_id: string | null;
  branch: string | null;
  purpose: string | null;
  transaction_date: string | null;
  transaction_time: string | null;
  cash_in: number | string | null;
  cash_out: number | string | null;
  unit: string | null;
  unit_code: string | null;
  details: string | null;
  pawn_amount: number | string | null;
  storage_fee: number | string | null;
  return_amount: number | string | null;
  created_at: string;
}

/** Subset for getSummary aggregation + shared classify/description helpers. */
type SummaryTxRow = Pick<
  TransactionRow,
  'purpose' | 'unit' | 'cash_in' | 'cash_out' | 'unit_code' | 'details'
> & { voided_at?: string | null };

interface DailyBalanceRow {
  branch_id: string;
  record_date: string;
  starting_balance: number | string | null;
  ending_balance: number | string | null;
  updated_at?: string | null;
}

interface BranchRow {
  id: string;
  name: string;
  branch_code: string | null;
  status: string | null;
  opening_cash_balance?: Prisma.Decimal | number | string | null;
}

export type LedgerEntryType =
  | 'pawn'
  | 'redeem'
  | 'buy_back'
  | 'renewal'
  | 'sale'
  | 'fund_transfer_in'
  | 'fund_transfer_out'
  | 'start'
  | 'end'
  | 'other';

export interface LedgerEntry {
  id: string;
  date: string;
  time: string | null;
  type: LedgerEntryType;
  description: string;
  itemName: string | null;
  cashIn: number;
  cashOut: number;
  branchId: string | null;
  branchName: string | null;
  reference: string | null;
}

export type DailyOpeningChecklistStep =
  | 'CASH_ON_HAND'
  | 'INVENTORY_AUDIT'
  | 'COMPLETED';

export interface EmployeeDailyOpeningStatus {
  openingDate: string;
  status: 'none' | 'pending' | 'completed';
  checklistStep: DailyOpeningChecklistStep;
  /** Matches OpeningChecklistGuard — when false, checklist-gated API routes return 403. */
  modulesAllowed: boolean;
  /** Suggested opening count from last End Day / ledger (CASH_ON_HAND step only). */
  expectedStartingCash?: number;
  startingCash?: number;
}

export interface BranchFinanceSummary {
  branchId: string;
  branchName: string;
  branchCode: string | null;
  status: string | null;
  currentBalance: number;
  startingBalance: number;
  todayCashIn: number;
  todayCashOut: number;
  breakdown: {
    pawnOut: number;
    redeemIn: number;
    buyBackIn: number;
    renewalIn: number;
    saleIn: number;
    fundTransferIn: number;
    fundTransferOut: number;
    startBalance: number;
    other: number;
  };
  fundRequests: {
    pending: number;
    approved: number;
    transferred: number;
  };
}

@Injectable()
export class BranchFinanceService {
  private readonly logger = new Logger(BranchFinanceService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly financeDailyBalance: FinanceDailyBalanceService,
    private readonly financeAudit: FinanceAuditService,
    private readonly branchDaySession: BranchDaySessionService,
    private readonly openingGate: OpeningChecklistGateService,
  ) {}

  async getBusinessSession(user: UserWithBranch, branchQuery?: string) {
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? effectiveBranchIdForQuery(user, branchQuery)
        : requireUserBranchId(user);

    if (!branchId) {
      throw new BadRequestException('Branch context is required.');
    }

    const snap = await this.branchDaySession.getSnapshot(branchId);
    const latestBalance = await this.getLatestBalance(user, branchQuery);

    return {
      ...snap,
      latestBalance: {
        startingBalance: latestBalance.startingBalance,
        endingBalance: latestBalance.endingBalance,
        date: latestBalance.date,
      },
    };
  }

  async endBranchDay(
    user: AuthenticatedUserProfile,
    dto: { confirmed: boolean; physicalEndingAmount?: number },
    audit?: { ipAddress?: string | null; userAgent?: string | null },
  ) {
    if (!dto.confirmed) {
      throw new BadRequestException({
        code: 'END_DAY_CONFIRMATION_REQUIRED',
        message:
          'Please confirm that you are ending the branch business day before proceeding.',
      });
    }

    const branchId = requireUserBranchId(user);

    const res = await this.branchDaySession.closeTodayManual({
      branchId,
      actorUserId: user.id ?? null,
      physicalEndingAmount: dto.physicalEndingAmount,
    });

    if (res.closureApplied) {
      const closingAmt =
        dto.physicalEndingAmount != null
          ? Number(dto.physicalEndingAmount.toFixed(2))
          : res.endingBalance;

      await this.financeAudit.log({
        branchId,
        userId: user.id ?? null,
        eventType: 'BRANCH_DAY_END_MANUAL',
        payload: {
          businessDate: res.businessDate,
          endingBalance: res.endingBalance,
          nextBusinessDate: res.nextBusinessDate,
          physicalEndingAmount: dto.physicalEndingAmount ?? null,
        },
        ipAddress: audit?.ipAddress ?? null,
        userAgent: audit?.userAgent ?? null,
      });

      await this.financeAudit.log({
        branchId,
        userId: user.id ?? null,
        eventType: 'DAILY_BALANCE_CLOSING',
        payload: {
          confirmedAmount: closingAmt,
          startingBalance: null,
          endingBalance: res.endingBalance,
          date: res.businessDate,
        },
        ipAddress: audit?.ipAddress ?? null,
        userAgent: audit?.userAgent ?? null,
      });
    }

    return {
      success: true,
      skipped: res.skipped ?? false,
      closureApplied: res.closureApplied ?? false,
      businessDate: res.businessDate,
      endingBalance: res.endingBalance,
      nextBusinessDate: res.nextBusinessDate,
    };
  }

  /**
   * Branch opening checklist status (shared by all employees at the branch).
   * Backed by daily_opening: unique (branch_id, opening_date). Employee ids are audit-only.
   */
  private async resolveExpectedStartingCash(
    branchId: string,
    openingDate: string,
  ): Promise<number> {
    const amount =
      await this.financeDailyBalance.suggestedStartingCashForBusinessDate(
        branchId,
        openingDate,
      );
    return Number(Number(amount).toFixed(2));
  }

  async getEmployeeDailyOpeningStatus(
    user: AuthenticatedUserProfile,
  ): Promise<EmployeeDailyOpeningStatus> {
    if (user.role === Role.SUPER_ADMIN) {
      const openingDate = getPhCalendarDateString();
      return {
        openingDate,
        status: 'completed',
        checklistStep: 'COMPLETED',
        modulesAllowed: true,
      };
    }

    const branchId = requireUserBranchId(user);
    const openingDate = getPhCalendarDateString();
    const openingDateRecord = new Date(`${openingDate}T00:00:00.000Z`);

    const modulesAllowed = await this.openingGate.isModulesAllowed(
      branchId,
      user.id ?? null,
    );

    const row = await this.prisma.daily_opening.findUnique({
      where: {
        branch_id_opening_date: {
          branch_id: branchId,
          opening_date: openingDateRecord,
        },
      },
      select: { status: true, starting_cash: true },
    });

    if (!modulesAllowed) {
      if (row?.status === 'pending') {
        return {
          openingDate,
          status: 'pending',
          checklistStep: 'INVENTORY_AUDIT',
          modulesAllowed: false,
          startingCash: this.toMoney(row.starting_cash),
        };
      }

      return {
        openingDate,
        status: row?.status === 'completed' ? 'completed' : 'none',
        checklistStep: 'CASH_ON_HAND',
        modulesAllowed: false,
        expectedStartingCash: await this.resolveExpectedStartingCash(
          branchId,
          openingDate,
        ),
        startingCash: row ? this.toMoney(row.starting_cash) : undefined,
      };
    }

    if (row?.status === 'completed') {
      return {
        openingDate,
        status: 'completed',
        checklistStep: 'COMPLETED',
        modulesAllowed: true,
        startingCash: this.toMoney(row.starting_cash),
      };
    }

    if (row?.status === 'pending') {
      return {
        openingDate,
        status: 'pending',
        checklistStep: 'INVENTORY_AUDIT',
        modulesAllowed: false,
        startingCash: this.toMoney(row.starting_cash),
      };
    }

    if (await this.branchDaySession.requiresStartingBalance(branchId)) {
      return {
        openingDate,
        status: 'none',
        checklistStep: 'CASH_ON_HAND',
        modulesAllowed: false,
        expectedStartingCash: await this.resolveExpectedStartingCash(
          branchId,
          openingDate,
        ),
      };
    }

    const pawnCount = await this.prisma.pawned_items.count({
      where: { branch_id: branchId },
    });

    if (pawnCount === 0) {
      return {
        openingDate,
        status: 'completed',
        checklistStep: 'COMPLETED',
        modulesAllowed: true,
        startingCash: 0,
      };
    }

    return {
      openingDate,
      status: 'none',
      checklistStep: 'CASH_ON_HAND',
      modulesAllowed: false,
      expectedStartingCash: await this.resolveExpectedStartingCash(
        branchId,
        openingDate,
      ),
    };
  }

  /**
   * Marks branch inventory step complete for today's Manila session (any employee may submit).
   */
  async completeEmployeeDailyOpening(user: AuthenticatedUserProfile) {
    if (user.role === Role.SUPER_ADMIN) {
      return { success: true, skipped: true as const };
    }

    const branchId = requireUserBranchId(user);
    const openingDate = getPhCalendarDateString();
    const client = this.supabaseService.getClient();
    const nowIso = new Date().toISOString();

    const { data: existing, error: selErr } = await client
      .from('daily_opening')
      .select('id, status')
      .eq('branch_id', branchId)
      .eq('opening_date', openingDate)
      .maybeSingle();

    if (selErr) {
      throw new InternalServerErrorException(selErr.message);
    }

    if (!existing) {
      throw new BadRequestException(
        'No branch opening record for today. Confirm branch starting cash first.',
      );
    }

    if (existing.status === 'completed') {
      return { success: true, alreadyCompleted: true as const };
    }

    const { error: updErr } = await client
      .from('daily_opening')
      .update({
        status: 'completed',
        updated_at: nowIso,
        last_updated_by_user_id: user.id ?? null,
      })
      .eq('branch_id', branchId)
      .eq('opening_date', openingDate);

    if (updErr) {
      throw new InternalServerErrorException(updErr.message);
    }

    await this.financeAudit.log({
      branchId,
      userId: user.id ?? null,
      eventType: 'BRANCH_OPENING_INVENTORY_COMPLETED',
      payload: { openingDate },
    });

    return { success: true };
  }

  /** Upsert pending branch opening after starting cash is confirmed (single session per branch/day). */
  private async upsertBranchDailyOpeningPending(params: {
    client: ReturnType<SupabaseService['getClient']>;
    actorUserId: string | null;
    branchId: string;
    openingDate: string;
    startingCash: number;
  }) {
    const nowIso = new Date().toISOString();
    const { error } = await params.client.from('daily_opening').upsert(
      {
        branch_id: params.branchId,
        opening_date: params.openingDate,
        starting_cash: params.startingCash,
        status: 'pending',
        employee_id: params.actorUserId,
        last_updated_by_user_id: params.actorUserId,
        updated_at: nowIso,
      },
      { onConflict: 'branch_id,opening_date' },
    );
    if (error) {
      this.logger.error(
        `daily_opening upsert failed (branch=${params.branchId} date=${params.openingDate}): ${error.message}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(error.message);
    }
  }

  private toMoney(
    value: Prisma.Decimal | number | string | null | undefined,
  ): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
  }

  private classifyTransaction(row: SummaryTxRow): LedgerEntryType {
    const purpose = (row.purpose ?? '').toLowerCase().trim();
    const unit = (row.unit ?? '').toLowerCase().trim();

    if (unit === 'fund_transfer' || purpose === 'cash transfer') {
      return 'fund_transfer_in';
    }
    if (unit === 'fund_transfer_out') {
      return 'fund_transfer_out';
    }
    if (purpose === 'pawn' || purpose === 'new pawn') {
      return 'pawn';
    }
    if (purpose === 'redeem') {
      return 'redeem';
    }
    if (purpose === 'buy back') {
      return 'buy_back';
    }
    if (
      purpose === 'renew' ||
      purpose === 'renewal' ||
      purpose === 'reappraise'
    ) {
      return 'renewal';
    }
    if (
      purpose === 'sold item' ||
      purpose === 'sale' ||
      purpose === 'sales transfer'
    ) {
      return 'sale';
    }
    if (purpose === 'start') {
      return 'start';
    }
    if (purpose === 'end') {
      return 'end';
    }
    return 'other';
  }

  private buildDescription(row: SummaryTxRow, type: LedgerEntryType): string {
    const parts: string[] = [];

    switch (type) {
      case 'pawn':
        parts.push('New Pawn');
        break;
      case 'redeem':
        parts.push('Redeem');
        break;
      case 'buy_back':
        parts.push('Buy Back');
        break;
      case 'renewal':
        parts.push('Renewal');
        break;
      case 'sale':
        parts.push('Sold Item');
        break;
      case 'fund_transfer_in':
        parts.push('Fund Transfer In');
        break;
      case 'fund_transfer_out':
        parts.push('Fund Transfer Out');
        break;
      case 'start':
        parts.push('Opening Balance');
        break;
      case 'end':
        parts.push('Closing Balance');
        break;
      default:
        parts.push(row.purpose ?? 'Transaction');
    }

    if (row.unit_code) {
      parts.push(`[${row.unit_code}]`);
    }

    if (row.details) {
      const truncated =
        row.details.length > 80
          ? row.details.slice(0, 80) + '...'
          : row.details;
      parts.push(`- ${truncated}`);
    }

    return parts.join(' ');
  }

  private getItemName(row: SummaryTxRow): string | null {
    if (!row.unit) return null;
    const lower = row.unit.toLowerCase().trim();
    if (lower === 'fund_transfer' || lower === 'fund_transfer_out') return null;
    return row.unit;
  }

  private mapToLedgerEntry(row: TransactionRow): LedgerEntry {
    const type = this.classifyTransaction(row);
    return {
      id: row.id,
      date: row.transaction_date ?? row.created_at.split('T')[0],
      time: row.transaction_time ?? null,
      type,
      description: this.buildDescription(row, type),
      itemName: this.getItemName(row),
      cashIn: this.toMoney(row.cash_in),
      cashOut: this.toMoney(row.cash_out),
      branchId: row.branch_id,
      branchName: row.branch ?? null,
      reference: row.unit_code ?? row.transaction_no ?? null,
    };
  }

  async getSummary(
    user: UserWithBranch,
    branchQuery?: string,
  ): Promise<BranchFinanceSummary[]> {
    const today = getPhCalendarDateString();

    const branchId =
      user.role === Role.SUPER_ADMIN
        ? effectiveBranchIdForQuery(user, branchQuery)
        : requireUserBranchId(user);

    const branches = await this.prisma.branches.findMany({
      where: branchId ? { id: branchId } : undefined,
      select: {
        id: true,
        name: true,
        branch_code: true,
        status: true,
        opening_cash_balance: true,
      },
      orderBy: { name: 'asc' },
    });

    if (branches.length === 0) {
      return [];
    }

    const branchIds = branches.map((b) => b.id);

    const client = this.supabaseService.getClient();

    const pendingFundTransferLinks = await this.prisma.fund_requests.findMany({
      where: {
        branch_id: { in: branchIds },
        status: { not: 'transferred' },
      },
      select: { branch_id: true, request_no: true },
    });
    const pendingFundTransfersByBranch = new Map<string, Set<string>>();
    for (const link of pendingFundTransferLinks) {
      if (!pendingFundTransfersByBranch.has(link.branch_id)) {
        pendingFundTransfersByBranch.set(link.branch_id, new Set());
      }
      pendingFundTransfersByBranch.get(link.branch_id)!.add(link.request_no);
    }

    const todaySessionDateUtc = new Date(`${today}T00:00:00.000Z`);
    const branchesWithDayClosedToday = new Set(
      (
        await this.prisma.branch_day_sessions.findMany({
          where: {
            branch_id: { in: branchIds },
            session_date: todaySessionDateUtc,
            is_closed: true,
          },
          select: { branch_id: true },
        })
      ).map((r) => r.branch_id),
    );

    const todayBalancesQuery = client
      .from('daily_balances')
      .select(
        'branch_id, record_date, starting_balance, ending_balance, updated_at',
      )
      .in('branch_id', branchIds)
      .eq('record_date', today);

    const todayTxQuery = client
      .from('transactions')
      .select(
        'branch_id, purpose, unit, unit_code, details, cash_in, cash_out, pawn_amount, storage_fee, voided_at',
      )
      .in('branch_id', branchIds)
      .eq('transaction_date', today)
      .is('voided_at', null);

    const fundReqQuery = client
      .from('fund_requests')
      .select('branch_id, status')
      .in('branch_id', branchIds)
      .in('status', ['pending', 'approved', 'transferred']);

    const [balancesResult, todayTxResult, fundReqResult] = await Promise.all([
      todayBalancesQuery,
      todayTxQuery,
      fundReqQuery,
    ]);

    if (balancesResult.error) {
      throw new InternalServerErrorException(balancesResult.error.message);
    }
    if (todayTxResult.error) {
      throw new InternalServerErrorException(todayTxResult.error.message);
    }
    if (fundReqResult.error) {
      throw new InternalServerErrorException(fundReqResult.error.message);
    }

    const todayByBranch = new Map(
      (balancesResult.data ?? []).map((r: DailyBalanceRow) => [r.branch_id, r]),
    );
    const needsPrior = branchIds.filter((id) => !todayByBranch.has(id));
    const priorByBranch = new Map<string, DailyBalanceRow>();
    /**
     * One round-trip via Prisma (session pooler-safe). The previous
     * `Promise.all(needsPrior.map(...))` issued N concurrent PostgREST requests and
     * exhausted Supabase session-mode pools (EMAXCONNSESSION / pool_size).
     */
    if (needsPrior.length > 0) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
        throw new InternalServerErrorException('Invalid branch calendar date');
      }
      try {
        const priorRows = await this.prisma.$queryRaw<
          Array<{
            branch_id: string;
            record_date: Date | string;
            starting_balance: string | number | null;
            ending_balance: string | number | null;
            updated_at: Date | string | null;
          }>
        >(Prisma.sql`
          SELECT DISTINCT ON (branch_id)
            branch_id,
            record_date,
            starting_balance,
            ending_balance,
            updated_at
          FROM daily_balances
          WHERE branch_id IN (${Prisma.join(
            needsPrior.map((id) => Prisma.sql`${id}::uuid`),
          )})
            AND record_date < CAST(${today} AS DATE)
          ORDER BY branch_id, record_date DESC
        `);

        for (const row of priorRows) {
          const recordDate = String(row.record_date).slice(0, 10);
          const updatedAtRaw = row.updated_at;
          priorByBranch.set(row.branch_id, {
            branch_id: row.branch_id,
            record_date: recordDate,
            starting_balance: row.starting_balance,
            ending_balance: row.ending_balance,
            updated_at:
              updatedAtRaw instanceof Date
                ? updatedAtRaw.toISOString()
                : updatedAtRaw != null
                  ? String(updatedAtRaw)
                  : null,
          });
        }
      } catch (err) {
        this.logger.error(
          `getSummary prior balances batch failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        throw new InternalServerErrorException(
          err instanceof Error ? err.message : 'Prior balance lookup failed',
        );
      }
    }

    const summaries: BranchFinanceSummary[] = await Promise.all(
      branches.map(async (branch) => {
        const openingFallback = this.toMoney(branch.opening_cash_balance);
        const snap = buildBranchDaySnapshotFromFetched({
          today,
          todayRow: todayByBranch.get(branch.id),
          priorRow: priorByBranch.get(branch.id),
          openingCashFallback: openingFallback,
        });
        const branchTx = (todayTxResult.data ?? []).filter(
          (t: any) => t.branch_id === branch.id,
        );
        const branchFundReqs = (fundReqResult.data ?? []).filter(
          (f: any) => f.branch_id === branch.id,
        );

        const breakdown = {
          pawnOut: 0,
          redeemIn: 0,
          buyBackIn: 0,
          renewalIn: 0,
          saleIn: 0,
          fundTransferIn: 0,
          fundTransferOut: 0,
          startBalance: 0,
          other: 0,
        };

        let todayCashIn = 0;
        let todayCashOut = 0;

        const operationalTx = branchTx.filter((tx: SummaryTxRow) => {
          if (tx.voided_at != null && tx.voided_at !== '') return false;
          const p = (tx.purpose ?? '').toLowerCase().trim();
          return p !== 'start' && p !== 'end';
        });

        const operationalForTotals =
          await this.financeDailyBalance.excludeInboundFundTransfersAwaitingReceiptRows(
            operationalTx,
            pendingFundTransfersByBranch,
          );

        for (const tx of operationalForTotals) {
          const ci = this.toMoney(tx.cash_in);
          const co = this.toMoney(tx.cash_out);
          todayCashIn += ci;
          todayCashOut += co;

          const type = this.classifyTransaction(tx);
          switch (type) {
            case 'pawn':
              breakdown.pawnOut += co;
              break;
            case 'redeem':
              breakdown.redeemIn += ci;
              break;
            case 'buy_back':
              breakdown.buyBackIn += ci;
              break;
            case 'renewal':
              breakdown.renewalIn += ci;
              break;
            case 'sale':
              breakdown.saleIn += ci;
              break;
            case 'fund_transfer_in':
              breakdown.fundTransferIn += ci;
              break;
            case 'fund_transfer_out':
              breakdown.fundTransferOut += co;
              break;
            default:
              breakdown.other += ci - co;
          }
        }

        breakdown.startBalance = snap.startingBalance;

        // Book ending from ledger movement (today in − today out), not only daily_balances.ending_balance
        // which can lag if balance rows were not updated for every posting.
        const ledgerEnding = Number(
          (snap.startingBalance + todayCashIn - todayCashOut).toFixed(2),
        );

        const dayClosedToday = branchesWithDayClosedToday.has(branch.id);
        const todayDbRow = todayByBranch.get(branch.id);
        let summaryStartingBalance = snap.startingBalance;
        let summaryCurrentBalance = ledgerEnding;
        if (dayClosedToday && todayDbRow) {
          const atRest = this.toMoney(todayDbRow.ending_balance);
          summaryStartingBalance = atRest;
          summaryCurrentBalance = atRest;
        }

        const fundReqSummary = { pending: 0, approved: 0, transferred: 0 };
        for (const fr of branchFundReqs) {
          if (fr.status === 'pending') fundReqSummary.pending++;
          else if (fr.status === 'approved') fundReqSummary.approved++;
          else if (fr.status === 'transferred') fundReqSummary.transferred++;
        }

        return {
          branchId: branch.id,
          branchName: branch.name,
          branchCode: branch.branch_code,
          status: branch.status,
          currentBalance: summaryCurrentBalance,
          startingBalance: summaryStartingBalance,
          todayCashIn: Number(todayCashIn.toFixed(2)),
          todayCashOut: Number(todayCashOut.toFixed(2)),
          breakdown: {
            pawnOut: Number(breakdown.pawnOut.toFixed(2)),
            redeemIn: Number(breakdown.redeemIn.toFixed(2)),
            buyBackIn: Number(breakdown.buyBackIn.toFixed(2)),
            renewalIn: Number(breakdown.renewalIn.toFixed(2)),
            saleIn: Number(breakdown.saleIn.toFixed(2)),
            fundTransferIn: Number(breakdown.fundTransferIn.toFixed(2)),
            fundTransferOut: Number(breakdown.fundTransferOut.toFixed(2)),
            startBalance: Number(breakdown.startBalance.toFixed(2)),
            other: Number(breakdown.other.toFixed(2)),
          },
          fundRequests: fundReqSummary,
        };
      }),
    );

    return summaries;
  }

  async getLedger(
    user: UserWithBranch,
    query: {
      branch?: string;
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{ entries: LedgerEntry[]; total: number }> {
    const client = this.supabaseService.getClient();

    const branchId =
      user.role === Role.SUPER_ADMIN
        ? effectiveBranchIdForQuery(user, query.branch)
        : requireUserBranchId(user);

    const page = Math.max(1, query.page ?? 1);
    // Allow wider pages for all-branch daily views so opening/closing rows
    // from every branch are not dropped when transaction volume is high.
    const limit = Math.min(1000, Math.max(1, query.limit ?? 200));
    const from = (page - 1) * limit;

    let dbQuery = client
      .from('transactions')
      .select('*', { count: 'exact' })
      .order('transaction_date', { ascending: true })
      .order('transaction_time', { ascending: true })
      .order('created_at', { ascending: true });

    if (branchId) {
      dbQuery = dbQuery.eq('branch_id', branchId);
    }
    if (query.dateFrom) {
      dbQuery = dbQuery.gte('transaction_date', query.dateFrom);
    }
    if (query.dateTo) {
      dbQuery = dbQuery.lte('transaction_date', query.dateTo);
    }

    dbQuery = dbQuery.range(from, from + limit - 1);

    const { data, error, count } = await dbQuery;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const filteredRows =
      await this.financeDailyBalance.excludeInboundFundTransfersAwaitingReceiptRows(
        (data ?? []) as TransactionRow[],
      );

    let entries = filteredRows.map((row: TransactionRow) =>
      this.mapToLedgerEntry(row),
    );

    if (query.type) {
      const filterTypes = query.type.split(',').map((t) => t.trim());
      entries = entries.filter((e) => filterTypes.includes(e.type));
    }

    return {
      entries,
      total: count ?? entries.length,
    };
  }

  async confirmDailyBalance(
    user: AuthenticatedUserProfile,
    type: 'starting' | 'ending',
    amount: number,
    audit?: { ipAddress?: string | null; userAgent?: string | null },
  ) {
    if (!type || !['starting', 'ending'].includes(type)) {
      throw new BadRequestException('type must be "starting" or "ending"');
    }
    if (type === 'ending') {
      throw new BadRequestException({
        code: 'USE_END_DAY_ENDPOINT',
        message:
          'To close the branch business day, use POST /branch-finance/end-day. Employee ending balances alone do not apply; closure is branch-wide.',
      });
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('amount must be a non-negative number');
    }

    const branchId = requireUserBranchId(user);
    const confirmedAmount = Number(amount.toFixed(2));

    const result = await this.branchDaySession.submitStartingBalance({
      branchId,
      actorUserId: user.id ?? null,
      actorRole: user.role,
      amount: confirmedAmount,
    });

    await this.financeAudit.log({
      branchId,
      userId: user.id ?? null,
      eventType: 'BRANCH_SESSION_OPENED',
      payload: {
        confirmedAmount,
        startingBalance: result.startingBalance,
        endingBalance: result.endingBalance,
        businessDate: result.businessDate,
      },
      ipAddress: audit?.ipAddress ?? null,
      userAgent: audit?.userAgent ?? null,
    });

    await this.financeAudit.log({
      branchId,
      userId: user.id ?? null,
      eventType: 'DAILY_BALANCE_OPENING',
      payload: {
        confirmedAmount,
        startingBalance: result.startingBalance,
        endingBalance: result.endingBalance,
        date: result.businessDate,
      },
      ipAddress: audit?.ipAddress ?? null,
      userAgent: audit?.userAgent ?? null,
    });

    return {
      success: true,
      type: 'starting' as const,
      amount: confirmedAmount,
      date: result.businessDate,
      startingBalance: result.startingBalance,
      endingBalance: result.endingBalance,
    };
  }

  async getLatestBalance(user: UserWithBranch, branchQuery?: string) {
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? effectiveBranchIdForQuery(user, branchQuery)
        : requireUserBranchId(user);

    if (!branchId) {
      return { startingBalance: 0, endingBalance: 0, date: null };
    }

    const today = getPhCalendarDateString();
    const todayDate = new Date(`${today}T00:00:00.000Z`);

    /** Before today's branch day is opened, UI expects prior book ending (last closed day), not today's partial ledger. */
    const daySession = await this.prisma.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: todayDate,
        },
      },
      select: { is_closed: true },
    });
    const needsStartingBalance = !daySession || daySession.is_closed;
    if (needsStartingBalance) {
      const basis =
        await this.financeDailyBalance.suggestedStartingBasisForBusinessDate(
          branchId,
          today,
        );
      const dateStr =
        basis.closedSessionRecordDate ?? addManilaCalendarDays(today, -1);
      return {
        startingBalance: basis.amount,
        endingBalance: basis.amount,
        date: dateStr,
      };
    }

    const todayRow = await this.prisma.daily_balances.findUnique({
      where: {
        branch_id_record_date: {
          branch_id: branchId,
          record_date: todayDate,
        },
      },
      select: { starting_balance: true, ending_balance: true },
    });

    if (todayRow) {
      const startingBalance = Number(
        new Prisma.Decimal(String(todayRow.starting_balance ?? 0)).toFixed(2),
      );
      const endingBalance =
        await this.financeDailyBalance.ledgerBookEndingForBusinessDate(
          branchId,
          today,
        );
      return {
        startingBalance,
        endingBalance,
        date: today,
      };
    }

    const priorRow = await this.prisma.daily_balances.findFirst({
      where: { branch_id: branchId, record_date: { lt: todayDate } },
      orderBy: { record_date: 'desc' },
      select: { record_date: true },
    });

    if (priorRow) {
      const priorStr = priorRow.record_date.toISOString().slice(0, 10);
      const bookEnding =
        await this.financeDailyBalance.ledgerBookEndingForBusinessDate(
          branchId,
          priorStr,
        );
      return {
        startingBalance: bookEnding,
        endingBalance: bookEnding,
        date: priorStr,
      };
    }

    const branchRow = await this.prisma.branches.findUnique({
      where: { id: branchId },
      select: { opening_cash_balance: true },
    });
    const opening = Number(
      new Prisma.Decimal(String(branchRow?.opening_cash_balance ?? 0)).toFixed(
        2,
      ),
    );

    return {
      startingBalance: opening,
      endingBalance: opening,
      date: null,
    };
  }
}
