import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import {
  assertBranchAccess,
  buildBranchFilter,
  isSuperAdmin,
  requireBranchId,
} from '../../../common/utils/authorization.util';
import { effectiveBranchIdForQuery } from '../../../common/utils/branch-scope.util';
import { getPhCalendarDateString } from '../../../common/utils/branch-calendar-date.util';
import { Role } from '../../../common/enums';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { RewardsService } from '../../rewards/services/rewards.service';
import { normalizeCustomerFullName } from '../../../common/utils/customer-name.util';
import { CreateTransactionDto } from '../dto/create-transaction.dto';

type CustomerGroupMatch = {
  id: string;
  full_name: string;
  branch_id: string | null;
};

type CustomerTimelineScope = {
  customer: CustomerGroupMatch;
  matchingCustomerIds: string[];
  matchingPawnedItemIds: string[];
};

const TX_SELECT = {
  id: true,
  transaction_no: true,
  branch_id: true,
  branch: true,
  customer_id: true,
  related_pawned_item_id: true,
  purpose: true,
  transaction_date: true,
  transaction_time: true,
  cash_in: true,
  cash_out: true,
  return_amount: true,
  storage_fee: true,
  pawn_amount: true,
  unit: true,
  unit_code: true,
  details: true,
  profile_photo: true,
  id_photo: true,
  id_back_photo: true,
  created_by_user_id: true,
  created_at: true,
  pawned_items: {
    select: {
      id: true,
      customer_id: true,
      customers: {
        select: {
          id: true,
          full_name: true,
          address: true,
          barangay: true,
          city: true,
          region: true,
          contact_number: true,
        },
      },
    },
  },
} satisfies Prisma.transactionsSelect;

