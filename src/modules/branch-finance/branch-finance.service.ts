import { Injectable, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { Role, TransactionPurpose } from '../../common/enums';
import type { UserWithBranch } from '../../common/utils/branch-scope.util';
import {
  effectiveBranchIdForQuery,
  requireUserBranchId,
} from '../../common/utils/branch-scope.util';
import { SupabaseService } from '../../infrastructure/supabase/supabase.service';
import {
  computeBranchDaySnapshot,
  netCashFromTransactions,
} from '../../common/utils/daily-balance-aggregate.util';

interface TransactionRow {
  id: string;
  transaction_no: string | null;
  branch_id: string;
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
  branchId: string;
  branchName: string | null;
  reference: string | null;
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
  constructor(private readonly supabaseService: SupabaseService) {}

  private toMoney(value: number | string | null | undefined): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
  }

  private classifyTransaction(row: TransactionRow): LedgerEntryType {
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
    if (purpose === 'renew' || purpose === 'renewal' || purpose === 'reappraise') {
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

  private buildDescription(row: TransactionRow, type: LedgerEntryType): string {
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

  private getItemName(row: TransactionRow): string | null {
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
    const today = new Date().toISOString().split('T')[0];

    const branchId =
      user.role === Role.SUPER_ADMIN
        ? effectiveBranchIdForQuery(user, branchQuery)
        : requireUserBranchId(user);

    let branchesQuery = client
      .from('branches')
      .select('id, name, branch_code, status')
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

    const balancesQuery = client
      .from('daily_balances')
      .select(
        'branch_id, record_date, starting_balance, ending_balance, updated_at',
      )
      .in('branch_id', branchIds)
      .order('record_date', { ascending: false })
      .limit(4000);

    const todayTxQuery = client
      .from('transactions')
      .select(
        'branch_id, purpose, unit, cash_in, cash_out, pawn_amount, storage_fee',
      )
      .in('branch_id', branchIds)
      .eq('transaction_date', today);

    const fundReqQuery = client
      .from('fund_requests')
      .select('branch_id, status')
      .in('branch_id', branchIds)
      .in('status', ['pending', 'approved', 'transferred']);

    const [balancesResult, todayTxResult, fundReqResult] = await Promise.all([
      balancesQuery,
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

    const balanceRows = (balancesResult.data ?? []) as DailyBalanceRow[];

    const summaries: BranchFinanceSummary[] = (branches as BranchRow[]).map(
      (branch) => {
        const snap = computeBranchDaySnapshot(balanceRows, branch.id, today);
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

        const operationalTx = branchTx.filter((tx: TransactionRow) => {
          const p = (tx.purpose ?? '').toLowerCase().trim();
          return p !== 'start' && p !== 'end';
        });

        for (const tx of operationalTx) {
          const ci = this.toMoney(tx.cash_in);
          const co = this.toMoney(tx.cash_out);
          todayCashIn += ci;
          todayCashOut += co;

          const type = this.classifyTransaction(tx as TransactionRow);
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

        // Always compute ending balance dynamically:
        // End Day = Start Day + Σ(cash_in) - Σ(cash_out)
        const endingBalance = Number(
          (snap.startingBalance + netCashFromTransactions(operationalTx)).toFixed(2),
        );

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
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
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
    user: UserWithBranch,
    type: 'starting' | 'ending',
    amount: number,
  ) {
    if (!type || !['starting', 'ending'].includes(type)) {
      throw new BadRequestException('type must be "starting" or "ending"');
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('amount must be a non-negative number');
    }

    const branchId = requireUserBranchId(user);
    const client = this.supabaseService.getClient();
    const today = new Date().toISOString().split('T')[0];
    const confirmedAmount = Number(amount.toFixed(2));

    // When setting starting balance, compute net of today's transactions
    // so ending_balance = starting + net (not just starting, which would wipe adjustments).
    let todayNet = 0;
    if (type === 'starting') {
      const { data: todayTxs } = await client
        .from('transactions')
        .select('purpose, cash_in, cash_out')
        .eq('branch_id', branchId)
        .eq('transaction_date', today);

      todayNet = (todayTxs ?? []).reduce((sum: number, tx: any) => {
        const p = String(tx.purpose ?? '').toLowerCase().trim();
        if (p === 'start' || p === 'end') return sum;
        return (
          sum +
          (parseFloat(String(tx.cash_in ?? 0)) || 0) -
          (parseFloat(String(tx.cash_out ?? 0)) || 0)
        );
      }, 0);
    }

    const { data: existing, error: existingError } = await client
      .from('daily_balances')
      .select('id, starting_balance, ending_balance')
      .eq('branch_id', branchId)
      .eq('record_date', today)
      .maybeSingle();

    if (existingError) {
      throw new InternalServerErrorException(existingError.message);
    }

    if (existing) {
      const update =
        type === 'starting'
          ? {
              starting_balance: confirmedAmount,
              ending_balance: Number((confirmedAmount + todayNet).toFixed(2)),
            }
          : { ending_balance: confirmedAmount };
      const { error: updateError } = await client
        .from('daily_balances')
        .update(update)
        .eq('id', existing.id);
      if (updateError) {
        throw new InternalServerErrorException(updateError.message);
      }
    } else {
      const row: Record<string, unknown> = {
        branch_id: branchId,
        record_date: today,
      };
      if (type === 'starting') {
        row.starting_balance = confirmedAmount;
        row.ending_balance = Number((confirmedAmount + todayNet).toFixed(2));
      } else {
        // Carry forward the previous day's ending balance as today's starting balance.
        let carryForwardBalance = 0;
        const { data: priorRow } = await client
          .from('daily_balances')
          .select('ending_balance')
          .eq('branch_id', branchId)
          .lt('record_date', today)
          .order('record_date', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (priorRow) {
          carryForwardBalance = Number(
            Number(priorRow.ending_balance ?? 0).toFixed(2),
          );
        }
        row.starting_balance = carryForwardBalance;
        row.ending_balance = confirmedAmount;
      }
      const { error: insertError } = await client
        .from('daily_balances')
        .insert(row);
      if (insertError) {
        throw new InternalServerErrorException(insertError.message);
      }
    }

    // Upsert a journal transaction so it appears in ledger.
    // cash_in/cash_out are ZERO — Start/End are not real cash movement;
    // they only record the confirmed balance in daily_balances.
    const purpose = type === 'starting' ? TransactionPurpose.START : TransactionPurpose.END;
    const { data: branch } = await client
      .from('branches')
      .select('name')
      .eq('id', branchId)
      .maybeSingle();

    // Idempotency: one Start and one End per branch per day (update if exists).
    const { data: existingTx } = await client
      .from('transactions')
      .select('id')
      .eq('branch_id', branchId)
      .eq('transaction_date', today)
      .eq('purpose', purpose)
      .maybeSingle();

    const txPayload = {
      transaction_no: `${purpose.toUpperCase()}-${Date.now()}`,
      branch_id: branchId,
      branch: branch?.name ?? 'Unknown',
      purpose,
      transaction_date: today,
      transaction_time: new Date().toTimeString().slice(0, 8),
      cash_in: 0,
      cash_out: 0,
      details: `${type === 'starting' ? 'Opening' : 'Closing'} balance confirmed: ₱${confirmedAmount.toLocaleString()}`,
    };

    if (existingTx) {
      await client
        .from('transactions')
        .update(txPayload)
        .eq('id', existingTx.id);
    } else {
      await client.from('transactions').insert([txPayload]);
    }

    return { success: true, type, amount: confirmedAmount, date: today };
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
    const today = new Date().toISOString().split('T')[0];

    // 1. Get starting balance
    let startingBalance = 0;
    let recordDate: string | null = null;

    const { data: todayRow } = await client
      .from('daily_balances')
      .select('starting_balance, ending_balance, record_date')
      .eq('branch_id', branchId)
      .eq('record_date', today)
      .maybeSingle();

    if (todayRow) {
      startingBalance = this.toMoney(todayRow.starting_balance);
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
        recordDate = priorRow.record_date;
      }
    }

    // 2. Dynamically compute ending balance from today's transactions
    const { data: todayTxs } = await client
      .from('transactions')
      .select('purpose, cash_in, cash_out')
      .eq('branch_id', branchId)
      .eq('transaction_date', today);

    const todayNet = (todayTxs ?? []).reduce((sum: number, tx: any) => {
      const p = String(tx.purpose ?? '').toLowerCase().trim();
      if (p === 'start' || p === 'end') return sum;
      return (
        sum +
        (parseFloat(String(tx.cash_in ?? 0)) || 0) -
        (parseFloat(String(tx.cash_out ?? 0)) || 0)
      );
    }, 0);

    return {
      startingBalance,
      endingBalance: Number((startingBalance + todayNet).toFixed(2)),
      date: recordDate,
    };
  }
}
