import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
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
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { FinanceDailyBalanceService } from '../../branch-finance/services/finance-daily-balance.service';

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
  users: {
    select: {
      id: true,
      full_name: true,
      role: true,
    },
  },
  pawned_items: {
    select: {
      id: true,
      item_id: true,
      customer_id: true,
      qr_code: true,
      serial_number: true,
      items_included: true,
      condition: true,
      memory_storage: true,
      remarks: true,
      category: true,
      item_photos: true,
      customers: {
        select: {
          id: true,
          full_name: true,
          address: true,
          barangay: true,
          city: true,
          region: true,
          contact_number: true,
          id_presented: true,
        },
      },
    },
  },
  customers: {
    select: {
      id: true,
      full_name: true,
      address: true,
      barangay: true,
      city: true,
      region: true,
      contact_number: true,
      id_presented: true,
    },
  },
} as any;

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

const ALLOWED_TRANSACTION_PURPOSES = new Set([
  'Pawn',
  'Buy Back',
  'Renew',
  'Redeem',
  'Sold Item',
  'Sale',
  'Expense',
  'Cash Transfer',
  'Fund Transfer',
]);

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly rewardsService: RewardsService,
    private readonly encryption: EncryptionService,
    private readonly financeDailyBalance: FinanceDailyBalanceService,
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

  private toNumber(value: any | number | string | null | undefined) {
    if (value == null) return 0;
    return Number(value);
  }

  private decryptUserDisplayName(value: string | null | undefined) {
    let current = value ?? null;

    for (let i = 0; i < 5 && this.encryption.isEncrypted(current); i += 1) {
      const next = this.encryption.decrypt(current as string);
      if (next === current) break;
      current = next;
    }

    return current;
  }

  private normalizeMoney(value: unknown, field: string): number {
    const parsed = Number(value ?? 0);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequestException(`${field} must be a non-negative number`);
    }
    return Number(parsed.toFixed(2));
  }

  private normalizePurpose(value: unknown): string {
    const purpose = String(value ?? '').trim();
    if (!ALLOWED_TRANSACTION_PURPOSES.has(purpose)) {
      throw new BadRequestException('Invalid transaction purpose');
    }
    return purpose;
  }

  private assertMoneyShape(
    purpose: string,
    amounts: {
      cashIn: number;
      cashOut: number;
      pawnAmount: number;
      returnAmount: number;
      storageFee: number;
    },
  ) {
    const hasCashIn = amounts.cashIn > 0;
    const hasCashOut = amounts.cashOut > 0;

    if (hasCashIn && hasCashOut) {
      throw new BadRequestException(
        'A transaction cannot contain both cash_in and cash_out',
      );
    }

    if (purpose === 'Pawn') {
      if (amounts.pawnAmount <= 0 || amounts.cashOut !== amounts.pawnAmount) {
        throw new BadRequestException(
          'Pawn transactions must use pawn_amount as the exact cash_out',
        );
      }
      if (amounts.cashIn !== 0) {
        throw new BadRequestException(
          'Pawn transactions cannot include cash_in',
        );
      }
      return;
    }

    if (purpose === 'Buy Back' || purpose === 'Redeem') {
      if (amounts.cashIn <= 0 || amounts.cashOut !== 0) {
        throw new BadRequestException(
          `${purpose} transactions must be cash-in only`,
        );
      }
      return;
    }

    if (purpose === 'Renew') {
      const expected = Number(
        (amounts.storageFee + amounts.returnAmount).toFixed(2),
      );
      if (
        expected <= 0 ||
        amounts.cashIn !== expected ||
        amounts.cashOut !== 0
      ) {
        throw new BadRequestException(
          'Renew transactions must set cash_in to storage_fee + return_amount',
        );
      }
      return;
    }

    if (purpose === 'Sold Item' || purpose === 'Sale') {
      if (amounts.cashIn <= 0 || amounts.cashOut !== 0) {
        throw new BadRequestException('Sale transactions must be cash-in only');
      }
      return;
    }

    if (purpose === 'Expense') {
      if (amounts.cashOut <= 0 || amounts.cashIn !== 0) {
        throw new BadRequestException(
          'Expense transactions must be cash-out only',
        );
      }
      return;
    }

    if (purpose === 'Cash Transfer' || purpose === 'Fund Transfer') {
      throw new BadRequestException(
        'Fund transfers must use the fund request workflow',
      );
    }
  }

  private async resolveLinkedPawnedItem(
    tx: any,
    branchId: string | null,
    dto: Record<string, unknown>,
  ) {
    const relatedPawnedItemId = String(dto.related_pawned_item_id ?? '').trim();
    const unitCode = String(dto.unit_code ?? '').trim();

    if (relatedPawnedItemId) {
      return tx.pawned_items.findFirst({
        where: {
          id: relatedPawnedItemId,
          ...(branchId ? { branch_id: branchId } : {}),
        },
        select: {
          id: true,
          item_id: true,
          item_name: true,
          amount: true,
          branch_id: true,
          status: true,
        },
      });
    }

    if (unitCode) {
      return tx.pawned_items.findFirst({
        where: {
          item_id: { equals: unitCode, mode: 'insensitive' },
          ...(branchId ? { branch_id: branchId } : {}),
        },
        select: {
          id: true,
          item_id: true,
          item_name: true,
          amount: true,
          branch_id: true,
          status: true,
        },
      });
    }

    return null;
  }

  private mapTransaction(row: any) {
    const pawnedItemsDecrypted = row.pawned_items
      ? {
          ...row.pawned_items,
          customers: row.pawned_items.customers
            ? this.encryption.decryptCustomerEmbed(
                row.pawned_items.customers as Record<string, unknown>,
              )
            : row.pawned_items.customers,
        }
      : null;

    const customersDecrypted = row.customers
      ? this.encryption.decryptCustomerEmbed(
          row.customers as Record<string, unknown>,
        )
      : null;

    const createdByUser = this.encryption.decryptUsersJoin(row.users);

    return {
      ...row,
      transaction_date: this.formatDate(row.transaction_date),
      transaction_time: this.formatTime(row.transaction_time),
      cash_in: this.toNumber(row.cash_in),
      cash_out: this.toNumber(row.cash_out),
      return_amount: this.toNumber(row.return_amount),
      storage_fee: this.toNumber(row.storage_fee),
      pawn_amount: this.toNumber(row.pawn_amount),
      details: this.encryption.decryptTransactionDetails(row.details),
      pawned_item: pawnedItemsDecrypted
        ? {
            ...pawnedItemsDecrypted,
            customer: pawnedItemsDecrypted.customers,
          }
        : null,
      customer: customersDecrypted ?? null,
      created_by_user: createdByUser
        ? {
            id: row.users.id,
            full_name: this.decryptUserDisplayName(createdByUser.full_name),
            role: row.users.role,
          }
        : null,
      pawned_items: undefined,
      customers: undefined,
      users: undefined,
      sale_item: null,
    };
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

    // Find all customers with matching full name (case-insensitive)
    // instead of loading all 1000 and filtering in memory
    const candidates = await this.prisma.customers.findMany({
      where: {
        deleted_at: null,
        ...buildBranchFilter(user),
        // Database-level case-insensitive match
        full_name: {
          equals: customer.full_name,
          mode: 'insensitive',
        },
      },
      select: { id: true, full_name: true, branch_id: true },
      take: 1000,
    });

    const matchingCustomerIds = candidates.map((c) => c.id);

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
    const purpose = this.normalizePurpose(dtoClean.purpose);
    const amounts = {
      cashIn: this.normalizeMoney(dtoClean.cash_in, 'cash_in'),
      cashOut: this.normalizeMoney(dtoClean.cash_out, 'cash_out'),
      pawnAmount: this.normalizeMoney(dtoClean.pawn_amount, 'pawn_amount'),
      returnAmount: this.normalizeMoney(
        dtoClean.return_amount,
        'return_amount',
      ),
      storageFee: this.normalizeMoney(dtoClean.storage_fee, 'storage_fee'),
    };
    this.assertMoneyShape(purpose, amounts);

    // 1. Resolve Branch Info
    const branchId = isSuperAdmin(user)
      ? (dtoClean.branch_id ?? null)
      : requireBranchId(user);
    const isSystemExpense =
      !branchId && user.role === Role.SUPER_ADMIN && purpose === 'Expense';

    if (!branchId && !isSystemExpense) {
      throw new BadRequestException('Missing branch_id for transaction.');
    }

    let branchName = 'System / Head Office';
    if (branchId) {
      const branch = await this.prisma.branches.findUnique({
        where: { id: branchId },
        select: { id: true, name: true, status: true },
      });
      if (!branch || branch.status?.trim().toLowerCase() !== 'active') {
        throw new BadRequestException('Invalid or inactive branch');
      }
      assertBranchAccess(user, branchId);
      branchName = branch.name;
    }

    if (branchId && dtoClean.customer_id) {
      const customer = await this.prisma.customers.findFirst({
        where: {
          id: dtoClean.customer_id,
          branch_id: branchId,
          deleted_at: null,
        },
        select: { id: true },
      });
      if (!customer) {
        throw new BadRequestException(
          'Selected customer was not found for the active branch.',
        );
      }
    }

    const transactionNo = `${purpose.substring(0, 2).toUpperCase()}-${Date.now()}`;
    const now = new Date();

    const payload: any = {
      transaction_no: transactionNo,
      branch_id: branchId,
      branch: branchName,
      customer_id: dtoClean.customer_id ?? null,
      related_pawned_item_id: dtoClean.related_pawned_item_id ?? null,
      purpose,
      transaction_date: this.toDbDate(getPhCalendarDateString()),
      transaction_time: this.toDbTime(now.toTimeString().slice(0, 8)),
      created_by_user_id: user.id ?? null,
      return_amount: amounts.returnAmount,
      storage_fee: amounts.storageFee,
      pawn_amount: amounts.pawnAmount,
      cash_in: amounts.cashIn,
      cash_out: amounts.cashOut,
      unit: dtoClean.unit ?? null,
      unit_code: dtoClean.unit_code ?? null,
      details:
        dtoClean.details == null || dtoClean.details === ''
          ? null
          : this.encryption.encryptTransactionDetails(String(dtoClean.details)),
      profile_photo: dtoClean.profile_photo ?? null,
      id_photo: dtoClean.id_photo ?? null,
      id_back_photo: dtoClean.id_back_photo ?? null,
    };

    const data = await this.prisma.$transaction(async (tx) => {
      let linkedPawnedItem: {
        id: string;
        item_id: string;
        item_name: string;
        amount: number;
        branch_id: string;
        status: string;
      } | null = null;

      if (purpose === 'Buy Back' || purpose === 'Redeem') {
        linkedPawnedItem = await this.resolveLinkedPawnedItem(tx, branchId, dtoClean);

        if (!linkedPawnedItem) {
          throw new BadRequestException(
            `${purpose} requires a valid pawned item reference.`,
          );
        }

        if (linkedPawnedItem.status === 'Redeemed') {
          throw new BadRequestException('Pawned item is already redeemed.');
        }

        const principal = Number(linkedPawnedItem.amount ?? amounts.pawnAmount ?? 0);
        if (!Number.isFinite(principal) || principal <= 0) {
          throw new BadRequestException(
            'Buy back principal amount is invalid for this pawned item.',
          );
        }

        amounts.pawnAmount = Number(principal.toFixed(2));
        amounts.cashIn = Number(
          (amounts.pawnAmount + amounts.storageFee + amounts.returnAmount).toFixed(
            2,
          ),
        );

        payload.related_pawned_item_id = linkedPawnedItem.id;
        payload.unit_code = linkedPawnedItem.item_id;
        payload.unit = linkedPawnedItem.item_name;
        payload.pawn_amount = amounts.pawnAmount;
        payload.cash_in = amounts.cashIn;
      }

      const created = await tx.transactions.create({
        data: payload,
        select: TX_SELECT,
      });

      if (linkedPawnedItem) {
        await tx.pawned_items.update({
          where: { id: linkedPawnedItem.id },
          data: {
            status: 'Redeemed',
            updated_at: new Date(),
          },
        });

        await tx.sale_items.deleteMany({
          where: { original_pawn_id: linkedPawnedItem.id },
        });
      }

      const netChange = amounts.cashIn - amounts.cashOut;
      // Single balance writer: same Manila business date as transaction_date above.
      if (branchId && netChange !== 0) {
        await this.financeDailyBalance.applyNetChange(
          branchId,
          getPhCalendarDateString(),
          netChange,
          tx,
        );
      }

      await tx.activity_logs.create({
        data: {
          user_id: user.id ?? null,
          branch_id: branchId ?? null,
          action: 'TRANSACTION_CREATED',
          details: JSON.stringify({
            transactionId: created.id,
            transactionNo,
            purpose,
            cashIn: amounts.cashIn,
            cashOut: amounts.cashOut,
            netChange,
          }),
        },
      });

      return created;
    });

    try {
      await this.notificationsService.create({
        title:
          purpose === 'Buy Back'
            ? `Successful buyback completed - ${transactionNo}`
            : `New ${purpose.toLowerCase()} created - ${transactionNo}`,
        subtitle: dtoClean.unit
          ? `Transaction Alert: ${purpose.toLowerCase()} [${dtoClean.unit}]`
          : `Transaction Alert: ${purpose.toLowerCase()}`,
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
          purpose,
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
    const where: any = {};

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
          where.transaction_date = {
            gte: this.toDbDate(start.toISOString().slice(0, 10)),
          };
        }
      } else if (range === 'daily' || !range) {
        where.transaction_date = this.toDbDate(
          date || getPhCalendarDateString(),
        );
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
    assertBranchAccess(user, (data as any).branch_id);
    return this.mapTransaction(data);
  }

  async findLatestPawnSource(
    user: UserWithBranch,
    relatedPawnedItemId?: string,
    unitCode?: string,
  ) {
    const trimmedRelatedId = (relatedPawnedItemId || '').trim();
    const trimmedUnitCode = (unitCode || '').trim();

    if (!trimmedRelatedId && !trimmedUnitCode) {
      throw new BadRequestException(
        'Either relatedPawnedItemId or unitCode is required',
      );
    }

    const where: any = {
      purpose: 'Pawn',
      ...(isSuperAdmin(user) ? {} : buildBranchFilter(user)),
    };

    if (trimmedRelatedId) {
      where.related_pawned_item_id = trimmedRelatedId;
    } else {
      where.unit_code = trimmedUnitCode;
    }

    const row = await this.prisma.transactions.findFirst({
      where,
      select: TX_SELECT,
      orderBy: [{ transaction_date: 'desc' }, { transaction_time: 'desc' }],
    });

    if (!row) return null;
    assertBranchAccess(user, (row as any).branch_id);
    return this.mapTransaction(row);
  }

  async update(
    user: UserWithBranch,
    id: string,
    dto: Partial<CreateTransactionDto>,
  ) {
    const existing = await this.prisma.transactions.findUnique({
      where: { id },
      select: { id: true, branch_id: true },
    });
    if (!existing) throw new NotFoundException('Transaction not found');
    assertBranchAccess(user, existing.branch_id);

    const updated = await this.prisma.transactions.update({
      where: { id },
      data: {
        ...(dto.details !== undefined
          ? {
              details:
                dto.details == null || dto.details === ''
                  ? null
                  : this.encryption.encryptTransactionDetails(
                      String(dto.details),
                    ),
            }
          : {}),
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
        sessionOpenedAt: null as string | null,
        sealedTransactionIds: [] as string[],
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
      sessionOpenedAt: null as string | null,
      sealedTransactionIds: [] as string[],
    };

    let sessionOpenedAt: string | null = null;

    if (scoped) {
      const balanceDate = this.toDbDate(date || getPhCalendarDateString());
      const balanceDateStr = date || getPhCalendarDateString();

      // Parallelize both queries
      const [balanceData, sessionRow] = await Promise.all([
        this.prisma.daily_balances.findUnique({
          where: {
            branch_id_record_date: {
              branch_id: scoped,
              record_date: balanceDate,
            },
          },
          select: { starting_balance: true, ending_balance: true },
        }),
        this.prisma.branch_day_sessions.findUnique({
          where: {
            branch_id_session_date: {
              branch_id: scoped,
              session_date: balanceDate,
            },
          },
          select: {
            opened_at: true,
            is_closed: true,
            starting_balance: true,
            operational_cutoff_at: true,
            sealed_transaction_ids: true,
          },
        }),
      ]);

      const cutoffIso =
        sessionRow?.operational_cutoff_at?.toISOString() ??
        (await this.financeDailyBalance.resolveOperationalCutoffIso(
          scoped,
          balanceDateStr,
        ));
      sessionOpenedAt = cutoffIso;
      stats.sessionOpenedAt = sessionOpenedAt;
      stats.sealedTransactionIds = sessionRow?.sealed_transaction_ids ?? [];

      if (balanceData && sessionRow?.is_closed) {
        const bookAtClose = this.toNumber(balanceData.ending_balance);
        stats.startingBalance = bookAtClose;
        stats.endingBalance = bookAtClose;
        return stats;
      }

      let startingBalanceCalc = 0;
      if (
        sessionRow &&
        !sessionRow.is_closed &&
        sessionRow.starting_balance != null
      ) {
        startingBalanceCalc = this.toNumber(sessionRow.starting_balance);
      } else if (balanceData) {
        startingBalanceCalc = this.toNumber(balanceData.starting_balance);
      } else {
        const priorRow = await this.prisma.daily_balances.findFirst({
          where: { branch_id: scoped, record_date: { lt: balanceDate } },
          orderBy: { record_date: 'desc' },
          select: { ending_balance: true },
        });
        startingBalanceCalc = this.toNumber(priorRow?.ending_balance);
      }

      stats.startingBalance = startingBalanceCalc;
      const net = await this.financeDailyBalance.sumOperationalNetCash(
        scoped,
        balanceDateStr,
      );
      stats.endingBalance = Number(
        (startingBalanceCalc + net).toFixed(2),
      );
    }

    return stats;
  }
}
