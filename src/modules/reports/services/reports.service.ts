import { Injectable, Inject } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { effectiveBranchIdForQuery } from '../../../common/utils/branch-scope.util';

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

  async getSystemReport(user: AuthenticatedUserProfile, branchQuery?: string) {
    const client = this.supabaseService.getClient();
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // Resolve the effective branch to filter by
    const branchId = effectiveBranchIdForQuery(user, branchQuery);

    // Total transactions today
    let txnTodayQuery = client
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('transaction_date', todayStr);
    if (branchId) txnTodayQuery = txnTodayQuery.eq('branch_id', branchId);
    const { count: txnToday } = await txnTodayQuery;

    // Total sales today (cash_in)
    let salesTodayQuery = client
      .from('transactions')
      .select('cash_in')
      .eq('transaction_date', todayStr);
    if (branchId) salesTodayQuery = salesTodayQuery.eq('branch_id', branchId);
    const { data: salesData } = await salesTodayQuery;

    const totalSalesToday = (salesData || []).reduce(
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

    // Per-branch transaction counts + sales for today
    const branchSalesMap = new Map<
      string,
      { name: string; txn: number; sales: number }
    >();
    for (const branch of branches || []) {
      // If scoped to a single branch, only include that branch
      if (branchId && branch.id !== branchId) continue;
      branchSalesMap.set(branch.id, { name: branch.name, txn: 0, sales: 0 });
    }

    let todayTxnQuery = client
      .from('transactions')
      .select('branch_id, cash_in')
      .eq('transaction_date', todayStr);
    if (branchId) todayTxnQuery = todayTxnQuery.eq('branch_id', branchId);
    const { data: todayTxns } = await todayTxnQuery;

    for (const txn of todayTxns || []) {
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
          totalSalesToday > 0
            ? Number(((b.sales / totalSalesToday) * 100).toFixed(1))
            : 0,
      }))
      .sort((a, b) => b.sales - a.sales);

    // Average per branch
    const scopedBranchCount = branchSalesMap.size || 1;
    const avgPerBranch = Math.round(totalSalesToday / scopedBranchCount);

    // Sales trend (last 14 days)
    const fourteenDaysAgo = new Date(today);
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13);
    let trendQuery = client
      .from('transactions')
      .select('cash_in, transaction_date')
      .gte('transaction_date', fourteenDaysAgo.toISOString().split('T')[0])
      .order('transaction_date', { ascending: true });
    if (branchId) trendQuery = trendQuery.eq('branch_id', branchId);
    const { data: trendData } = await trendQuery;

    const trendMap = new Map<string, number>();
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - 13 + i);
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
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
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

    // Mark the highest day as "high"
    let maxSales = 0;
    let maxIdx = -1;
    salesTrend.forEach((entry, idx) => {
      if (entry.sales > maxSales) {
        maxSales = entry.sales;
        maxIdx = idx;
      }
    });
    if (maxIdx >= 0) salesTrend[maxIdx].type = 'high';

    // Average
    const totalTrendSales = salesTrend.reduce((sum, e) => sum + e.sales, 0);
    const trendAverage = Math.round(totalTrendSales / salesTrend.length);

    // Peak day
    const peakEntry = salesTrend.reduce(
      (best, e) => (e.sales > best.sales ? e : best),
      salesTrend[0] || { date: '-', sales: 0 },
    );

    // DSR (Daily Sales Report)
    let cashOutQuery = client
      .from('transactions')
      .select('cash_out')
      .eq('transaction_date', todayStr);
    if (branchId) cashOutQuery = cashOutQuery.eq('branch_id', branchId);
    const { data: cashOutData } = await cashOutQuery;

    const totalExpenses = (cashOutData || []).reduce(
      (sum, row) => sum + this.toMoney(row.cash_out),
      0,
    );

    // Opening balance from the latest starting balance transaction
    let openingQuery = client
      .from('transactions')
      .select('cash_in')
      .eq('transaction_date', todayStr)
      .eq('purpose', 'Start')
      .limit(1);
    if (branchId) openingQuery = openingQuery.eq('branch_id', branchId);
    const { data: openingTxn } = await openingQuery;

    const openingBalance = openingTxn?.[0]
      ? this.toMoney(openingTxn[0].cash_in)
      : 0;

    return {
      stats: {
        totalSalesToday,
        totalTransactions: txnToday ?? 0,
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
        date: todayStr,
        openingBalance,
        totalSales: totalSalesToday,
        totalExpenses,
        netTotal: totalSalesToday - totalExpenses,
      },
    };
  }

  async getBranchSummary(user: AuthenticatedUserProfile, branchQuery?: string) {
    return this.getSystemReport(user, branchQuery);
  }

  async getTransactionReport(
    user: AuthenticatedUserProfile,
    branchQuery?: string,
  ) {
    return this.getSystemReport(user, branchQuery);
  }
}
