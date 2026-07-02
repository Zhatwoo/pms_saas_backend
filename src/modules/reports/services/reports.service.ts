import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { effectiveBranchIdForQuery } from '../../../common/utils/branch-scope.util';
import { isNonRevenuePurpose } from '../../../common/enums';
import { Role } from '../../../common/enums';
import {
  applyEnvironmentFilter,
  getEnvironment,
} from '../../../common/utils/authorization.util';

type Period = 'daily' | 'weekly' | 'monthly' | 'yearly';

@Injectable()
export class ReportsService {
  constructor(
    @Inject(SupabaseService) private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  private toMoney(val: any): number {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') return parseFloat(val) || 0;
    return 0;
  }

  private resolveDateRange(
    period?: string,
    startDate?: string,
    endDate?: string,
  ): { fromDate: string; toDate: string; trendDays: number } {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const p = (period ?? 'daily').toLowerCase() as Period;

    // If explicit dates are provided, use them directly
    if (startDate && endDate) {
      const from = new Date(startDate);
      const to = new Date(endDate);
      const diffMs = to.getTime() - from.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1;
      return { fromDate: startDate, toDate: endDate, trendDays: diffDays };
    }

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

    const fromDate =
      p === 'daily' ? todayStr : from.toISOString().split('T')[0];
    return { fromDate, toDate: todayStr, trendDays };
  }

  async getSystemReport(
    user: AuthenticatedUserProfile,
    branchQuery?: string,
    period?: string,
    startDate?: string,
    endDate?: string,
  ) {
    const client = this.supabaseService.getClient();
    let { fromDate, toDate, trendDays } = this.resolveDateRange(
      period,
      startDate,
      endDate,
    );

    // When super-admin requests the system report for ALL branches and requests
    // a weekly period, align the range to the calendar week (Monday - Sunday)
    // instead of the last 7 days. This ensures consistent weekly reporting
    // across branches.
    if (
      (period ?? '').toLowerCase() === 'weekly' &&
      !branchQuery &&
      user?.role === Role.SUPER_ADMIN
    ) {
      const today = new Date();
      const day = today.getDay(); // 0 (Sun) .. 6 (Sat)
      const diffToMonday = (day + 6) % 7; // 0 for Mon, 6 for Sun
      const monday = new Date(today);
      monday.setDate(today.getDate() - diffToMonday);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      fromDate = monday.toISOString().split('T')[0];
      toDate = sunday.toISOString().split('T')[0];
      trendDays = 7;
    }

    const branchId = effectiveBranchIdForQuery(user, branchQuery);

    // Total transactions for the period
    let txnQuery = client
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate);
    txnQuery = txnQuery.eq('environment', getEnvironment(user));
    if (branchId) txnQuery = txnQuery.eq('branch_id', branchId);
    const { count: txnCount } = await txnQuery;

    // Total sales for the period (cash_in from revenue-generating purposes only)
    let salesQuery = client
      .from('transactions')
      .select('cash_in, purpose')
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate);
    salesQuery = salesQuery.eq('environment', getEnvironment(user));
    if (branchId) salesQuery = salesQuery.eq('branch_id', branchId);
    const { data: salesData } = await salesQuery;

    // Sum sales for the requested period
    const periodTotalSales = (salesData || []).reduce(
      (sum, row) =>
        isNonRevenuePurpose(row.purpose)
          ? sum
          : sum + this.toMoney(row.cash_in),
      0,
    );

    // Also compute today's sales (useful for the dashboard stat "Total Sales Today")
    const todayStr = new Date().toISOString().split('T')[0];
    let todaySalesQuery = client
      .from('transactions')
      .select('cash_in, purpose')
      .eq('transaction_date', todayStr);
    todaySalesQuery = todaySalesQuery.eq('environment', getEnvironment(user));
    if (branchId) todaySalesQuery = todaySalesQuery.eq('branch_id', branchId);
    const { data: todaySalesData } = await todaySalesQuery;
    const totalSalesToday = (todaySalesData || []).reduce(
      (sum, row) =>
        isNonRevenuePurpose(row.purpose)
          ? sum
          : sum + this.toMoney(row.cash_in),
      0,
    );