type LayawayInput = {
  customer?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    contactNo?: string;
    address?: string;
  };
  terms?: string;
  itemPrice?: number;
  downpayment?: number;
  remainingBalance?: number;
  processedByName?: string;
};

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly rewardsService: RewardsService,
  ) {}

  private toDbDate(value?: string | null): Date {
    const date = value || getPhCalendarDateString();
    return new Date(`${date}T00:00:00.000Z`);
  }

  private toDbTime(value?: string | null): Date {
    const time = value || new Date().toTimeString().slice(0, 8);
    return new Date(`1970-01-01T${time}.000Z`);
  }

  private formatDate(value?: Date | null): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
  }

  private formatTime(value?: Date | null): string | null {
    return value ? value.toISOString().slice(11, 19) : null;
  }

  private toNumber(value: Prisma.Decimal | number | string | null | undefined) {
    if (value == null) return 0;
    return Number(value);
  }

  private mapTransaction(row: Prisma.transactionsGetPayload<{ select: typeof TX_SELECT }>) {
    return {
      ...row,
      transaction_date: this.formatDate(row.transaction_date),
      transaction_time: this.formatTime(row.transaction_time),
      cash_in: this.toNumber(row.cash_in),
      cash_out: this.toNumber(row.cash_out),
      return_amount: this.toNumber(row.return_amount),
      storage_fee: this.toNumber(row.storage_fee),
      pawn_amount: this.toNumber(row.pawn_amount),
      pawned_item: row.pawned_items
        ? {
            ...row.pawned_items,
            customer: row.pawned_items.customers,
          }
        : null,
      pawned_items: undefined,
      sale_item: null,
    };
  }

  private async adjustDailyBalance(
    branchId: string,
    netChange: number,
    recordDate = getPhCalendarDateString(),
  ) {
    const date = this.toDbDate(recordDate);
    const current = await this.prisma.daily_balances.findUnique({
      where: { branch_id_record_date: { branch_id: branchId, record_date: date } },
      select: { starting_balance: true, ending_balance: true },
    });

    if (current) {
      await this.prisma.daily_balances.update({
        where: { branch_id_record_date: { branch_id: branchId, record_date: date } },
        data: {
          ending_balance: this.toNumber(current.ending_balance) + netChange,
          updated_at: new Date(),
        },
      });
      return;
    }

    const prior = await this.prisma.daily_balances.findFirst({
      where: { branch_id: branchId, record_date: { lt: date } },
      orderBy: { record_date: 'desc' },
      select: { ending_balance: true },
    });
    const carried = this.toNumber(prior?.ending_balance);

    await this.prisma.daily_balances.create({
      data: {
        branch_id: branchId ?? undefined,
        record_date: date,
        starting_balance: carried,
        ending_balance: carried + netChange,
      },
    });
  }

  private async resolveCustomerTimelineScope(
    user: UserWithBranch,
    customerId: string,
  ): Promise<CustomerTimelineScope | null> {
    const customer = await this.prisma.customers.findFirst({
      where: {
        id: customerId,
        deleted_at: null,
        ...buildBranchFilter(user),
      },
      select: { id: true, full_name: true, branch_id: true },
    });

    if (!customer) return null;

    const candidates = await this.prisma.customers.findMany({
      where: { deleted_at: null, ...buildBranchFilter(user) },
      select: { id: true, full_name: true, branch_id: true },
      take: 1000,
    });

    const targetName = normalizeCustomerFullName(customer.full_name);
    const matchingCustomerIds = candidates
      .filter(
        (candidate) => normalizeCustomerFullName(candidate.full_name) === targetName,
      )
      .map((candidate) => candidate.id);

    if (!matchingCustomerIds.includes(customer.id)) {
      matchingCustomerIds.unshift(customer.id);
    }

    const pawnedItems = await this.prisma.pawned_items.findMany({
      where: { customer_id: { in: matchingCustomerIds } },
      select: { id: true },
      take: 1000,
    });

    return {
      customer,
      matchingCustomerIds,
      matchingPawnedItemIds: pawnedItems.map((item) => item.id),
    };
  }

  async create(user: UserWithBranch, dto: any) {
    // Drop client-only fields that are not real DB columns.
    // This prevents 500s when UI sends extra metadata.
    const { layaway: layawayInput, ...dtoClean } = dto ?? {};
    const isLayaway = !!layawayInput;

    // 1. Resolve Branch Info
    const branchId =
      isSuperAdmin(user) ? (dtoClean.branch_id ?? null) : requireBranchId(user);
    const isSystemExpense =
      !branchId && user.role === Role.SUPER_ADMIN && dtoClean.purpose === 'Expense';

    if (!branchId && !isSystemExpense) {
      throw new BadRequestException('Missing branch_id for transaction.');
    }

    if (branchId && dtoClean.customer_id) {
      const customer = await this.prisma.customers.findFirst({
        where: { id: dtoClean.customer_id, branch_id: branchId, deleted_at: null },
        select: { id: true },
      });
      if (!customer) {
        throw new BadRequestException(
          'Selected customer was not found for the active branch.',
        );
      }
    }

    const branchName = isSystemExpense
      ? 'System / Head Office'
      : (dtoClean.branch || 'Unknown Branch');
    const transactionNo =
      dtoClean.transaction_no ||
      `${dtoClean.purpose?.substring(0, 2).toUpperCase() || 'TX'}-${Date.now()}`;

    const payload: Prisma.transactionsUncheckedCreateInput = {
      transaction_no: transactionNo,
      branch_id: branchId,
      branch: branchName,
      customer_id: dtoClean.customer_id ?? null,
      related_pawned_item_id: dtoClean.related_pawned_item_id ?? null,
      purpose: dtoClean.purpose ?? '',
      transaction_date: this.toDbDate(dtoClean.transaction_date),
      transaction_time: this.toDbTime(dtoClean.transaction_time),
      created_by_user_id: user.id ?? null,
      return_amount: dtoClean.return_amount ?? 0,
      storage_fee: dtoClean.storage_fee ?? 0,
      pawn_amount: dtoClean.pawn_amount ?? 0,
      cash_in: dtoClean.cash_in ?? 0,
      cash_out: dtoClean.cash_out ?? 0,
      unit: dtoClean.unit ?? null,
      unit_code: dtoClean.unit_code ?? null,
      details: dtoClean.details ?? null,
      profile_photo: dtoClean.profile_photo ?? null,
      id_photo: dtoClean.id_photo ?? null,
      id_back_photo: dtoClean.id_back_photo ?? null,
    };

    const data = await this.prisma.transactions.create({
      data: payload,
      select: TX_SELECT,
    });

    const cashIn = Number(dtoClean.cash_in ?? 0);
    const cashOut = Number(dtoClean.cash_out ?? 0);
    if (branchId && (cashIn || cashOut)) {
      await this.adjustDailyBalance(branchId, cashIn - cashOut);
    }

    try {
      await this.notificationsService.create({
        title:
          dtoClean.purpose === 'Buy Back'
            ? `Successful buyback completed - ${transactionNo}`
            : `New ${dtoClean.purpose?.toLowerCase() || 'transaction'} created - ${transactionNo}`,
        subtitle: dtoClean.unit
          ? `Transaction Alert: ${dtoClean.purpose?.toLowerCase() || 'item'} [${dtoClean.unit}]`
          : `Transaction Alert: ${dtoClean.purpose?.toLowerCase() || 'activity'}`,
        category: 'Transactions',
        branch_id: branchId ?? undefined,
      });
    } catch (e) {
      console.warn('[TransactionsService] Failed to create notification', e);
    }

    // Post-transaction hook: evaluate customer reward eligibility (fire-and-forget)
    if (branchId && dtoClean.customer_id) {
      this.rewardsService
        .evaluateRewardsAfterTransaction(
          dtoClean.customer_id,
          branchId,
          dtoClean.purpose,
        )
        .catch((err) =>
          console.warn('[TransactionsService] Reward evaluation failed', err),
        );
    }

    return this.mapTransaction(data);
  }

  async findAll(
    user: UserWithBranch,
    branchQuery?: string,
    date?: string,
    range?: string,
    customerId?: string,
  ) {
    const scoped = effectiveBranchIdForQuery(user, branchQuery);
    const where: Prisma.transactionsWhereInput = {};

    if (scoped) where.branch_id = scoped;
    if (!isSuperAdmin(user)) Object.assign(where, buildBranchFilter(user));

    const customerScope = customerId
      ? await this.resolveCustomerTimelineScope(user, customerId)
      : null;

    if (customerId && !customerScope) {
      return this.emptyList(scoped, date);
    }

    if (!customerId) {
      if (date) {
        where.transaction_date = this.toDbDate(date);
      } else if (range && range !== 'daily') {
        if (range === 'weekly' || range === 'monthly') {
          const start = new Date();
          if (range === 'weekly') start.setDate(start.getDate() - 7);
          if (range === 'monthly') start.setMonth(start.getMonth() - 1);
          where.transaction_date = { gte: this.toDbDate(start.toISOString().slice(0, 10)) };
        }
      } else if (range === 'daily' || !range) {
        where.transaction_date = this.toDbDate(date || getPhCalendarDateString());
      }
    }

    if (customerScope) {
      where.OR = [
        { customer_id: { in: customerScope.matchingCustomerIds } },
        { related_pawned_item_id: { in: customerScope.matchingPawnedItemIds } },
      ];
    }

    const rows = await this.prisma.transactions.findMany({
      where,
      select: TX_SELECT,
      orderBy: [{ transaction_date: 'desc' }, { transaction_time: 'desc' }],
      take: 500,
    });

    const transactions = rows.map((row) => this.mapTransaction(row));
    const stats = await this.buildStats(transactions, scoped, date);

    return { transactions, stats };
  }

  async findOne(user: UserWithBranch, id: string) {
    const data = await this.prisma.transactions.findUnique({
      where: { id },
      select: TX_SELECT,
    });
    if (!data) throw new NotFoundException('Transaction not found');
    assertBranchAccess(user, data.branch_id);
    return this.mapTransaction(data);
  }

  async update(user: UserWithBranch, id: string, dto: Partial<CreateTransactionDto>) {
    const existing = await this.prisma.transactions.findUnique({
      where: { id },
      select: { id: true, branch_id: true },
    });
    if (!existing) throw new NotFoundException('Transaction not found');
    assertBranchAccess(user, existing.branch_id);

    const updated = await this.prisma.transactions.update({
      where: { id },
      data: {
        details: dto.details,
        updated_at: new Date(),
      },
      select: TX_SELECT,
    });
    return this.mapTransaction(updated);
  }

  async remove(user: UserWithBranch, id: string) {
    const existing = await this.prisma.transactions.findUnique({
      where: { id },
      select: { id: true, branch_id: true },
    });
    if (!existing) throw new NotFoundException('Transaction not found');
    assertBranchAccess(user, existing.branch_id);
    throw new InternalServerErrorException(
      'Transactions are immutable and cannot be deleted; create a reversal transaction instead.',
    );
  }

  private emptyList(scoped: string | null, date?: string) {
    return {
      transactions: [],
      stats: {
        pawnedToday: 0,
        buyBack: 0,
        renewed: 0,
        soldItem: 0,
        redeemed: 0,
        transfer: 0,
        startingBalance: 0,
        endingBalance: 0,
      },
    };
  }

  private async buildStats(
    rows: Array<ReturnType<TransactionsService['mapTransaction']>>,
    scoped: string | null,
    date?: string,
  ) {
    const stats = {
      pawnedToday: rows.filter((t) => t.purpose === 'Pawn').length,
      buyBack: rows.filter((t) => t.purpose === 'Buy Back').length,
      renewed: rows.filter((t) => t.purpose === 'Renew').length,
      soldItem: rows.filter(
        (t) => t.purpose === 'Sold Item' || t.purpose === 'Sale',
      ).length,
      redeemed: rows.filter((t) => t.purpose === 'Redeem').length,
      transfer: rows.filter(
        (t) => t.purpose === 'Fund Transfer' || t.purpose === 'Cash Transfer',
      ).length,
      startingBalance: 0,
      endingBalance: 0,
    };

    if (scoped) {
      const balanceDate = this.toDbDate(date || getPhCalendarDateString());
      const balanceData = await this.prisma.daily_balances.findUnique({
        where: {
          branch_id_record_date: { branch_id: scoped, record_date: balanceDate },
        },
        select: { starting_balance: true, ending_balance: true },
      });

      if (balanceData) {
        stats.startingBalance = this.toNumber(balanceData.starting_balance);
        stats.endingBalance = this.toNumber(balanceData.ending_balance);
      } else {
        const priorRow = await this.prisma.daily_balances.findFirst({
          where: { branch_id: scoped, record_date: { lt: balanceDate } },
          orderBy: { record_date: 'desc' },
          select: { ending_balance: true },
        });
        const carried = this.toNumber(priorRow?.ending_balance);
        stats.startingBalance = carried;
        stats.endingBalance = carried;
      }
    }

    return stats;
  }
}
