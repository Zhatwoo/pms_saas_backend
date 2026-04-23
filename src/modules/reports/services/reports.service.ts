import { Injectable, Inject } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { effectiveBranchIdForQuery } from '../../../common/utils/branch-scope.util';

type Period = 'daily' | 'weekly' | 'monthly' | 'yearly';

@Injectable()
export class ReportsService {
  constructor(
    @Inject(SupabaseService) private readonly supabaseService: SupabaseService,
  ) {}

  private toMoney(val: any): number {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') return parseFloat(val) || 0;
    return 0;
  }

  private resolveDateRange(period?: string): { fromDate: string; toDate: string; trendDays: number } {
    const today = new Date();
    const toDate = today.toISOString().split('T')[0];
    const p = (period ?? 'daily').toLowerCase() as Period;

    const from = new Date(today);
    let trendDays = 14;

    switch (p) {
      case 'weekly':
        from.setDate(from.getDate() - 6);
        trendDays = 7;
        break;
      case 'monthly':
        from.setDate(from.getDate() - 29);
        trendDays = 30;
        break;
      case 'yearly':
        from.setFullYear(from.getFullYear() - 1);
        from.setDate(from.getDate() + 1);
        trendDays = 365;
        break;
      default: // daily
        trendDays = 14;
        break;
    }

    const fromDate = p === 'daily' ? toDate : from.toISOString().split('T')[0];
    return { fromDate, toDate, trendDays };
  }

  async getSystemReport(user: AuthenticatedUserProfile, branchQuery?: string, period?: string) {
    const client = this.supabaseService.getClient();
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const { fromDate, toDate, trendDays } = this.resolveDateRange(period);
    const isDaily = fromDate === toDate;

    const branchId = effectiveBranchIdForQuery(user, branchQuery);

    // Total transactions for the period
    let txnQuery = client
      .from('transactions')
      .select('id', { count: 'exact', head: true });
    if (isDaily) {
      txnQuery = txnQuery.eq('transaction_date', todayStr);
    } else {
      txnQuery = txnQuery.gte('transaction_date', fromDate).lte('transaction_date', toDate);
    }
    if (branchId) txnQuery = txnQuery.eq('branch_id', branchId);
    const { count: txnCount } = await txnQuery;

    // Total sales for the period (cash_in)
    let salesQuery = client
      .from('transactions')
      .select('cash_in');
    if (isDaily) {
      salesQuery = salesQuery.eq('transaction_date', todayStr);
    } else {
      salesQuery = salesQuery.gte('transaction_date', fromDate).lte('transaction_date', toDate);
    }
    if (branchId) salesQuery = salesQuery.eq('branch_id', branchId);
    const { data: salesData } = await salesQuery;

    const totalSales = (salesData || []).reduce(
      (sum, row) => sum + this.toMoney(row.cash_in),
      0,
    );

    // Active branches
    const { data: branches } = await client
      .from('branches')
      .select('id, name, status');

    const activeBranches = (branches || []).filter(
      (b) => b.status === 'Active',
    ).length;
    const totalBranches = (branches || []).length;

    // Per-branch transaction counts + sales for the period
    const branchSalesMap = new Map<
      string,
      { name: string; txn: number; sales: number }
    >();
    for (const branch of branches || []) {
      if (branchId && branch.id !== branchId) continue;
      branchSalesMap.set(branch.id, { name: branch.name, txn: 0, sales: 0 });
    }

    let periodTxnQuery = client
      .from('transactions')
      .select('branch_id, cash_in');
    if (isDaily) {
      periodTxnQuery = periodTxnQuery.eq('transaction_date', todayStr);
    } else {
      periodTxnQuery = periodTxnQuery.gte('transaction_date', fromDate).lte('transaction_date', toDate);
    }
    if (branchId) periodTxnQuery = periodTxnQuery.eq('branch_id', branchId);
    const { data: periodTxns } = await periodTxnQuery;

    for (const txn of periodTxns || []) {
      const entry = branchSalesMap.get(txn.branch_id);
      if (entry) {
        entry.txn += 1;
        entry.sales += this.toMoney(txn.cash_in);
      }
    }

    const branchSales = Array.from(branchSalesMap.values())
      .map((b) => ({
        ...b,
        share:
          totalSales > 0
            ? Number(((b.sales / totalSales) * 100).toFixed(1))
            : 0,
      }))
      .sort((a, b) => b.sales - a.sales);

    const scopedBranchCount = branchSalesMap.size || 1;
    const avgPerBranch = Math.round(totalSales / scopedBranchCount);

    // Sales trend
    const trendStart = new Date(today);
    trendStart.setDate(trendStart.getDate() - (trendDays - 1));
    let trendQuery = client
      .from('transactions')
      .select('cash_in, transaction_date')
      .gte('transaction_date', trendStart.toISOString().split('T')[0])
      .order('transaction_date', { ascending: true });
    if (branchId) trendQuery = trendQuery.eq('branch_id', branchId);
    const { data: trendData } = await trendQuery;

    const trendMap = new Map<string, number>();
    for (let i = 0; i < trendDays; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - (trendDays - 1) + i);
      trendMap.set(d.toISOString().split('T')[0], 0);
    }