    // Active branches
    const branches = await this.prisma.branches.findMany({
      where: applyEnvironmentFilter(user, branchId ? { id: branchId } : {}),
      select: {
        id: true,
        name: true,
        status: true,
      },
    });

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
      .select('branch_id, cash_in, purpose')
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate);
    periodTxnQuery = periodTxnQuery.eq('environment', getEnvironment(user));
    if (branchId) periodTxnQuery = periodTxnQuery.eq('branch_id', branchId);
    const { data: periodTxns } = await periodTxnQuery;

    for (const txn of periodTxns || []) {
      const entry = branchSalesMap.get(txn.branch_id);
      if (entry) {
        entry.txn += 1;
        if (!isNonRevenuePurpose(txn.purpose)) {
          entry.sales += this.toMoney(txn.cash_in);
        }
      }
    }

    const branchSales = Array.from(branchSalesMap.values())
      .map((b) => ({
        ...b,
        share:
          periodTotalSales > 0
            ? Number(((b.sales / periodTotalSales) * 100).toFixed(1))
            : 0,
      }))
      .sort((a, b) => b.sales - a.sales);

    const scopedBranchCount = branchSalesMap.size || 1;
    const avgPerBranch = Math.round(periodTotalSales / scopedBranchCount);

    // Sales trend — use the actual date range from the request
    const trendStart = fromDate;
    const trendEnd = toDate;
    let trendQuery = client
      .from('transactions')
      .select('cash_in, transaction_date, purpose')
      .gte('transaction_date', trendStart)
      .lte('transaction_date', trendEnd)
      .order('transaction_date', { ascending: true });
    trendQuery = trendQuery.eq('environment', getEnvironment(user));
    if (branchId) trendQuery = trendQuery.eq('branch_id', branchId);
    const { data: trendData } = await trendQuery;

    const trendMap = new Map<string, number>();
    // Build a map for every day in the range
    const rangeStart = new Date(trendStart);
    const rangeEnd = new Date(trendEnd);
    for (
      let d = new Date(rangeStart);
      d <= rangeEnd;
      d.setDate(d.getDate() + 1)
    ) {
      trendMap.set(d.toISOString().split('T')[0], 0);
    }

    for (const row of trendData || []) {
      if (!row.transaction_date || isNonRevenuePurpose(row.purpose)) continue;
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
    const trendAverage =
      salesTrend.length > 0
        ? Math.round(totalTrendSales / salesTrend.length)
        : 0;

    const peakEntry = salesTrend.reduce(
      (best, e) => (e.sales > best.sales ? e : best),
      salesTrend[0] || { date: '-', sales: 0 },
    );

    // DSR (expenses — excludes journal entries)
    let cashOutQuery = client
      .from('transactions')
      .select('cash_out, purpose')
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate);
    cashOutQuery = cashOutQuery.eq('environment', getEnvironment(user));
    if (branchId) cashOutQuery = cashOutQuery.eq('branch_id', branchId);
    const { data: cashOutData } = await cashOutQuery;

    const totalExpenses = (cashOutData || []).reduce((sum, row) => {
      const p = (row.purpose ?? '').trim().toLowerCase();
      if (p === 'start' || p === 'end') return sum;
      return sum + this.toMoney(row.cash_out);
    }, 0);

    // Opening balance
    let openingQuery = client
      .from('transactions')
      .select('cash_in')
      .eq('transaction_date', fromDate)
      .eq('purpose', 'Start')
      .limit(1);
    openingQuery = openingQuery.eq('environment', getEnvironment(user));
    if (branchId) openingQuery = openingQuery.eq('branch_id', branchId);
    const { data: openingTxn } = await openingQuery;

    const openingBalance = openingTxn?.[0]
      ? this.toMoney(openingTxn[0].cash_in)
      : 0;

    return {
      stats: {
        totalSalesToday: totalSalesToday,
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
        date: fromDate === toDate ? fromDate : `${fromDate} – ${toDate}`,
        openingBalance,
        totalSales: periodTotalSales,
        totalExpenses,
        netTotal: periodTotalSales - totalExpenses,
      },
    };
  }

  async getBranchSummary(
    user: AuthenticatedUserProfile,
    branchQuery?: string,
    period?: string,
    startDate?: string,
    endDate?: string,
  ) {
    return this.getSystemReport(user, branchQuery, period, startDate, endDate);
  }

  async getTransactionReport(
    user: AuthenticatedUserProfile,
    branchQuery?: string,
    period?: string,
    startDate?: string,
    endDate?: string,
  ) {
    return this.getSystemReport(user, branchQuery, period, startDate, endDate);
  }
}
