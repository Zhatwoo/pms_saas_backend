import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { Role, isNonRevenuePurpose } from '../../../common/enums';
import { requireUserBranchId } from '../../../common/utils/branch-scope.util';
import { buildBranchDaySnapshotFromFetched } from '../../../common/utils/daily-balance-aggregate.util';
import { getPhCalendarDateString } from '../../../common/utils/branch-calendar-date.util';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { PrismaService } from '../../../infrastructure/prisma';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { findInterestRateGroup } from '../../../common/utils/inventory-valuation.util';
import {
  applyEnvironmentFilter,
  getEnvironment,
} from '../../../common/utils/authorization.util';

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
  opening_cash_balance?: number | string | null;
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

export interface ExpirationMonitoringItem {
  id: string;
  ticketNo: string;
  customer: string;
  customerEmail: string | null;
  item: string;
  principal: number;
  totalDue: number;
  maturityDate: string;
  daysRemaining: number;
}

interface ExpirationBuckets {
  overdue: ExpirationMonitoringItem[];
  threeDays: ExpirationMonitoringItem[];
  sevenDays: ExpirationMonitoringItem[];
  thirtyDays: ExpirationMonitoringItem[];
}

@Injectable()
export class DashboardService {
  private transporter: Transporter | null = null;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private resolveExpirationBranchScope(
    user: AuthenticatedUserProfile,
    branchFilter?: string,
  ) {
    const isSuperAdmin = user?.role === Role.SUPER_ADMIN;
    return !isSuperAdmin ? requireUserBranchId(user) : branchFilter || null;
  }

  private bucketExpirationItems(
    items: ExpirationMonitoringItem[],
  ): ExpirationBuckets {
    const overdue = items.filter((i) => i.daysRemaining <= 0);
    const threeDays = items.filter(
      (i) => i.daysRemaining > 0 && i.daysRemaining <= 3,
    );
    const sevenDays = items.filter(
      (i) => i.daysRemaining > 0 && i.daysRemaining <= 7,
    );
    const thirtyDays = items.filter(
      (i) => i.daysRemaining > 0 && i.daysRemaining <= 30,
    );

    return {
      overdue,
      threeDays,
      sevenDays,
      thirtyDays,
    };
  }

  private getBucketItems(
    bucket: string | undefined,
    grouped: ExpirationBuckets,
  ) {
    switch ((bucket || '30days').toLowerCase()) {
      case 'overdue':
        return grouped.overdue;
      case '3days':
      case 'three_days':
      case 'three-days':
        return grouped.threeDays;
      case '7days':
      case 'seven_days':
      case 'seven-days':
        return grouped.sevenDays;
      case '30days':
      case 'thirty_days':
      case 'thirty-days':
      default:
        return grouped.thirtyDays;
    }
  }

