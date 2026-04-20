import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Role } from '../../../common/enums';
import { requireUserBranchId } from '../../../common/utils/branch-scope.util';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

interface DashboardRelationUser {
  id: string;
  full_name: string | null;
  email: string | null;
}

interface DashboardRelationBranch {
  id: string;
  name: string;
  branch_code: string | null;
}

interface BranchRecord {
  id: string;
  name: string;
  branch_code: string | null;
  location?: string | null;
  status: string | null;
}

interface DailyBalanceRow {
  branch_id: string;
  record_date: string;
  starting_balance: number | string | null;
  ending_balance: number | string | null;
  updated_at?: string | null;
}

interface TransferredFundRow {
  branch_id: string;
  amount_transferred: number | string | null;
  transferred_at: string | null;
}

interface DashboardFundRequestListRow {
  id: string;
  request_no: string;
  status: string;
  amount_requested: number | string;
  approved_amount: number | string | null;
  amount_transferred: number | string | null;
  purpose: string;
  created_at: string;
  transferred_at: string | null;
  branches: DashboardRelationBranch | DashboardRelationBranch[] | null;
  requested_by: DashboardRelationUser | DashboardRelationUser[] | null;
}

@Injectable()
export class DashboardService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private toMoney(value: number | string | null | undefined): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
  }

  private summarizeFundRequests(
    rows: Array<{
      status: string;
      amount_requested: number | string;
      approved_amount: number | string | null;
      amount_transferred: number | string | null;
    }>,
  ) {
    return rows.reduce(
      (summary, row) => {
        summary.total += 1;
        summary.totalRequested = Number(
          (summary.totalRequested + this.toMoney(row.amount_requested)).toFixed(
            2,
          ),
        );
        summary.totalApproved = Number(
          (summary.totalApproved + this.toMoney(row.approved_amount)).toFixed(
            2,
          ),
        );
        summary.totalTransferred = Number(
          (
            summary.totalTransferred + this.toMoney(row.amount_transferred)
          ).toFixed(2),
        );

        switch (row.status) {
          case 'pending':
          case 'pending_source_confirmation':
            summary.pending += 1;
            break;
          case 'approved':
            summary.approved += 1;
            break;
          case 'pending_confirmation':
            summary.pending += 1;
            break;
          case 'rejected':
            summary.rejected += 1;
            break;
          case 'transferred':
            summary.transferred += 1;
            break;
          case 'cancelled':
            summary.cancelled += 1;
            break;
          default:
            break;
        }

        return summary;
      },
      {
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
        transferred: 0,
        cancelled: 0,
        totalRequested: 0,
        totalApproved: 0,
        totalTransferred: 0,
      },
    );
  }

  private buildBranchFinanceSummaries(params: {
    branches: BranchRecord[];
    latestBalances: DailyBalanceRow[];
    transferredFunds: TransferredFundRow[];
  }) {
    const latestBalanceByBranch = new Map<string, DailyBalanceRow>();
    for (const row of params.latestBalances) {
      if (!latestBalanceByBranch.has(row.branch_id)) {
        latestBalanceByBranch.set(row.branch_id, row);
      }
    }

    const transferredSummaryByBranch = new Map<
      string,
      { totalAdded: number; lastTransferredAt: string | null }
    >();
    for (const row of params.transferredFunds) {
      const current = transferredSummaryByBranch.get(row.branch_id) ?? {
        totalAdded: 0,
        lastTransferredAt: null,
      };
      transferredSummaryByBranch.set(row.branch_id, {
        totalAdded: Number(
          (current.totalAdded + this.toMoney(row.amount_transferred)).toFixed(
            2,
          ),
        ),
        lastTransferredAt: current.lastTransferredAt ?? row.transferred_at,
      });
    }

    return params.branches.map((branch) => {
      const latestBalance = latestBalanceByBranch.get(branch.id);
      const transferred = transferredSummaryByBranch.get(branch.id);
      const startingBalance = this.toMoney(latestBalance?.starting_balance);
      const computedCurrentBalance = Number(
        (startingBalance + (transferred?.totalAdded ?? 0)).toFixed(2),
      );

      return {
        branchId: branch.id,
        branchCode: branch.branch_code,
        name: branch.name,
        location: branch.location ?? null,
        status: branch.status ?? 'Unknown',
        startingBalance,
        currentBalance: latestBalance
          ? this.toMoney(latestBalance?.ending_balance)
          : computedCurrentBalance,
        totalAdded: transferred?.totalAdded ?? 0,
        totalTransferred: 0,
        lastUpdated:
          latestBalance?.updated_at ??
          latestBalance?.record_date ??
          transferred?.lastTransferredAt ??
          null,
      };
    });
  }

  private mapDashboardFundRequest(row: DashboardFundRequestListRow) {
    const branch = Array.isArray(row.branches)
      ? (row.branches[0] ?? null)
      : (row.branches ?? null);
    const requestedBy = Array.isArray(row.requested_by)
      ? (row.requested_by[0] ?? null)
      : (row.requested_by ?? null);

    return {
      id: row.id,
      requestNo: row.request_no,
      status: row.status,
      amountRequested: this.toMoney(row.amount_requested),
      approvedAmount:
        row.approved_amount == null ? null : this.toMoney(row.approved_amount),
      amountTransferred:
        row.amount_transferred == null
          ? null
          : this.toMoney(row.amount_transferred),
      purpose: row.purpose,
      createdAt: row.created_at,
      transferredAt: row.transferred_at,
      branch: branch
        ? {
            id: branch.id,
            name: branch.name,
            branchCode: branch.branch_code,
          }
        : null,
      requestedBy: requestedBy
        ? {
            id: requestedBy.id,
            fullName: requestedBy.full_name,
            email: requestedBy.email,
          }
        : null,
    };
  }

  async getDashboard(user: AuthenticatedUserProfile) {
    const client = this.supabaseService.getClient();

    switch (user?.role) {
      case Role.SUPER_ADMIN: {
        const [
          branchesCountResult,
          activeBranchesCountResult,
          usersCountResult,
          pendingUsersCountResult,
          branchesResult,
          latestBalancesResult,
          transferredFundsResult,
          fundRowsResult,
          recentRequestsResult,
          recentTransfersResult,
        ] = await Promise.all([
          client.from('branches').select('id', { count: 'exact', head: true }),
          client
            .from('branches')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'Active'),
          client.from('users').select('id', { count: 'exact', head: true }),
          client
            .from('users')
            .select('id', { count: 'exact', head: true })
            .eq('account_status', 'pending'),
          client
            .from('branches')
            .select('id, name, branch_code, location, status')
            .order('name', { ascending: true }),
          client
            .from('daily_balances')
            .select(
              'branch_id, record_date, starting_balance, ending_balance, updated_at',
            )
            .order('record_date', { ascending: false }),
          client
            .from('fund_requests')
            .select('branch_id, amount_transferred, transferred_at')
            .eq('status', 'transferred'),
          client
            .from('fund_requests')
            .select(
              'status, amount_requested, approved_amount, amount_transferred',
            ),
          client
            .from('fund_requests')
            .select(
              `
                id,
                request_no,
                status,
                amount_requested,
                approved_amount,
                amount_transferred,
                purpose,
                created_at,
                transferred_at,
                branches:branches!fund_requests_branch_id_fkey(id, name, branch_code),
                requested_by:requested_by_user_id(id, full_name, email)
              `,
            )
            .order('created_at', { ascending: false })
            .limit(8),
          client
            .from('fund_requests')
            .select(
              `
                id,
                request_no,
                status,
                amount_requested,
                approved_amount,
                amount_transferred,
                purpose,
                created_at,
                transferred_at,
                branches:branches!fund_requests_branch_id_fkey(id, name, branch_code),
                requested_by:requested_by_user_id(id, full_name, email)
              `,
            )
            .eq('status', 'transferred')
            .order('transferred_at', { ascending: false })
            .limit(8),
        ]);

        const errors = [
          branchesCountResult.error,
          activeBranchesCountResult.error,
          usersCountResult.error,
          pendingUsersCountResult.error,
          branchesResult.error,
          latestBalancesResult.error,
          transferredFundsResult.error,
          fundRowsResult.error,
          recentRequestsResult.error,
          recentTransfersResult.error,
        ].filter(Boolean);

        if (errors.length > 0) {
          throw new InternalServerErrorException(errors[0]?.message);
        }

        return {
          view: 'super_admin',
          summary: {
            branches: {
              total: branchesCountResult.count ?? 0,
              active: activeBranchesCountResult.count ?? 0,
              inactive:
                (branchesCountResult.count ?? 0) -
                (activeBranchesCountResult.count ?? 0),
            },
            users: {
              total: usersCountResult.count ?? 0,
              pendingApproval: pendingUsersCountResult.count ?? 0,
            },
            fundRequests: this.summarizeFundRequests(fundRowsResult.data ?? []),
          },
          branchBalances: this.buildBranchFinanceSummaries({
            branches: (branchesResult.data ?? []) as BranchRecord[],
            latestBalances: (latestBalancesResult.data ??
              []) as DailyBalanceRow[],
            transferredFunds: (transferredFundsResult.data ??
              []) as TransferredFundRow[],
          }),
          recentFundRequests: (recentRequestsResult.data ?? []).map((row) =>
            this.mapDashboardFundRequest(row),
          ),
          latestTransfers: (recentTransfersResult.data ?? []).map((row) =>
            this.mapDashboardFundRequest(row),
          ),
        };
      }
      case Role.ADMIN: {
        const branchId = requireUserBranchId(user);
        const [
          branchResult,
          fundRowsResult,
          latestBalanceResult,
          transferredFundsResult,
        ] = await Promise.all([
          client
            .from('branches')
            .select('id, name, branch_code, location, status')
            .eq('id', branchId)
            .maybeSingle(),
          client
            .from('fund_requests')
            .select(
              `
                  id,
                  request_no,
                  status,
                  amount_requested,
                  approved_amount,
                  amount_transferred,
                  purpose,
                  created_at,
                  transferred_at,
                  branches:branches!fund_requests_branch_id_fkey(id, name, branch_code),
                  requested_by:requested_by_user_id(id, full_name, email)
                `,
            )
            .eq('branch_id', branchId)
            .order('created_at', { ascending: false }),
          client
            .from('daily_balances')
            .select('ending_balance, record_date')
            .eq('branch_id', branchId)
            .order('record_date', { ascending: false })
            .limit(1)
            .maybeSingle(),
          client
            .from('fund_requests')
            .select('branch_id, amount_transferred, transferred_at')
            .eq('branch_id', branchId)
            .eq('status', 'transferred'),
        ]);

        const errors = [
          branchResult.error,
          fundRowsResult.error,
          latestBalanceResult.error,
          transferredFundsResult.error,
        ].filter(Boolean);

        if (errors.length > 0) {
          throw new InternalServerErrorException(errors[0]?.message);
        }

        return {
          view: 'admin',
          branch: branchResult.data,
          branchFinance:
            this.buildBranchFinanceSummaries({
              branches: branchResult.data
                ? [branchResult.data as BranchRecord]
                : [],
              latestBalances: latestBalanceResult.data
                ? [latestBalanceResult.data as DailyBalanceRow]
                : [],
              transferredFunds: (transferredFundsResult.data ??
                []) as TransferredFundRow[],
            })[0] ?? null,
          currentBalance: this.toMoney(
            latestBalanceResult.data?.ending_balance,
          ),
          fundRequests: {
            summary: this.summarizeFundRequests(fundRowsResult.data ?? []),
            recent: (fundRowsResult.data ?? [])
              .slice(0, 8)
              .map((row) => this.mapDashboardFundRequest(row)),
          },
        };
      }
      case Role.EMPLOYEE:
        const employeeBranchId = requireUserBranchId(user);
        const [
          employeeBranchResult,
          employeeFundRowsResult,
          employeeLatestBalanceResult,
          employeeTransferredFundsResult,
        ] = await Promise.all([
          client
            .from('branches')
            .select('id, name, branch_code, location, status')
            .eq('id', employeeBranchId)
            .maybeSingle(),
          client
            .from('fund_requests')
            .select(
              `
                id,
                request_no,
                status,
                amount_requested,
                approved_amount,
                amount_transferred,
                purpose,
                created_at,
                transferred_at,
                branches:branches!fund_requests_branch_id_fkey(id, name, branch_code),
                requested_by:requested_by_user_id(id, full_name, email)
              `,
            )
            .eq('branch_id', employeeBranchId)
            .order('created_at', { ascending: false }),
          client
            .from('daily_balances')
            .select('ending_balance, record_date, starting_balance')
            .eq('branch_id', employeeBranchId)
            .order('record_date', { ascending: false })
            .limit(1)
            .maybeSingle(),
          client
            .from('fund_requests')
            .select('branch_id, amount_transferred, transferred_at')
            .eq('branch_id', employeeBranchId)
            .eq('status', 'transferred'),
        ]);

        const employeeErrors = [
          employeeBranchResult.error,
          employeeFundRowsResult.error,
          employeeLatestBalanceResult.error,
          employeeTransferredFundsResult.error,
        ].filter(Boolean);

        if (employeeErrors.length > 0) {
          throw new InternalServerErrorException(employeeErrors[0]?.message);
        }

        return {
          view: 'employee',
          branch: employeeBranchResult.data,
          branchFinance:
            this.buildBranchFinanceSummaries({
              branches: employeeBranchResult.data
                ? [employeeBranchResult.data as BranchRecord]
                : [],
              latestBalances: employeeLatestBalanceResult.data
                ? [employeeLatestBalanceResult.data as DailyBalanceRow]
                : [],
              transferredFunds: (employeeTransferredFundsResult.data ??
                []) as TransferredFundRow[],
            })[0] ?? null,
          currentBalance: this.toMoney(
            employeeLatestBalanceResult.data?.ending_balance,
          ),
          fundRequests: {
            summary: this.summarizeFundRequests(employeeFundRowsResult.data ?? []),
            recent: (employeeFundRowsResult.data ?? [])
              .slice(0, 8)
              .map((row) => this.mapDashboardFundRequest(row)),
          },
        };
      default:
        return { view: 'guest', data: null };
    }
  }

  async getPawnKpis(user: AuthenticatedUserProfile, branchFilter?: string) {
    const client = this.supabaseService.getClient();
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // Determine branch scope
    const isAdmin = user?.role === Role.SUPER_ADMIN;
    const branchId = !isAdmin ? requireUserBranchId(user) : (branchFilter || null);

    // Build base queries
    const buildPawnQuery = (baseQuery: any) => {
      let q = baseQuery;
      if (branchId) q = q.eq('branch_id', branchId);
      return q;
    };

    // 1. Active pawn contracts
    const activeQuery = buildPawnQuery(
      client.from('pawned_items').select('id', { count: 'exact', head: true }).eq('status', 'Active'),
    );
    // 2. Items near expiration (maturity within 7 days)
    const twentyThreeDaysAgo = new Date(today);
    twentyThreeDaysAgo.setDate(twentyThreeDaysAgo.getDate() - 23);
    const nearExpQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Active')
        .lte('pawn_date', twentyThreeDaysAgo.toISOString().split('T')[0]),
    );
    // 3. Items ready for sale
    let saleQuery = client
      .from('sale_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'Available');
    if (branchId) saleQuery = saleQuery.eq('branch_id', branchId);

    // 4. Total contracts (overall)
    const totalContractsQuery = buildPawnQuery(
      client.from('pawned_items').select('id', { count: 'exact', head: true }),
    );
    // 5. Redeemed
    const redeemedQuery = buildPawnQuery(
      client.from('pawned_items').select('id', { count: 'exact', head: true }).eq('status', 'Redeemed'),
    );
    // 6. Expired (redeemed overdue)
    const expiredQuery = buildPawnQuery(
      client.from('pawned_items').select('id', { count: 'exact', head: true }).eq('status', 'Expired'),
    );

    // 7. Monthly revenue from transactions
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    let revenueQuery = client
      .from('transactions')
      .select('cash_in')
      .gte('transaction_date', firstOfMonth);
    if (branchId) revenueQuery = revenueQuery.eq('branch_id', branchId);

    // 8. Contract trends (last 6 months)
    const sixMonthsAgo = new Date(today);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    let contractTrendQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('status, pawn_date')
        .gte('pawn_date', sixMonthsAgo.toISOString().split('T')[0]),
    );

    // 9. Revenue trend (last 6 months)
    let revenueTrendQuery = client
      .from('transactions')
      .select('cash_in, transaction_date')
      .gte('transaction_date', sixMonthsAgo.toISOString().split('T')[0]);
    if (branchId) revenueTrendQuery = revenueTrendQuery.eq('branch_id', branchId);

    // 10. Items needing attention (near expiration, with detail)
    let attentionQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('id, item_name, item_id, amount, pawn_date, status')
        .eq('status', 'Active')
        .lte('pawn_date', todayStr)
        .order('pawn_date', { ascending: true })
        .limit(10),
    );

    // 11. Total sales revenue (sold items price)
    let totalSalesQuery = client
      .from('sale_items')
      .select('price')
      .eq('status', 'Sold');
    if (branchId) totalSalesQuery = totalSalesQuery.eq('branch_id', branchId);

    const [
      activeResult,
      nearExpResult,
      saleResult,
      totalContractsResult,
      redeemedResult,
      expiredResult,
      revenueResult,
      contractTrendResult,
      revenueTrendResult,
      attentionResult,
      totalSalesResult,
    ] = await Promise.all([
      activeQuery,
      nearExpQuery,
      saleQuery,
      totalContractsQuery,
      redeemedQuery,
      expiredQuery,
      revenueQuery,
      contractTrendQuery,
      revenueTrendQuery,
      attentionQuery,
      totalSalesQuery,
    ]);

    // Compute monthly revenue
    const monthlyRevenue = (revenueResult.data || []).reduce(
      (sum: number, row: any) => sum + this.toMoney(row.cash_in),
      0,
    );

    // Compute total overall sales
    const totalOverallSales = (totalSalesResult.data || []).reduce(
      (sum: number, row: any) => sum + this.toMoney(row.price),
      0,
    );

    // Build contract trends by month
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const contractTrendMap = new Map<string, { contracts: number; redeemed: number }>();
    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - 5 + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      contractTrendMap.set(key, { contracts: 0, redeemed: 0 });
    }
    for (const row of contractTrendResult.data || []) {
      if (!row.pawn_date) continue;
      const key = row.pawn_date.substring(0, 7);
      const entry = contractTrendMap.get(key);
      if (entry) {
        entry.contracts += 1;
        if (row.status === 'Redeemed') entry.redeemed += 1;
      }
    }
    const contractTrends = Array.from(contractTrendMap.entries()).map(([key, val]) => {
      const [, month] = key.split('-');
      return { month: monthNames[parseInt(month) - 1], contracts: val.contracts, redeemed: val.redeemed };
    });

    // Build revenue trend by month
    const revenueTrendMap = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - 5 + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      revenueTrendMap.set(key, 0);
    }
    for (const row of revenueTrendResult.data || []) {
      if (!row.transaction_date) continue;
      const key = row.transaction_date.substring(0, 7);
      const current = revenueTrendMap.get(key);
      if (current !== undefined) {
        revenueTrendMap.set(key, current + this.toMoney(row.cash_in));
      }
    }
    const revenueTrend = Array.from(revenueTrendMap.entries()).map(([key, revenue]) => {
      const [, month] = key.split('-');
      return { month: monthNames[parseInt(month) - 1], revenue };
    });

    // Build attention items
    const attentionItems = (attentionResult.data || []).map((item: any) => {
      const maturityDate = new Date(item.pawn_date);
      maturityDate.setDate(maturityDate.getDate() + 30);
      const daysRemaining = Math.ceil((maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      let badgeLabel = `${daysRemaining} days left`;
      let badgeVariant: 'yellow' | 'red' | 'orange' = 'yellow';
      if (daysRemaining <= 0) {
        badgeLabel = 'Overdue';
        badgeVariant = 'red';
      } else if (daysRemaining <= 3) {
        badgeLabel = `${daysRemaining} day${daysRemaining > 1 ? 's' : ''} left`;
        badgeVariant = 'red';
      } else if (daysRemaining <= 7) {
        badgeLabel = `${daysRemaining} days left`;
        badgeVariant = 'orange';
      }

      return {
        id: item.id,
        name: item.item_name,
        contract: item.item_id,
        amount: `₱ ${this.toMoney(item.amount).toLocaleString()}`,
        badge: { label: badgeLabel, variant: badgeVariant },
      };
    });

    // Notifications (recent items that expired)
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

    let notifQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('id, item_name, item_id, pawn_date')
        .eq('status', 'Active')
        .lte('pawn_date', thirtyDaysAgoStr)
        .order('pawn_date', { ascending: true })
        .limit(5),
    );
    const notifResult = await notifQuery;
    const notifications = (notifResult.data || []).map((item: any, idx: number) => {
      const matDate = new Date(item.pawn_date);
      matDate.setDate(matDate.getDate() + 30);
      return {
        id: item.id || idx,
        message: `${item.item_name} (${item.item_id}) has passed its maturity date`,
        time: matDate.toISOString().split('T')[0],
      };
    });

    return {
      overallData: {
        totalContracts: totalContractsResult.count ?? 0,
        active: activeResult.count ?? 0,
        redeemed: redeemedResult.count ?? 0,
        redeemedOverdue: expiredResult.count ?? 0,
        totalOverallSales: `₱ ${totalOverallSales.toLocaleString()}`,
      },
      kpiData: {
        activeContracts: activeResult.count ?? 0,
        itemsNearExpiration: nearExpResult.count ?? 0,
        itemsReadyForSale: saleResult.count ?? 0,
        monthlyRevenue: `₱ ${monthlyRevenue.toLocaleString()}`,
      },
      contractTrends,
      revenueTrend,
      notifications,
      attentionItems,
    };
  }

  async getExpirationMonitoring(user: AuthenticatedUserProfile, branchFilter?: string) {
    const client = this.supabaseService.getClient();
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    const isAdmin = user?.role === Role.SUPER_ADMIN;
    const branchId = !isAdmin ? requireUserBranchId(user) : (branchFilter || null);

    // Fetch all active pawned items with pawn_date
    let query = client
      .from('pawned_items')
      .select('id, item_id, item_name, category, branch, amount, pawn_date, status, customer_id, customers(full_name)')
      .eq('status', 'Active')
      .not('pawn_date', 'is', null)
      .order('pawn_date', { ascending: true });

    if (branchId) query = query.eq('branch_id', branchId);

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const items = (data || []).map((item: any) => {
      const maturityDate = new Date(item.pawn_date);
      maturityDate.setDate(maturityDate.getDate() + 30);
      const daysRemaining = Math.ceil((maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      const customer = Array.isArray(item.customers) ? item.customers[0] : item.customers;

      return {
        id: item.id,
        ticketNo: item.item_id,
        customer: customer?.full_name || 'Unknown',
        item: item.item_name,
        principal: this.toMoney(item.amount),
        totalDue: Number((this.toMoney(item.amount) * 1.035).toFixed(2)),
        maturityDate: maturityDate.toISOString().split('T')[0],
        daysRemaining,
      };
    });

    // Bucket items
    const overdue = items.filter((i: any) => i.daysRemaining <= 0);
    const within3 = items.filter((i: any) => i.daysRemaining > 0 && i.daysRemaining <= 3);
    const within7 = items.filter((i: any) => i.daysRemaining > 0 && i.daysRemaining <= 7);
    const within30 = items.filter((i: any) => i.daysRemaining > 0 && i.daysRemaining <= 30);

    return {
      stats: {
        overdue: overdue.length,
        threeDays: within3.length,
        sevenDays: within7.length,
        thirtyDays: within30.length,
      },
      items,
      buckets: {
        overdue,
        threeDays: within3,
        sevenDays: within7,
        thirtyDays: within30,
      },
    };
  }
}