    for (const row of trendData || []) {
      if (!row.transaction_date) continue;
      const current = trendMap.get(row.transaction_date);
      if (current !== undefined) {
        trendMap.set(row.transaction_date, current + this.toMoney(row.cash_in));
      }
    }

    const monthNames = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const salesTrend = Array.from(trendMap.entries()).map(([date, sales]) => {
      const d = new Date(date);
      const dayOfWeek = d.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      return {
        date: `${monthNames[d.getMonth()]} ${d.getDate()}`,
        sales,
        type: isWeekend ? 'weekend' : 'weekday',
      };
    });

    let maxSales = 0;
    let maxIdx = -1;
    salesTrend.forEach((entry, idx) => {
      if (entry.sales > maxSales) {
        maxSales = entry.sales;
        maxIdx = idx;
      }
    });
    if (maxIdx >= 0) salesTrend[maxIdx].type = 'high';

    const totalTrendSales = salesTrend.reduce((sum, e) => sum + e.sales, 0);
    const trendAverage = salesTrend.length > 0 ? Math.round(totalTrendSales / salesTrend.length) : 0;

    const peakEntry = salesTrend.reduce(
      (best, e) => (e.sales > best.sales ? e : best),
      salesTrend[0] || { date: '-', sales: 0 },
    );

    // DSR (expenses)
    let cashOutQuery = client
      .from('transactions')
      .select('cash_out');
    if (isDaily) {
      cashOutQuery = cashOutQuery.eq('transaction_date', todayStr);
    } else {
      cashOutQuery = cashOutQuery.gte('transaction_date', fromDate).lte('transaction_date', toDate);
    }
    if (branchId) cashOutQuery = cashOutQuery.eq('branch_id', branchId);
    const { data: cashOutData } = await cashOutQuery;

    const totalExpenses = (cashOutData || []).reduce(
      (sum, row) => sum + this.toMoney(row.cash_out),
      0,
    );

    // Opening balance
    let openingQuery = client
      .from('transactions')
      .select('cash_in')
      .eq('transaction_date', fromDate)
      .eq('purpose', 'Start')
      .limit(1);
    if (branchId) openingQuery = openingQuery.eq('branch_id', branchId);
    const { data: openingTxn } = await openingQuery;

    const openingBalance = openingTxn?.[0]
      ? this.toMoney(openingTxn[0].cash_in)
      : 0;

    return {
      stats: {
        totalSalesToday: totalSales,
        totalTransactions: txnCount ?? 0,
        avgPerBranch,
        activeBranches,
        totalBranches,
      },
      branchSales,
      salesTrend,
      trendSummary: {
        average: trendAverage,
        peakDate: peakEntry?.date ?? '-',
        peakSales: peakEntry?.sales ?? 0,
      },
      dailyReport: {
        date: fromDate === toDate ? todayStr : `${fromDate} – ${toDate}`,
        openingBalance,
        totalSales,
        totalExpenses,
        netTotal: totalSales - totalExpenses,
      },
    };
  }

  async getBranchSummary(user: AuthenticatedUserProfile, branchQuery?: string, period?: string) {
    return this.getSystemReport(user, branchQuery, period);
  }

  async getTransactionReport(user: AuthenticatedUserProfile, branchQuery?: string, period?: string) {
    return this.getSystemReport(user, branchQuery, period);
  }
}
