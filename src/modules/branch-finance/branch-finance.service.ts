import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { Role } from '../../common/enums';
import type { UserWithBranch } from '../../common/utils/branch-scope.util';
import {
  effectiveBranchIdForQuery,
  requireUserBranchId,
} from '../../common/utils/branch-scope.util';
import { getPhCalendarDateString } from '../../common/utils/branch-calendar-date.util';
import {
  SupabaseService,
  type AuthenticatedUserProfile,
} from '../../infrastructure/supabase/supabase.service';
import { buildBranchDaySnapshotFromFetched } from '../../common/utils/daily-balance-aggregate.util';
import { FinanceAuditService } from './services/finance-audit.service';
import { FinanceDailyBalanceService } from './services/finance-daily-balance.service';
import { BranchBusinessSessionService } from './services/branch-business-session.service';

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
  opening_cash_balance?: number | string | null;
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
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly financeDailyBalance: FinanceDailyBalanceService,
    private readonly financeAudit: FinanceAuditService,
    private readonly branchBusinessSession: BranchBusinessSessionService,
  ) {}

  async getBusinessSession(user: UserWithBranch, branchQuery?: string) {
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? effectiveBranchIdForQuery(user, branchQuery)
        : requireUserBranchId(user);

    if (!branchId) {
      throw new BadRequestException('Branch context is required.');
    }

    const snap = await this.branchBusinessSession.getSnapshot(branchId);
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

    const res = await this.branchBusinessSession.endBranchDayManual({
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
  async getEmployeeDailyOpeningStatus(
    user: AuthenticatedUserProfile,
  ): Promise<EmployeeDailyOpeningStatus> {
    if (user.role !== Role.EMPLOYEE) {
      const openingDate = getPhCalendarDateString();
      return {
        openingDate,
        status: 'completed',
        checklistStep: 'COMPLETED',
      };
    }

    const branchId = requireUserBranchId(user);
    const openingDate = getPhCalendarDateString();
    const client = this.supabaseService.getClient();

    const { data: row, error } = await client
      .from('daily_opening')
      .select('status, starting_cash')
      .eq('branch_id', branchId)
      .eq('opening_date', openingDate)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (row?.status === 'completed') {
      return {
        openingDate,
        status: 'completed',
        checklistStep: 'COMPLETED',
        startingCash: this.toMoney(row.starting_cash),
      };
    }

    if (row?.status === 'pending') {
      return {
        openingDate,
        status: 'pending',
        checklistStep: 'INVENTORY_AUDIT',
        startingCash: this.toMoney(row.starting_cash),
      };
    }

    const { count, error: countErr } = await client
      .from('pawned_items')
      .select('*', { count: 'exact', head: true })
      .eq('branch_id', branchId);

    if (countErr) {
      throw new InternalServerErrorException(countErr.message);
    }

    const total = count ?? 0;
    if (total === 0) {
      const nowIso = new Date().toISOString();
      const { error: upErr } = await client.from('daily_opening').upsert(
        {
          branch_id: branchId,
          opening_date: openingDate,
          starting_cash: 0,
          status: 'completed',
          employee_id: user.id ?? null,
          last_updated_by_user_id: user.id ?? null,
          updated_at: nowIso,
        },
        { onConflict: 'branch_id,opening_date' },
      );
      if (upErr) {
        throw new InternalServerErrorException(upErr.message);
      }
      return {
        openingDate,
        status: 'completed',
        checklistStep: 'COMPLETED',
        startingCash: 0,
      };
    }

    return {
      openingDate,
      status: 'none',
      checklistStep: 'CASH_ON_HAND',
    };
  }

  /**
   * Marks branch inventory step complete for today's Manila session (any employee may submit).
   */
  async completeEmployeeDailyOpening(user: AuthenticatedUserProfile) {
    if (user.role !== Role.EMPLOYEE) {
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
      throw new InternalServerErrorException(error.message);
    }
  }

  private toMoney(value: number | string | null | undefined): number {
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
    const client = this.supabaseService.getClient();
    const today = getPhCalendarDateString();

    const branchId =
      user.role === Role.SUPER_ADMIN
        ? effectiveBranchIdForQuery(user, branchQuery)
        : requireUserBranchId(user);

    let branchesQuery = client
      .from('branches')
      .select('id, name, branch_code, status, opening_cash_balance')
      .order('name', { ascending: true });

    if (branchId) {
      branchesQuery = branchesQuery.eq('id', branchId);
    }

    const { data: branches, error: branchesErr } = await branchesQuery;
    if (branchesErr) {
      throw new InternalServerErrorException(branchesErr.message);
    }

    if (!branches || branches.length === 0) {
      return [];
    }

    const branchIds = (branches as BranchRow[]).map((b) => b.id);

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
    await Promise.all(
      needsPrior.map(async (bid) => {
        const { data, error } = await client
          .from('daily_balances')
          .select(
            'branch_id, record_date, starting_balance, ending_balance, updated_at',
          )
          .eq('branch_id', bid)
          .lt('record_date', today)
          .order('record_date', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) {
          throw new InternalServerErrorException(error.message);
        }
        if (data) priorByBranch.set(bid, data as DailyBalanceRow);
      }),
    );

    const summaries: BranchFinanceSummary[] = (branches as BranchRow[]).map(
      (branch) => {
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

        for (const tx of operationalTx) {
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

        const endingBalance = snap.endingBalance;

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
          currentBalance: endingBalance,
          startingBalance: snap.startingBalance,
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
      },
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

    let entries = (data ?? []).map((row: any) =>
      this.mapToLedgerEntry(row as TransactionRow),
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

    const result = await this.branchBusinessSession.submitStartingBalance({
      branchId,
      actorUserId: user.id ?? null,
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

    const client = this.supabaseService.getClient();
    const today = getPhCalendarDateString();

    let startingBalance = 0;
    let endingBalance = 0;
    let recordDate: string | null = null;

    const { data: todayRow } = await client
      .from('daily_balances')
      .select('starting_balance, ending_balance, record_date')
      .eq('branch_id', branchId)
      .eq('record_date', today)
      .maybeSingle();

    if (todayRow) {
      startingBalance = this.toMoney(todayRow.starting_balance);
      endingBalance = this.toMoney(todayRow.ending_balance);
      recordDate = todayRow.record_date;
    } else {
      // Carry forward previous day's ending balance
      const { data: priorRow } = await client
        .from('daily_balances')
        .select('ending_balance, record_date')
        .eq('branch_id', branchId)
        .lt('record_date', today)
        .order('record_date', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (priorRow) {
        startingBalance = this.toMoney(priorRow.ending_balance);
        endingBalance = startingBalance;
        recordDate = priorRow.record_date;
      } else {
        const { data: branchRow } = await client
          .from('branches')
          .select('opening_cash_balance')
          .eq('id', branchId)
          .maybeSingle();
        const opening = this.toMoney(branchRow?.opening_cash_balance);
        startingBalance = opening;
        endingBalance = opening;
        recordDate = null;
      }
    }

    return {
      startingBalance,
      endingBalance,
      date: recordDate,
    };
  }
}
