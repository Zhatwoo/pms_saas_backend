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

      return {
        branchId: branch.id,
        branchCode: branch.branch_code,
        name: branch.name,
        location: branch.location ?? null,
        status: branch.status ?? 'Unknown',
        startingBalance: this.toMoney(latestBalance?.starting_balance),
        currentBalance: this.toMoney(latestBalance?.ending_balance),
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
        return { view: 'employee', data: 'Own branch transactions and items' };
      default:
        return { view: 'guest', data: null };
    }
  }
}