  private async sendResendEmail(
    to: string,
    subject: string,
    html: string,
  ): Promise<{ deliveredTo: string; testMode: boolean }> {
    const smtpUser = process.env.GMAIL_USER || process.env.SMTP_USER;
    const smtpPass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;

    if (!smtpUser || !smtpPass) {
      throw new InternalServerErrorException(
        'Email service is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in backend env.',
      );
    }

    if (!this.transporter) {
      const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
      const smtpPort = Number(process.env.SMTP_PORT || 465);
      const smtpSecure =
        process.env.SMTP_SECURE == null
          ? true
          : process.env.SMTP_SECURE === 'true';

      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
    }

    const fromAddress = process.env.SMTP_FROM || smtpUser;
    const fromName = process.env.SMTP_FROM_NAME || 'Pawnshop';

    try {
      await this.transporter.sendMail({
        from: `${fromName} <${fromAddress}>`,
        to,
        subject,
        html,
      });
      return { deliveredTo: to, testMode: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Failed to send email via Gmail SMTP: ${message}`,
      );
    }
  }

  private buildEmailLayout(params: {
    title: string;
    subtitle: string;
    greeting: string;
    bodyHtml: string;
  }) {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>${params.title}</title>
        </head>
        <body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;color:#1f2937;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 0;">
            <tr>
              <td align="center">
                <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
                  <tr>
                    <td style="background:linear-gradient(90deg,#0f766e,#0b5d56);padding:20px 24px;">
                      <div style="font-size:20px;font-weight:700;color:#f8d26a;">JCLB Pawnshop</div>
                      <div style="margin-top:4px;font-size:13px;color:#d1fae5;">${params.subtitle}</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:24px;">
                      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">${params.greeting}</p>
                      ${params.bodyHtml}
                      <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#4b5563;">
                        If you already completed this action, you may disregard this message.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;">
                      <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.5;">
                        This is an automated service email from JCLB Pawnshop Management System.
                        Please contact your branch directly for account-specific concerns.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
  }

  private buildSingleReminderEmail(params: {
    customerName: string;
    itemName: string;
    ticketNo: string;
    maturityDate: string;
    daysRemaining: number;
    totalDue: number;
  }) {
    const statusLabel =
      params.daysRemaining <= 0
        ? 'Overdue'
        : `${params.daysRemaining} day${params.daysRemaining > 1 ? 's' : ''} remaining`;

    const body = `
      <h2 style="margin:0 0 12px;font-size:20px;color:#111827;">Maturity Reminder</h2>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
        This is a courtesy reminder regarding your pawned item details below.
      </p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:10px 12px;background:#f8fafc;font-size:12px;color:#6b7280;">Ticket No.</td><td style="padding:10px 12px;font-size:13px;font-weight:600;">${params.ticketNo}</td></tr>
        <tr><td style="padding:10px 12px;background:#f8fafc;font-size:12px;color:#6b7280;">Item</td><td style="padding:10px 12px;font-size:13px;">${params.itemName}</td></tr>
        <tr><td style="padding:10px 12px;background:#f8fafc;font-size:12px;color:#6b7280;">Maturity Date</td><td style="padding:10px 12px;font-size:13px;">${params.maturityDate}</td></tr>
        <tr><td style="padding:10px 12px;background:#f8fafc;font-size:12px;color:#6b7280;">Status</td><td style="padding:10px 12px;font-size:13px;">${statusLabel}</td></tr>
        <tr><td style="padding:10px 12px;background:#f8fafc;font-size:12px;color:#6b7280;">Estimated Total Due</td><td style="padding:10px 12px;font-size:13px;font-weight:700;color:#0f766e;">PHP ${params.totalDue.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:14px;line-height:1.6;">
        To avoid additional penalties, please visit your nearest branch for renewal or redemption.
      </p>
    `;

    return this.buildEmailLayout({
      title: 'Pawn Item Maturity Notice',
      subtitle: 'Contract Monitoring Notification',
      greeting: `Dear ${params.customerName},`,
      bodyHtml: body,
    });
  }

  private buildBlastReminderEmail(params: {
    customerName: string;
    bucketLabel: string;
    items: Array<{
      ticketNo: string;
      itemName: string;
      maturityDate: string;
      daysRemaining: number;
      totalDue: number;
    }>;
  }) {
    const rows = params.items
      .map(
        (item) => `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-size:12px;">${item.ticketNo}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-size:12px;">${item.itemName}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-size:12px;">${item.maturityDate}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-size:12px;">${item.daysRemaining <= 0 ? 'Overdue' : `${item.daysRemaining} day(s)`}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:right;">PHP ${item.totalDue.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        </tr>
      `,
      )
      .join('');

    const body = `
      <h2 style="margin:0 0 12px;font-size:20px;color:#111827;">Expiration Alert Summary</h2>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;">
        You have pawn contracts tagged under <strong>${params.bucketLabel}</strong>. Please review the details below.
      </p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:10px;text-align:left;font-size:11px;color:#6b7280;">Ticket No.</th>
            <th style="padding:10px;text-align:left;font-size:11px;color:#6b7280;">Item</th>
            <th style="padding:10px;text-align:left;font-size:11px;color:#6b7280;">Maturity Date</th>
            <th style="padding:10px;text-align:left;font-size:11px;color:#6b7280;">Status</th>
            <th style="padding:10px;text-align:right;font-size:11px;color:#6b7280;">Total Due</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:16px 0 0;font-size:14px;line-height:1.6;">
        For assistance, please contact your servicing branch to process renewal or redemption.
      </p>
    `;

    return this.buildEmailLayout({
      title: 'Pawn Expiration Reminder',
      subtitle: 'Bulk Expiration Monitoring Notice',
      greeting: `Dear ${params.customerName},`,
      bodyHtml: body,
    });
  }

  private async fetchExpirationMonitoringItems(
    user: AuthenticatedUserProfile,
    branchFilter?: string,
  ): Promise<ExpirationMonitoringItem[]> {
    const client = this.supabaseService.getClient();
    const today = new Date();
    const branchId = this.resolveExpirationBranchScope(user, branchFilter);

    let query = client
      .from('pawned_items')
      .select(
        'id, item_id, item_name, category, amount, pawn_date, status, branch_id, customers(full_name, email)',
      )
      .eq('status', 'Active')
      .not('pawn_date', 'is', null)
      .order('pawn_date', { ascending: true });
    query = query.eq('environment', getEnvironment(user));

    if (branchId) query = query.eq('branch_id', branchId);

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const interestRatesSetting = await this.prisma.shop_settings.findFirst({
      where: {
        setting_key: 'interest_rates',
        environment: getEnvironment(user),
      },
      select: { setting_value: true },
    });
    const interestRates = (interestRatesSetting?.setting_value as any[]) || [];

    return (data || []).map((item: any) => {
      const category = item.category;
      const group = findInterestRateGroup(interestRates, category);
      const defaultDuration = group ? (group.defaultDuration ?? 30) : 30;

      const maturityDate = new Date(item.pawn_date);
      maturityDate.setDate(maturityDate.getDate() + defaultDuration);

      const daysRemaining = Math.ceil(
        (maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      const customerRaw = Array.isArray(item.customers)
        ? item.customers[0]
        : item.customers;
      const customer = customerRaw
        ? (this.encryption.decryptCustomerEmbed(
            customerRaw as Record<string, unknown>,
          ) as typeof customerRaw)
        : null;

      return {
        id: item.id,
        ticketNo: item.item_id,
        customer: customer?.full_name || 'Unknown',
        customerEmail: customer?.email || null,
        item: item.item_name,
        principal: this.toMoney(item.amount),
        totalDue: Number((this.toMoney(item.amount) * 1.035).toFixed(2)),
        maturityDate: maturityDate.toISOString().split('T')[0],
        daysRemaining,
      };
    });
  }

  private toMoney(value: number | string | null | undefined): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
  }

  private formatRelativeTime(isoString: string): string {
    if (!isoString) return '';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(isoString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
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

  /**
   * Per-branch today + prior daily_balances (no global row cap) for accurate carry-forward.
   */
  private async loadBalanceSnapshotMapsForBranches(
    client: ReturnType<SupabaseService['getClient']>,
    branchIds: string[],
    asOfDate: string,
    environment: string,
  ): Promise<{
    todayByBranch: Map<string, DailyBalanceRow>;
    priorByBranch: Map<string, DailyBalanceRow>;
  }> {
    if (branchIds.length === 0) {
      return { todayByBranch: new Map(), priorByBranch: new Map() };
    }
    const { data: todayRows, error: todayErr } = await client
      .from('daily_balances')
      .select(
        'branch_id, record_date, starting_balance, ending_balance, updated_at',
      )
      .in('branch_id', branchIds)
      .eq('environment', environment)
      .eq('record_date', asOfDate);
    if (todayErr) {
      throw new InternalServerErrorException(todayErr.message);
    }
    const todayByBranch = new Map(
      (todayRows ?? []).map((r: DailyBalanceRow) => [r.branch_id, r]),
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
          .eq('environment', environment)
          .lt('record_date', asOfDate)
          .order('record_date', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) {
          throw new InternalServerErrorException(error.message);
        }
        if (data) priorByBranch.set(bid, data as DailyBalanceRow);
      }),
    );
    return { todayByBranch, priorByBranch };
  }

  private buildBranchFinanceSummaries(params: {
    branches: BranchRecord[];
    todayByBranch: Map<string, DailyBalanceRow>;
    priorByBranch: Map<string, DailyBalanceRow>;
    transferredFunds: TransferredFundRow[];
    /** ISO date (YYYY-MM-DD) Manila business day. */
    asOfDate: string;
  }) {
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
      const transferred = transferredSummaryByBranch.get(branch.id);
      const openingFallback = this.toMoney(branch.opening_cash_balance);
      const snap = buildBranchDaySnapshotFromFetched({
        today: params.asOfDate,
        todayRow: params.todayByBranch.get(branch.id),
        priorRow: params.priorByBranch.get(branch.id),
        openingCashFallback: openingFallback,
      });

      return {
        branchId: branch.id,
        branchCode: branch.branch_code,
        name: branch.name,
        location: branch.location ?? null,
        status: branch.status ?? 'Unknown',
        startingBalance: snap.startingBalance,
        currentBalance: snap.endingBalance,
        totalAdded: transferred?.totalAdded ?? 0,
        totalTransferred: 0,
        lastUpdated:
          snap.updatedAt ??
          snap.recordDate ??
          transferred?.lastTransferredAt ??
          null,
      };
    });
  }

  private mapDashboardFundRequest(row: DashboardFundRequestListRow) {
    const branch = Array.isArray(row.branches)
      ? (row.branches[0] ?? null)
      : (row.branches ?? null);
    const requestedByRaw = Array.isArray(row.requested_by)
      ? (row.requested_by[0] ?? null)
      : (row.requested_by ?? null);
    const requestedBy = requestedByRaw
      ? this.encryption.decryptUsersJoin(requestedByRaw)
      : null;

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
            id: requestedByRaw!.id,
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
          branchesCount,
          activeBranchesCount,
          usersCount,
          pendingUsersCount,
          branchesResult,
          transferredFundsResult,
          fundRowsResult,
          recentRequestsResult,
          recentTransfersResult,
          systemExpensesResult,
        ] = await Promise.all([
          this.prisma.branches.count({ where: applyEnvironmentFilter(user) }),
          this.prisma.branches.count({
            where: applyEnvironmentFilter(user, { status: 'Active' }),
          }),
          this.prisma.users.count({ where: applyEnvironmentFilter(user) }),
          this.prisma.users.count({
            where: applyEnvironmentFilter(user, { account_status: 'pending' }),
          }),
          this.prisma.branches.findMany({
            where: applyEnvironmentFilter(user),
            select: {
              id: true,
              name: true,
              branch_code: true,
              location: true,
              status: true,
              opening_cash_balance: true,
            },
            orderBy: { name: 'asc' },
          }),
          client
            .from('fund_requests')
            .select('branch_id, amount_transferred, transferred_at')
            .eq('environment', getEnvironment(user))
            .eq('status', 'transferred'),
          client
            .from('fund_requests')
            .select(
              'status, amount_requested, approved_amount, amount_transferred',
            )
            .eq('environment', getEnvironment(user)),
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
            .eq('environment', getEnvironment(user))
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
            .eq('environment', getEnvironment(user))
            .eq('status', 'transferred')
            .order('transferred_at', { ascending: false })
            .limit(8),
          client
            .from('transactions')
            .select('cash_out')
            .eq('environment', getEnvironment(user))
            .eq('purpose', 'Expense')
            .is('branch_id', null),
        ]);

        const errors = [
          transferredFundsResult.error,
          fundRowsResult.error,
          recentRequestsResult.error,
          recentTransfersResult.error,
          systemExpensesResult.error,
        ].filter(Boolean);

        if (errors.length > 0) {
          throw new InternalServerErrorException(errors[0]?.message);
        }

        const asOfDateSa = getPhCalendarDateString();
        const branchListSa = branchesResult.map((branch) => ({
          ...branch,
          opening_cash_balance: Number(branch.opening_cash_balance),
        }));
        const branchIdsSa = branchListSa.map((b) => b.id);
        const { todayByBranch: todayMapSa, priorByBranch: priorMapSa } =
          await this.loadBalanceSnapshotMapsForBranches(
            client,
            branchIdsSa,
            asOfDateSa,
            getEnvironment(user),
          );

        return {
          view: 'super_admin',
          summary: {
            branches: {
              total: branchesCount,
              active: activeBranchesCount,
              inactive:
                branchesCount - activeBranchesCount,
            },
            users: {
              total: usersCount,
              pendingApproval: pendingUsersCount,
            },
            fundRequests: this.summarizeFundRequests(fundRowsResult.data ?? []),
            systemExpenses: (systemExpensesResult.data ?? []).reduce(
              (sum, row) => sum + Number(row.cash_out || 0),
              0,
            ),
          },
          branchBalances: this.buildBranchFinanceSummaries({
            branches: branchListSa,
            todayByBranch: todayMapSa,
            priorByBranch: priorMapSa,
            transferredFunds: transferredFundsResult.data ?? [],
            asOfDate: asOfDateSa,
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
          transferredFundsResult,
          todayTransactionsResult,
        ] = await Promise.all([
          this.prisma.branches.findUnique({
            where: { id: branchId },
            select: {
              id: true,
              name: true,
              branch_code: true,
              location: true,
              status: true,
              opening_cash_balance: true,
            },
          }),
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
            .eq('environment', getEnvironment(user))
            .eq('branch_id', branchId)
            .order('created_at', { ascending: false }),
          client
            .from('fund_requests')
            .select('branch_id, amount_transferred, transferred_at')
            .eq('environment', getEnvironment(user))
            .eq('branch_id', branchId)
            .eq('status', 'transferred'),
          client
            .from('transactions')
            .select('purpose, cash_in, cash_out')
            .eq('environment', getEnvironment(user))
            .eq('branch_id', branchId)
            .eq('transaction_date', getPhCalendarDateString())
            .is('voided_at', null),
        ]);

        const errors = [
          fundRowsResult.error,
          transferredFundsResult.error,
          todayTransactionsResult.error,
        ].filter(Boolean);

        if (errors.length > 0) {
          throw new InternalServerErrorException(errors[0]?.message);
        }

        const todayStrAdmin = getPhCalendarDateString();
        const { todayByBranch: admToday, priorByBranch: admPrior } =
          await this.loadBalanceSnapshotMapsForBranches(
            client,
            [branchId],
            todayStrAdmin,
            getEnvironment(user),
          );
        const adminBranch = branchResult
          ? {
              ...branchResult,
              opening_cash_balance: Number(branchResult.opening_cash_balance),
            }
          : null;
        const adminFinance =
          this.buildBranchFinanceSummaries({
            branches: adminBranch ? [adminBranch] : [],
            todayByBranch: admToday,
            priorByBranch: admPrior,
            transferredFunds: transferredFundsResult.data ?? [],
            asOfDate: todayStrAdmin,
          })[0] ?? null;
        const adminFinanceAligned = adminFinance
          ? {
              ...adminFinance,
              currentBalance: adminFinance.currentBalance,
            }
          : null;

        return {
          view: 'admin',
          branch: adminBranch,
          branchFinance: adminFinanceAligned,
          currentBalance: adminFinanceAligned?.currentBalance ?? 0,
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
          employeeTransferredFundsResult,
          employeeTodayTransactionsResult,
        ] = await Promise.all([
          this.prisma.branches.findUnique({
            where: { id: employeeBranchId },
            select: {
              id: true,
              name: true,
              branch_code: true,
              location: true,
              status: true,
              opening_cash_balance: true,
            },
          }),
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
            .eq('environment', getEnvironment(user))
            .eq('branch_id', employeeBranchId)
            .order('created_at', { ascending: false }),
          client
            .from('fund_requests')
            .select('branch_id, amount_transferred, transferred_at')
            .eq('environment', getEnvironment(user))
            .eq('branch_id', employeeBranchId)
            .eq('status', 'transferred'),
          client
            .from('transactions')
            .select('purpose, cash_in, cash_out')
            .eq('environment', getEnvironment(user))
            .eq('branch_id', employeeBranchId)
            .eq('transaction_date', getPhCalendarDateString())
            .is('voided_at', null),
        ]);

        const employeeErrors = [
          employeeFundRowsResult.error,
          employeeTransferredFundsResult.error,
          employeeTodayTransactionsResult.error,
        ].filter(Boolean);

        if (employeeErrors.length > 0) {
          throw new InternalServerErrorException(employeeErrors[0]?.message);
        }

        const todayStrEmp = getPhCalendarDateString();
        const { todayByBranch: empToday, priorByBranch: empPrior } =
          await this.loadBalanceSnapshotMapsForBranches(
            client,
            [employeeBranchId],
            todayStrEmp,
            getEnvironment(user),
          );
        const employeeBranch = employeeBranchResult
          ? {
              ...employeeBranchResult,
              opening_cash_balance: Number(
                employeeBranchResult.opening_cash_balance,
              ),
            }
          : null;
        const empFinance =
          this.buildBranchFinanceSummaries({
            branches: employeeBranch ? [employeeBranch] : [],
            todayByBranch: empToday,
            priorByBranch: empPrior,
            transferredFunds: employeeTransferredFundsResult.data ?? [],
            asOfDate: todayStrEmp,
          })[0] ?? null;
        const empFinanceAligned = empFinance
          ? {
              ...empFinance,
              currentBalance: empFinance.currentBalance,
            }
          : null;

        return {
          view: 'employee',
          branch: employeeBranch,
          branchFinance: empFinanceAligned,
          currentBalance: empFinanceAligned?.currentBalance ?? 0,
          fundRequests: {
            summary: this.summarizeFundRequests(
              employeeFundRowsResult.data ?? [],
            ),
            recent: (employeeFundRowsResult.data ?? [])
              .slice(0, 8)
              .map((row) => this.mapDashboardFundRequest(row)),
          },
        };
      default:
        return { view: 'guest', data: null };
    }
  }

  private resolvePeriodRange(period?: string): {
    fromDate: string;
    toDate: string;
  } {
    const today = new Date();
    const toDate = today.toISOString().split('T')[0];
    const p = (period ?? 'monthly').toLowerCase();

    const from = new Date(today);
    switch (p) {
      case 'daily':
        return { fromDate: toDate, toDate };
      case 'weekly':
        from.setDate(from.getDate() - 6);
        break;
      case 'yearly':
        from.setFullYear(from.getFullYear() - 1);
        from.setDate(from.getDate() + 1);
        break;
      default: // monthly
        from.setDate(from.getDate() - 29);
        break;
    }
    return { fromDate: from.toISOString().split('T')[0], toDate };
  }

  async getPawnKpis(
    user: AuthenticatedUserProfile,
    branchFilter?: string,
    period?: string,
    customStartDate?: string,
    customEndDate?: string,
  ) {
    const client = this.supabaseService.getClient();
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    const interestRatesSetting = await this.prisma.shop_settings.findFirst({
      where: {
        setting_key: 'interest_rates',
        environment: getEnvironment(user),
      },
      select: { setting_value: true },
    });
    const interestRates = (interestRatesSetting?.setting_value as any[]) || [];

    let fromDate: string;
    let toDate: string;

    if (customStartDate && customEndDate) {
      fromDate = `${customStartDate} 00:00:00`;
      toDate = `${customEndDate} 23:59:59`;
    } else {
      const range = this.resolvePeriodRange(period);
      fromDate = `${range.fromDate} 00:00:00`;
      toDate = `${range.toDate} 23:59:59`;
    }

    // Determine branch scope
    const isAdmin = user?.role === Role.SUPER_ADMIN;
    const branchId = !isAdmin
      ? requireUserBranchId(user)
      : branchFilter || null;

    // Build base queries
    const buildPawnQuery = (baseQuery: any) => {
      let q = baseQuery.eq('environment', getEnvironment(user));
      if (branchId) q = q.eq('branch_id', branchId);
      return q;
    };

    // 1. Active pawn contracts
    const activeQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Active')
        .gte('pawn_date', fromDate)
        .lte('pawn_date', toDate),
    );
    // 2. Items near expiration (maturity within 7 days)
    const nearExpQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('category, pawn_date')
        .eq('status', 'Active'),
    );
    // 3. Items ready for sale
    let saleQuery = client
      .from('sale_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'Available');
    saleQuery = saleQuery.eq('environment', getEnvironment(user));
    if (branchId) saleQuery = saleQuery.eq('branch_id', branchId);

    // 4. Total contracts (overall)
    const totalContractsQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('id', { count: 'exact', head: true })
        .gte('pawn_date', fromDate)
        .lte('pawn_date', toDate),
    );
    // 5. Redeemed (Buy Back transactions)
    const boughtBackQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Redeemed')
        .gte('pawn_date', fromDate)
        .lte('pawn_date', toDate),
    );
    // 6. Expired (redeemed overdue)
    const expiredQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Expired')
        .gte('pawn_date', fromDate)
        .lte('pawn_date', toDate),
    );

    // 7. Revenue from transactions for the selected period
    let revenueQuery = client
      .from('transactions')
      .select('cash_in, purpose')
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate);
    revenueQuery = revenueQuery.eq('environment', getEnvironment(user));
    if (branchId) revenueQuery = revenueQuery.eq('branch_id', branchId);

    // 8. Contract trends (last 6 months)
    const sixMonthsAgo = new Date(today);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    const contractTrendQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('status, pawn_date')
        .gte('pawn_date', sixMonthsAgo.toISOString().split('T')[0]),
    );

    const yearStart = new Date(today.getFullYear(), 0, 1);
    const yearStartStr = yearStart.toISOString().split('T')[0];

    // 9. Revenue trend (year-to-date)
    let revenueTrendQuery = client
      .from('transactions')
      .select('cash_in, transaction_date, purpose')
      .gte('transaction_date', yearStartStr);
    revenueTrendQuery = revenueTrendQuery.eq('environment', getEnvironment(user));
    if (branchId)
      revenueTrendQuery = revenueTrendQuery.eq('branch_id', branchId);

    // 10. Items needing attention (near expiration, with detail)
    const attentionQuery = buildPawnQuery(
      client
        .from('pawned_items')
        .select('id, item_name, item_id, category, amount, pawn_date, status')
        .eq('status', 'Active')
        .lte('pawn_date', todayStr)
        .order('pawn_date', { ascending: true })
        .limit(10),
    );

    // 11. Total sales revenue (sold items price)
    let branchSalesQuery = client
      .from('transactions')
      .select('cash_in')
      .eq('purpose', 'Sold Item')
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate);
    branchSalesQuery = branchSalesQuery.eq('environment', getEnvironment(user));
    if (branchId) branchSalesQuery = branchSalesQuery.eq('branch_id', branchId);

    const allBranchSalesQuery = isAdmin
      ? client
          .from('transactions')
          .select('cash_in')
          .eq('purpose', 'Sold Item')
          .eq('environment', getEnvironment(user))
          .gte('transaction_date', fromDate)
          .lte('transaction_date', toDate)
      : branchSalesQuery;

    const [
      activeResult,
      nearExpResult,
      saleResult,
      totalContractsResult,
      boughtBackResult,
      expiredResult,
      revenueResult,
      contractTrendResult,
      revenueTrendResult,
      attentionResult,
      branchSalesResult,
      allBranchSalesResult,
    ] = await Promise.all([
      activeQuery,
      nearExpQuery,
      saleQuery,
      totalContractsQuery,
      boughtBackQuery,
      expiredQuery,
      revenueQuery,
      contractTrendQuery,
      revenueTrendQuery,
      attentionQuery,
      branchSalesQuery,
      allBranchSalesQuery,
    ]);

    // Compute monthly revenue (only revenue-generating purposes)
    const monthlyRevenue = (revenueResult.data || []).reduce(
      (sum: number, row: any) =>
        isNonRevenuePurpose(row.purpose)
          ? sum
          : sum + this.toMoney(row.cash_in),
      0,
    );

    // Compute total overall sales
    const branchSales = (branchSalesResult.data || []).reduce(
      (sum: number, row: any) => sum + this.toMoney(row.cash_in),
      0,
    );

    const allBranchSales = (allBranchSalesResult.data || []).reduce(
      (sum: number, row: any) => sum + this.toMoney(row.cash_in),
      0,
    );

    // Build contract trends by month
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
    const contractTrendMap = new Map<
      string,
      { contracts: number; boughtBack: number }
    >();
    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - 5 + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      contractTrendMap.set(key, { contracts: 0, boughtBack: 0 });
    }
    for (const row of contractTrendResult.data || []) {
      if (!row.pawn_date) continue;
      const key = row.pawn_date.substring(0, 7);
      const entry = contractTrendMap.get(key);
      if (entry) {
        entry.contracts += 1;
        if (row.status === 'Redeemed') entry.boughtBack += 1;
      }
    }
    const contractTrends = Array.from(contractTrendMap.entries()).map(
      ([key, val]) => {
        const [, month] = key.split('-');
        return {
          month: monthNames[parseInt(month) - 1],
          contracts: val.contracts,
          boughtBack: val.boughtBack,
        };
      },
    );

    // Build revenue trend by month
    const revenueTrendMap = new Map<string, number>();
    for (let monthIndex = 0; monthIndex <= today.getMonth(); monthIndex++) {
      const d = new Date(today.getFullYear(), monthIndex, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      revenueTrendMap.set(key, 0);
    }
    for (const row of revenueTrendResult.data || []) {
      if (!row.transaction_date || isNonRevenuePurpose(row.purpose)) continue;
      const key = row.transaction_date.substring(0, 7);
      const current = revenueTrendMap.get(key);
      if (current !== undefined) {
        revenueTrendMap.set(key, current + this.toMoney(row.cash_in));
      }
    }
    const revenueTrend = Array.from(revenueTrendMap.entries()).map(
      ([key, revenue]) => {
        const [, month] = key.split('-');
        return { month: monthNames[parseInt(month) - 1], revenue };
      },
    );

    // Build attention items
    const attentionItems = (attentionResult.data || []).map((item: any) => {
      const category = item.category;
      const group = findInterestRateGroup(interestRates, category);
      const defaultDuration = group ? (group.defaultDuration ?? 30) : 30;

      const maturityDate = new Date(item.pawn_date);
      maturityDate.setDate(maturityDate.getDate() + defaultDuration);
      const daysRemaining = Math.ceil(
        (maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
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

    // Notifications (fetch from notifications table)
    let notifQuery = client
      .from('notifications')
      .select('id, title, subtitle, created_at, is_read')
      .eq('environment', getEnvironment(user))
      .order('created_at', { ascending: false })
      .limit(10);

    if (user.role !== Role.SUPER_ADMIN) {
      if (user.branchId) {
        notifQuery = notifQuery.or(
          `branch_id.eq.${user.branchId},user_id.eq.${user.id},branch_id.is.null`,
        );
      } else {
        notifQuery = notifQuery.or(`user_id.eq.${user.id},branch_id.is.null`);
      }
    } else if (branchId) {
      notifQuery = notifQuery.or(`branch_id.eq.${branchId},branch_id.is.null`);
    }

    const notifResult = await notifQuery;
    const notifications = (notifResult.data || []).map((item: any) => ({
      id: item.id,
      message: item.title || item.subtitle || 'Notification',
      time: this.formatRelativeTime(item.created_at),
      branchId: item.branch_id || null,
    }));

    let itemsNearExpiration = 0;
    for (const item of nearExpResult.data || []) {
      if (!item.pawn_date) continue;
      const category = item.category;
      const group = findInterestRateGroup(interestRates, category);
      const defaultDuration = group ? (group.defaultDuration ?? 30) : 30;

      const maturityDate = new Date(item.pawn_date);
      maturityDate.setDate(maturityDate.getDate() + defaultDuration);
      const daysRemaining = Math.ceil(
        (maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysRemaining > 0 && daysRemaining <= 7) {
        itemsNearExpiration++;
      }
    }

    return {
      overallData: {
        totalContracts: totalContractsResult.count ?? 0,
        active: activeResult.count ?? 0,
        boughtBack: boughtBackResult.count ?? 0,
        boughtBackOverdue: expiredResult.count ?? 0,
        branchSales,
        allBranchSales,
        totalOverallSales: `₱ ${allBranchSales.toLocaleString()}`,
      },
      kpiData: {
        activeContracts: activeResult.count ?? 0,
        itemsNearExpiration,
        itemsReadyForSale: saleResult.count ?? 0,
        monthlyRevenue: `₱ ${monthlyRevenue.toLocaleString()}`,
      },
      contractTrends,
      revenueTrend,
      notifications,
      attentionItems,
    };
  }

  async getExpirationMonitoring(
    user: AuthenticatedUserProfile,
    branchFilter?: string,
  ) {
    const items = await this.fetchExpirationMonitoringItems(user, branchFilter);
    const buckets = this.bucketExpirationItems(items);

    return {
      stats: {
        overdue: buckets.overdue.length,
        threeDays: buckets.threeDays.length,
        sevenDays: buckets.sevenDays.length,
        thirtyDays: buckets.thirtyDays.length,
      },
      items,
      buckets: {
        overdue: buckets.overdue,
        threeDays: buckets.threeDays,
        sevenDays: buckets.sevenDays,
        thirtyDays: buckets.thirtyDays,
      },
    };
  }

  async sendExpirationEmailBlast(
    user: AuthenticatedUserProfile,
    bucket: string | undefined,
    branchFilter?: string,
  ) {
    const items = await this.fetchExpirationMonitoringItems(user, branchFilter);
    const grouped = this.bucketExpirationItems(items);
    const targetItems = this.getBucketItems(bucket, grouped);
    const recipientsMap = new Map<string, ExpirationMonitoringItem[]>();
    for (const item of targetItems) {
      const email = item.customerEmail?.trim().toLowerCase();
      if (!email) {
        continue;
      }
      const current = recipientsMap.get(email) ?? [];
      current.push(item);
      recipientsMap.set(email, current);
    }

    const fallbackRecipient = (
      process.env.BLAST_FALLBACK_EMAIL ||
      process.env.GMAIL_USER ||
      process.env.SMTP_FROM
    )?.trim();

    if (
      recipientsMap.size === 0 &&
      targetItems.length > 0 &&
      fallbackRecipient
    ) {
      recipientsMap.set(fallbackRecipient.toLowerCase(), targetItems);
    }

    if (recipientsMap.size === 0) {
      return {
        success: false,
        message:
          'No recipient emails found for this bucket. Add customer emails or set BLAST_FALLBACK_EMAIL in backend env.',
        sentCount: 0,
        failedCount: 0,
        bucket: bucket || '30days',
      };
    }

    const bucketLabelMap: Record<string, string> = {
      overdue: 'Overdue',
      '3days': 'Expiring within 3 days',
      '7days': 'Expiring within 7 days',
      '30days': 'Expiring within 30 days',
    };
    const resolvedBucket = (bucket || '30days').toLowerCase();
    const bucketLabel = bucketLabelMap[resolvedBucket] || 'Expiring Soon';

    const deliveries = await Promise.allSettled(
      Array.from(recipientsMap.entries()).map(([email, customerItems]) =>
        this.sendResendEmail(
          email,
          `JCLB Pawnshop | ${bucketLabel} Reminder`,
          this.buildBlastReminderEmail({
            customerName: customerItems[0]?.customer || 'Valued Customer',
            bucketLabel,
            items: customerItems.map((entry) => ({
              ticketNo: entry.ticketNo,
              itemName: entry.item,
              maturityDate: entry.maturityDate,
              daysRemaining: entry.daysRemaining,
              totalDue: entry.totalDue,
            })),
          }),
        ),
      ),
    );

    const sentCount = deliveries.filter(
      (delivery) => delivery.status === 'fulfilled',
    ).length;
    const failedCount = deliveries.length - sentCount;

    if (sentCount === 0) {
      throw new InternalServerErrorException(
        'Unable to send blast emails. Please check SMTP credentials and try again.',
      );
    }

    const message =
      failedCount > 0
        ? `Email blast partially sent: ${sentCount} delivered, ${failedCount} failed.`
        : `Sent ${sentCount} professional reminder email(s).`;

    return {
      success: true,
      message,
      sentCount,
      failedCount,
      bucket: bucket || '30days',
    };
  }

  async sendExpirationReminder(
    user: AuthenticatedUserProfile,
    itemId: string,
    branchFilter?: string,
  ) {
    const items = await this.fetchExpirationMonitoringItems(user, branchFilter);
    const selected = items.find((item) => item.id === itemId);

    if (!selected) {
      throw new BadRequestException('Expiration item not found.');
    }

    if (!selected.customerEmail) {
      throw new BadRequestException(
        `No email address found for ${selected.customer}.`,
      );
    }

    const delivery = await this.sendResendEmail(
      selected.customerEmail,
      'JCLB Pawnshop | Pawn Item Maturity Notice',
      this.buildSingleReminderEmail({
        customerName: selected.customer,
        itemName: selected.item,
        ticketNo: selected.ticketNo,
        maturityDate: selected.maturityDate,
        daysRemaining: selected.daysRemaining,
        totalDue: selected.totalDue,
      }),
    );

    return {
      success: true,
      message: `Email sent to ${selected.customer}.`,
      sentTo: delivery.deliveredTo,
      intendedRecipient: selected.customerEmail,
    };
  }
}
