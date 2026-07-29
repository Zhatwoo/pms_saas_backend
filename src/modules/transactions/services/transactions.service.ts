import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import {
  assertBranchAccess,
  buildBranchFilter,
  applyEnvironmentFilter,
  environmentCreateFields,
  getEnvironment,
  isSuperAdmin,
  requireBranchId,
} from '../../../common/utils/authorization.util';
import {
  effectiveBranchIdForQuery,
  requireUserBranchId,
} from '../../../common/utils/branch-scope.util';
import {
  getPhCalendarDateString,
  getPhWallClockTimeString,
  normalizeWallClockTimeString,
  resolveTransactionCalendarDate,
  resolveTransactionWallClockTime,
} from '../../../common/utils/branch-calendar-date.util';
import { Role } from '../../../common/enums';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { RewardsService } from '../../rewards/services/rewards.service';
import { CreateTransactionDto } from '../dto/create-transaction.dto';
import { UploadBuybackProofDto } from '../dto/upload-buyback-proof.dto';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { FinanceDailyBalanceService } from '../../branch-finance/services/finance-daily-balance.service';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

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
  buyback_proof: true,
  created_by_user_id: true,
  environment: true,
  created_by: true,
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
      pawn_date: true,
      interest_rate_snapshot: true,
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
} satisfies Prisma.transactionsSelect;

type TxRow = Prisma.transactionsGetPayload<{ select: typeof TX_SELECT }>;

const LINKED_PAWNED_ITEM_SELECT = {
  id: true,
  item_id: true,
  item_name: true,
  amount: true,
  branch_id: true,
  status: true,
} satisfies Prisma.pawned_itemsSelect;

type LinkedPawnedItem = Prisma.pawned_itemsGetPayload<{
  select: typeof LINKED_PAWNED_ITEM_SELECT;
}>;

/**
 * Shape actually read off the incoming create() payload at runtime.
 * The controller passes `createTransactionDto as any`, and this service
 * also reads a few fields (e.g. `related_sale_item_id`, `layaway`) that
 * are not declared on CreateTransactionDto. This type documents what is
 * actually accessed here without changing validation/runtime behavior.
 */
type CreateTransactionInput = Partial<CreateTransactionDto> & {
  related_sale_item_id?: string;
  layaway?: unknown;
  [key: string]: unknown;
};

const ALLOWED_TRANSACTION_PURPOSES = new Set([
  'Pawn',
  'Buy Back',
  'Buy Out',
  'Redeem',
  'Renew',
  'Reappraise',
  'Reserve / Layaway',
  'Sold Item',
  'Sale',
  'Expense',
  'Cash Transfer',
  'Fund Transfer',
  'Start',
  'End',
]);

@Injectable()
export class TransactionsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly rewardsService: RewardsService,
    private readonly encryption: EncryptionService,
    private readonly financeDailyBalance: FinanceDailyBalanceService,
    private readonly supabase: SupabaseService,
  ) {}

  onModuleInit() {
    // Run retroactive sync on startup
    void this.syncPastRenewals();
  }

  private toDbDate(value?: string | null): Date {
    const date = value || getPhCalendarDateString();
    return new Date(`${date}T00:00:00.000Z`);
  }

  private toDbTime(value?: string | null): Date {
    const time = value || getPhWallClockTimeString();
    return new Date(`1970-01-01T${time}.000Z`);
  }

  private formatDate(value?: Date | null): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
  }

  private formatTime(value?: Date | null): string | null {
    return normalizeWallClockTimeString(value);
  }

  private toNumber(value: unknown) {
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

  private resolveLayawayPayload(
    layawayInput: unknown,
    dto: Record<string, unknown>,
    downpayment: number,
  ) {
    const source =
      layawayInput && typeof layawayInput === 'object'
        ? (layawayInput as Record<string, unknown>)
        : {};

    let details: Record<string, unknown> = {};
    if (dto.details && typeof dto.details === 'object') {
      details = dto.details as Record<string, unknown>;
    } else if (typeof dto.details === 'string' && dto.details.trim()) {
      try {
        details = JSON.parse(dto.details) as Record<string, unknown>;
      } catch {
        details = {};
      }
    }

    const readString = (...values: unknown[]) => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return '';
    };

    const itemPrice = this.normalizeMoney(
      source.itemPrice ?? details.price ?? dto.pawn_amount ?? 0,
      'item_price',
    );
    const resolvedDownpayment = this.normalizeMoney(
      source.downpayment ?? details.downpayment ?? downpayment,
      'downpayment',
    );
    const remainingBalance = this.normalizeMoney(
      source.remainingBalance ??
        details.remainingBalance ??
        Math.max(itemPrice - resolvedDownpayment, 0),
      'remaining_balance',
    );

    const customerFirstName = readString(
      source.customerFirstName,
      details.customerFirstName,
    );
    const customerLastName = readString(
      source.customerLastName,
      details.customerLastName,
    );
    const customerMiddleName = readString(
      source.customerMiddleName,
      details.customerMiddleName,
    );
    const customerFullName =
      readString(source.customerFullName, details.customer) ||
      [customerFirstName, customerMiddleName, customerLastName]
        .filter(Boolean)
        .join(' ');

    if (!customerFirstName || !customerLastName || !customerFullName) {
      throw new BadRequestException(
        'Reserve / Layaway requires customer name details.',
      );
    }

    return {
      customerFirstName,
      customerMiddleName: customerMiddleName || null,
      customerLastName,
      customerFullName,
      customerContactNumber: readString(
        source.customerContactNumber,
        details.contact,
      ),
      customerAddress: readString(source.customerAddress, details.address),
      itemName: readString(source.itemName, details.itemReserved, dto.unit),
      itemCode: readString(source.itemCode, dto.unit_code) || null,
      itemPrice,
      downpayment: resolvedDownpayment,
      remainingBalance,
      terms: readString(source.terms, details.terms) || null,
      processedByName:
        readString(source.processedByName, details.processedBy) || null,
    };
  }

  private normalizePurpose(value: unknown): string {
    const purpose = (typeof value === 'string' ? value : '').trim();
    if (purpose === 'Redeem') {
      return 'Buy Out';
    }
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

    if (purpose === 'Buy Back' || purpose === 'Buy Out') {
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

    if (purpose === 'Reappraise') {
      if (amounts.cashIn <= 0 || amounts.cashOut !== 0) {
        throw new BadRequestException(
          'Reappraise transactions must be cash-in only',
        );
      }
      if (amounts.pawnAmount <= 0) {
        throw new BadRequestException(
          'Reappraise transactions must include the new pawn_amount',
        );
      }
      return;
    }

    if (purpose === 'Reserve / Layaway') {
      if (amounts.cashIn <= 0 || amounts.cashOut !== 0) {
        throw new BadRequestException(
          'Reserve / Layaway transactions must be cash-in only',
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
    tx: Prisma.TransactionClient,
    user: UserWithBranch,
    branchId: string | null,
    dto: Record<string, unknown>,
  ): Promise<LinkedPawnedItem | null> {
    const relatedPawnedItemId = (
      typeof dto.related_pawned_item_id === 'string'
        ? dto.related_pawned_item_id
        : ''
    ).trim();
    const unitCode = (
      typeof dto.unit_code === 'string' ? dto.unit_code : ''
    ).trim();

    if (relatedPawnedItemId) {
      return tx.pawned_items.findFirst({
        where: {
          id: relatedPawnedItemId,
          ...(branchId ? { branch_id: branchId } : {}),
          ...applyEnvironmentFilter(user),
        },
        select: LINKED_PAWNED_ITEM_SELECT,
      });
    }

    if (unitCode) {
      return tx.pawned_items.findFirst({
        where: {
          item_id: { equals: unitCode, mode: 'insensitive' },
          ...(branchId ? { branch_id: branchId } : {}),
          ...applyEnvironmentFilter(user),
        },
        select: LINKED_PAWNED_ITEM_SELECT,
      });
    }

    return null;
  }

  private async mapTransaction(row: TxRow) {
    const pawnedItemsDecrypted = row.pawned_items
      ? {
          ...row.pawned_items,
          customers: row.pawned_items.customers
            ? this.encryption.decryptCustomerEmbed(row.pawned_items.customers)
            : row.pawned_items.customers,
        }
      : null;

    const customersDecrypted = row.customers
      ? this.encryption.decryptCustomerEmbed(row.customers)
      : null;

    const createdByUser = this.encryption.decryptUsersJoin(row.users);

    const [resolvedIdPhoto, resolvedIdBackPhoto, resolvedBuybackProof] =
      await Promise.all([
        this.resolveStorageUrl(row.id_photo),
        this.resolveStorageUrl(row.id_back_photo),
        this.resolveStorageUrl(row.buyback_proof),
      ]);

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
      id_photo: resolvedIdPhoto,
      id_back_photo: resolvedIdBackPhoto,
      buyback_proof: resolvedBuybackProof,
      pawned_item: pawnedItemsDecrypted
        ? {
            ...pawnedItemsDecrypted,
            customer: pawnedItemsDecrypted.customers,
          }
        : null,
      customer: customersDecrypted ?? null,
      created_by_user:
        createdByUser && row.users
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
        ...applyEnvironmentFilter(user),
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
        ...applyEnvironmentFilter(user),
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
      where: applyEnvironmentFilter(user, {
        customer_id: { in: matchingCustomerIds },
      }),
      select: { id: true },
      take: 1000,
    });

    return {
      customer,
      matchingCustomerIds,
      matchingPawnedItemIds: pawnedItems.map((item) => item.id),
    };
  }

  async create(user: UserWithBranch, dto: CreateTransactionInput) {
    // Drop client-only fields that are not real DB columns.
    // This prevents 500s when UI sends extra metadata.
    const { layaway: layawayInput, ...dtoClean } = dto ?? {};
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
          ...applyEnvironmentFilter(user),
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

    let idPhotoUrl = dtoClean.id_photo ?? null;
    if (idPhotoUrl && idPhotoUrl.startsWith('data:image/')) {
      const uploadBranchId = branchId || 'system';
      const uploadCustomerId = dtoClean.customer_id || 'unknown';
      idPhotoUrl = await this.uploadPhoto(
        idPhotoUrl,
        this.buildRenewalUploadPath(uploadBranchId, uploadCustomerId),
        'id_pictures',
      );
    }

    const recordedAt = new Date();
    const transactionDate = resolveTransactionCalendarDate(
      dtoClean.transaction_date,
      recordedAt,
    );
    const transactionTime = resolveTransactionWallClockTime(
      dtoClean.transaction_time,
      recordedAt,
    );

    const payload: Prisma.transactionsUncheckedCreateInput = {
      transaction_no: transactionNo,
      branch_id: branchId,
      branch: branchName,
      customer_id: dtoClean.customer_id ?? null,
      related_pawned_item_id: dtoClean.related_pawned_item_id ?? null,
      purpose,
      transaction_date: this.toDbDate(transactionDate),
      transaction_time: this.toDbTime(transactionTime),
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
          : this.encryption.encryptTransactionDetails(
              typeof dtoClean.details === 'string'
                ? dtoClean.details
                : JSON.stringify(dtoClean.details),
            ),
      profile_photo: dtoClean.profile_photo ?? null,
      id_photo: idPhotoUrl,
      id_back_photo: dtoClean.id_back_photo ?? null,
      buyback_proof: dtoClean.buyback_proof ?? null,
      ...environmentCreateFields(user),
    };

    const data = await this.prisma.$transaction(async (tx) => {
      let linkedPawnedItem: LinkedPawnedItem | null = null;

      if (purpose === 'Buy Out') {
        linkedPawnedItem = await this.resolveLinkedPawnedItem(
          tx,
          user,
          branchId,
          dtoClean,
        );

        if (!linkedPawnedItem) {
          throw new BadRequestException(
            `${purpose} requires a valid pawned item reference.`,
          );
        }

        if (linkedPawnedItem.status === 'Redeemed') {
          throw new BadRequestException('Pawned item is already redeemed.');
        }

        const principal = Number(
          linkedPawnedItem.amount ?? amounts.pawnAmount ?? 0,
        );
        if (!Number.isFinite(principal) || principal <= 0) {
          throw new BadRequestException(
            'Buy out principal amount is invalid for this pawned item.',
          );
        }

        amounts.pawnAmount = Number(principal.toFixed(2));
        amounts.cashIn = Number(
          (
            amounts.pawnAmount +
            amounts.storageFee +
            amounts.returnAmount
          ).toFixed(2),
        );

        payload.related_pawned_item_id = linkedPawnedItem.id;
        payload.unit_code = linkedPawnedItem.item_id;
        payload.unit = linkedPawnedItem.item_name;
        payload.pawn_amount = amounts.pawnAmount;
        payload.cash_in = amounts.cashIn;
      }

      if (purpose === 'Buy Back') {
        linkedPawnedItem = await this.resolveLinkedPawnedItem(
          tx,
          user,
          branchId,
          dtoClean,
        );

        if (!linkedPawnedItem) {
          throw new BadRequestException(
            `${purpose} requires a valid pawned item reference.`,
          );
        }

        if (linkedPawnedItem.status === 'Redeemed') {
          throw new BadRequestException('Pawned item is already redeemed.');
        }

        const principal = Number(
          linkedPawnedItem.amount ?? amounts.pawnAmount ?? 0,
        );
        if (!Number.isFinite(principal) || principal <= 0) {
          throw new BadRequestException(
            'Buy back principal amount is invalid for this pawned item.',
          );
        }

        amounts.pawnAmount = Number(principal.toFixed(2));
        payload.related_pawned_item_id = linkedPawnedItem.id;
        payload.unit_code = linkedPawnedItem.item_id;
        payload.unit = linkedPawnedItem.item_name;
        payload.pawn_amount = amounts.pawnAmount;
        payload.cash_in = amounts.cashIn;
      }

      if (purpose === 'Renew') {
        linkedPawnedItem = await this.resolveLinkedPawnedItem(
          tx,
          user,
          branchId,
          dtoClean,
        );

        if (!linkedPawnedItem) {
          throw new BadRequestException(
            'Renew requires a valid pawned item reference.',
          );
        }

        const manilaDateStr = getPhCalendarDateString();
        await tx.item_renewals.create({
          data: {
            pawned_item_id: linkedPawnedItem.id,
            renewal_date: this.toDbDate(manilaDateStr),
            amount_paid: amounts.cashIn,
            ...environmentCreateFields(user),
          },
        });

        await tx.pawned_items.update({
          where: { id: linkedPawnedItem.id },
          data: {
            pawn_date: this.toDbDate(manilaDateStr),
            status: 'Active',
            updated_at: new Date(),
          },
        });

        payload.related_pawned_item_id = linkedPawnedItem.id;
        payload.unit_code = linkedPawnedItem.item_id;
        payload.unit = linkedPawnedItem.item_name;
      }

      if (purpose === 'Reappraise') {
        linkedPawnedItem = await this.resolveLinkedPawnedItem(
          tx,
          user,
          branchId,
          dtoClean,
        );

        if (!linkedPawnedItem) {
          throw new BadRequestException(
            'Reappraise requires a valid pawned item reference.',
          );
        }

        await tx.pawned_items.update({
          where: { id: linkedPawnedItem.id },
          data: {
            amount: amounts.pawnAmount,
            updated_at: new Date(),
          },
        });

        payload.related_pawned_item_id = linkedPawnedItem.id;
        payload.unit_code = linkedPawnedItem.item_id;
        payload.unit = linkedPawnedItem.item_name;
        payload.pawn_amount = amounts.pawnAmount;
      }

      let reserveSaleItemId: string | null = null;
      if (purpose === 'Reserve / Layaway') {
        reserveSaleItemId = String(dtoClean.related_sale_item_id ?? '').trim();
        if (!reserveSaleItemId) {
          throw new BadRequestException(
            'Reserve / Layaway requires a related sale item reference.',
          );
        }

        const saleItem = await tx.sale_items.findFirst({
          where: {
            id: reserveSaleItemId,
            ...(branchId ? { branch_id: branchId } : {}),
            ...applyEnvironmentFilter(user),
          },
          select: {
            id: true,
            item_id: true,
            item_name: true,
            price: true,
            status: true,
          },
        });

        if (!saleItem) {
          throw new BadRequestException(
            'Selected sale item was not found for this branch.',
          );
        }

        if ((saleItem.status ?? '').trim() !== 'Available') {
          throw new BadRequestException(
            'Only available sale items can be reserved or placed on layaway.',
          );
        }

        payload.related_sale_item_id = saleItem.id;
        payload.unit_code = saleItem.item_id;
        payload.unit = saleItem.item_name;
      }

      const created = await tx.transactions.create({
        data: payload,
        select: TX_SELECT,
      });

      if (purpose === 'Reserve / Layaway' && reserveSaleItemId) {
        const layaway = this.resolveLayawayPayload(
          layawayInput,
          dtoClean,
          amounts.cashIn,
        );

        await tx.sale_items.update({
          where: { id: reserveSaleItemId },
          data: {
            status: 'Reserved',
            updated_at: new Date(),
          },
        });

        await tx.layaway_reservations.create({
          data: {
            transaction_id: String(created.id),
            related_sale_item_id: reserveSaleItemId,
            branch_id: branchId!,
            customer_first_name: layaway.customerFirstName,
            customer_middle_name: layaway.customerMiddleName,
            customer_last_name: layaway.customerLastName,
            customer_full_name: layaway.customerFullName,
            customer_contact_number: layaway.customerContactNumber,
            customer_address: layaway.customerAddress,
            item_name: layaway.itemName,
            item_code: layaway.itemCode,
            item_price: layaway.itemPrice,
            downpayment: layaway.downpayment,
            remaining_balance: layaway.remainingBalance,
            terms: layaway.terms,
            status:
              layaway.remainingBalance > 0 ? 'PARTIALLY_PAID' : 'COMPLETED',
            processed_by_user_id: user.id ?? null,
            processed_by_name: layaway.processedByName,
            ...environmentCreateFields(user),
          },
        });
      }

      if (
        linkedPawnedItem &&
        (purpose === 'Buy Back' || purpose === 'Buy Out')
      ) {
        await tx.pawned_items.update({
          where: { id: linkedPawnedItem.id },
          data: {
            status: 'Redeemed',
            updated_at: new Date(),
          },
        });

        await tx.sale_items.deleteMany({
          where: applyEnvironmentFilter(user, {
            original_pawn_id: linkedPawnedItem.id,
          }),
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
          ...environmentCreateFields(user),
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
            ? `Successful buy back completed - ${transactionNo}`
            : purpose === 'Buy Out'
              ? `Successful buy out completed - ${transactionNo}`
              : `New ${purpose.toLowerCase()} created - ${transactionNo}`,
        subtitle: dtoClean.unit
          ? `Transaction Alert: ${purpose.toLowerCase()} [${dtoClean.unit}]`
          : `Transaction Alert: ${purpose.toLowerCase()}`,
        category: 'Transactions',
        branch_id: branchId ?? undefined,
        event_key: `transaction:${data.id}`,
        entity_type:
          purpose === 'Buy Back'
            ? 'buy_back'
            : purpose === 'Buy Out'
              ? 'redemption'
              : purpose === 'Renew'
                ? 'payment'
                : 'transaction',
        entity_id: transactionNo,
        environment: getEnvironment(user),
        created_by: user.authId,
      });
    } catch (e) {
      console.warn('[TransactionsService] Failed to create notification', e);
    }

    // Post-transaction hook: evaluate customer reward eligibility (fire-and-forget)
    if (branchId && dtoClean.customer_id) {
      this.rewardsService
        .evaluateRewardsAfterTransaction(
          user,
          dtoClean.customer_id,
          branchId,
          purpose,
        )
        .catch((err) =>
          console.warn('[TransactionsService] Reward evaluation failed', err),
        );
    }

    return await this.mapTransaction(data);
  }

  async findAll(
    user: UserWithBranch,
    branchQuery?: string,
    date?: string,
    range?: string,
    customerId?: string,
  ) {
    const scoped = effectiveBranchIdForQuery(user, branchQuery);
    const where: Prisma.transactionsWhereInput = {
      voided_at: null,
      ...applyEnvironmentFilter(user),
    };

    if (scoped) where.branch_id = scoped;
    if (!isSuperAdmin(user)) Object.assign(where, buildBranchFilter(user));

    const customerScope = customerId
      ? await this.resolveCustomerTimelineScope(user, customerId)
      : null;

    if (customerId && !customerScope) {
      return this.emptyList();
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
            gte: this.toDbDate(getPhCalendarDateString(start)),
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

    const transactions = await Promise.all(
      rows.map((row) => this.mapTransaction(row)),
    );
    const stats = await this.buildStats(user, transactions, scoped, date);

    return { transactions, stats };
  }

  async findOne(user: UserWithBranch, id: string) {
    const data = await this.prisma.transactions.findFirst({
      where: applyEnvironmentFilter(user, { id }),
      select: TX_SELECT,
    });
    if (!data) throw new NotFoundException('Transaction not found');
    assertBranchAccess(user, data.branch_id);
    return await this.mapTransaction(data);
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

    const where: Prisma.transactionsWhereInput = {
      purpose: 'Pawn',
      ...(isSuperAdmin(user) ? {} : buildBranchFilter(user)),
      ...applyEnvironmentFilter(user),
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
    assertBranchAccess(user, row.branch_id);
    return await this.mapTransaction(row);
  }

  async update(
    user: UserWithBranch,
    id: string,
    dto: Partial<CreateTransactionDto>,
  ) {
    const existing = await this.prisma.transactions.findFirst({
      where: applyEnvironmentFilter(user, { id }),
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
    return await this.mapTransaction(updated);
  }

  async remove(user: UserWithBranch, id: string) {
    const existing = await this.prisma.transactions.findFirst({
      where: applyEnvironmentFilter(user, { id }),
      select: { id: true, branch_id: true },
    });
    if (!existing) throw new NotFoundException('Transaction not found');
    assertBranchAccess(user, existing.branch_id);
    throw new InternalServerErrorException(
      'Transactions are immutable and cannot be deleted; create a reversal transaction instead.',
    );
  }

  private emptyList() {
    return {
      transactions: [],
      stats: {
        pawnedToday: 0,
        buyBack: 0,
        buyOut: 0,
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
    user: UserWithBranch,
    rows: Array<Awaited<ReturnType<TransactionsService['mapTransaction']>>>,
    scoped: string | null,
    date?: string,
  ) {
    const stats = {
      pawnedToday: rows.filter((t) => t.purpose === 'Pawn').length,
      buyBack: rows.filter(
        (t) =>
          t.purpose === 'Buy Back' &&
          String(t.details ?? '').includes('Repurchased by'),
      ).length,
      buyOut: rows.filter(
        (t) =>
          t.purpose === 'Buy Out' ||
          t.purpose === 'Redeem' ||
          (t.purpose === 'Buy Back' &&
            (String(t.details ?? '').includes('Redeemed by') ||
              String(t.details ?? '').includes('Bought out by'))),
      ).length,
      renewed: rows.filter((t) => t.purpose === 'Renew').length,
      soldItem: rows.filter(
        (t) => t.purpose === 'Sold Item' || t.purpose === 'Sale',
      ).length,
      redeemed: rows.filter(
        (t) =>
          t.purpose === 'Buy Out' ||
          t.purpose === 'Redeem' ||
          (t.purpose === 'Buy Back' &&
            (String(t.details ?? '').includes('Redeemed by') ||
              String(t.details ?? '').includes('Bought out by'))),
      ).length,
      boughtBack: rows.filter(
        (t) =>
          t.purpose === 'Buy Back' &&
          String(t.details ?? '').includes('Repurchased by'),
      ).length,
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
        this.prisma.daily_balances.findFirst({
          where: {
            branch_id: scoped,
            record_date: balanceDate,
            ...applyEnvironmentFilter(user),
          },
          select: { starting_balance: true, ending_balance: true },
        }),
        this.prisma.branch_day_sessions.findFirst({
          where: {
            branch_id: scoped,
            session_date: balanceDate,
            ...applyEnvironmentFilter(user),
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

      const needsStart = !sessionRow || sessionRow.is_closed;
      if (needsStart) {
        const isToday = balanceDateStr === getPhCalendarDateString();

        // Historical or closed book day: use stored opening/closing (never copy ending → starting).
        if (balanceData && (!isToday || sessionRow?.is_closed)) {
          stats.startingBalance = this.toNumber(balanceData.starting_balance);
          stats.endingBalance = this.toNumber(balanceData.ending_balance);
          return stats;
        }

        // Today before Start Day: opening = last closed book ending (+ pre-open activity).
        const expectedOpening =
          await this.financeDailyBalance.expectedOpeningCashBeforeStartDay(
            scoped,
            balanceDateStr,
          );
        stats.startingBalance = expectedOpening;

        if (balanceData?.ending_balance != null) {
          stats.endingBalance = Math.max(
            expectedOpening,
            this.toNumber(balanceData.ending_balance),
          );
        } else {
          stats.endingBalance = expectedOpening;
        }
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
          where: applyEnvironmentFilter(user, {
            branch_id: scoped,
            record_date: { lt: balanceDate },
          }),
          orderBy: { record_date: 'desc' },
          select: { ending_balance: true },
        });
        startingBalanceCalc = this.toNumber(priorRow?.ending_balance);
      }

      stats.startingBalance = startingBalanceCalc;
      stats.endingBalance =
        await this.financeDailyBalance.ledgerBookEndingForBusinessDate(
          scoped,
          balanceDateStr,
        );
    }

    return stats;
  }

  private async uploadPhoto(
    base64: string,
    path: string,
    bucket: string,
  ): Promise<string> {
    const client = this.supabase.getClient();
    const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
    const buf = Buffer.from(base64Data, 'base64');

    const { error } = await client.storage.from(bucket).upload(path, buf, {
      contentType: 'image/jpeg',
      upsert: true,
    });

    if (error) {
      throw new InternalServerErrorException(
        `Photo upload to ${bucket} failed: ${error.message}`,
      );
    }

    const { data: signedData, error: signError } = await client.storage
      .from(bucket)
      .createSignedUrl(path, 60 * 60 * 24 * 7);

    if (signError || !signedData?.signedUrl) {
      return `${bucket}/${path}`;
    }

    return signedData.signedUrl;
  }

  private buildRenewalUploadPath(branchId: string, customerId: string) {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return `${branchId}/${customerId}/renewal_${timestamp}_${rand}.jpg`;
  }

  private async resolveStorageUrl(storedUrl?: string | null): Promise<string> {
    if (!storedUrl) {
      return '';
    }

    if (!storedUrl.startsWith('http')) {
      const parts = storedUrl.split('/');
      if (parts.length < 2) return storedUrl;
      const bucket = parts[0];
      const path = parts.slice(1).join('/');

      try {
        const { data, error } = await this.supabase
          .getClient()
          .storage.from(bucket)
          .createSignedUrl(path, 60 * 60 * 24 * 7);

        if (!error && data?.signedUrl) {
          return data.signedUrl;
        }

        const { data: pubData } = this.supabase
          .getClient()
          .storage.from(bucket)
          .getPublicUrl(path);

        return pubData?.publicUrl || storedUrl;
      } catch {
        return storedUrl;
      }
    }

    try {
      const parsedUrl = new URL(storedUrl);
      const publicPrefix = '/storage/v1/object/public/';
      const signedPrefix = '/storage/v1/object/sign/';

      const storagePrefix = parsedUrl.pathname.includes(publicPrefix)
        ? publicPrefix
        : parsedUrl.pathname.includes(signedPrefix)
          ? signedPrefix
          : null;

      if (!storagePrefix) {
        return storedUrl;
      }

      const storagePath = parsedUrl.pathname.split(storagePrefix)[1];
      if (!storagePath) {
        return storedUrl;
      }

      const [bucketName, ...objectPathParts] = storagePath.split('/');
      const objectPath = objectPathParts.join('/');

      if (!bucketName || !objectPath) {
        return storedUrl;
      }

      const { data, error } = await this.supabase
        .getClient()
        .storage.from(bucketName)
        .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

      if (error || !data?.signedUrl) {
        return storedUrl;
      }

      return data.signedUrl;
    } catch {
      return storedUrl;
    }
  }

  async uploadBuybackProof(
    user: UserWithBranch,
    dto: UploadBuybackProofDto,
  ): Promise<{ proofUrl: string }> {
    // Authorization check
    if (
      user.role !== Role.SUPER_ADMIN &&
      user.role !== Role.ADMIN &&
      user.role !== Role.EMPLOYEE
    ) {
      throw new ForbiddenException(
        'You are not allowed to upload buyback proofs',
      );
    }

    // Determine branch ID
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? dto.branchId?.trim() || 'super-admin'
        : requireUserBranchId(user);

    // Get Supabase client
    const client = this.supabase.getClient();

    // Decode base64 data
    const base64Data = dto.fileData.includes(',')
      ? dto.fileData.split(',')[1]
      : dto.fileData;
    const fileBuffer = Buffer.from(base64Data, 'base64');

    // Extract and validate file extension
    const extension = this.getUploadExtension(dto.fileData, dto.fileName);
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp'];
    if (!allowedExtensions.includes(extension)) {
      throw new BadRequestException(
        'Invalid file extension. Only JPG, PNG, and WEBP are allowed.',
      );
    }

    // Extract and validate MIME type
    const contentType = this.getUploadContentType(dto.fileData, dto.fileName);
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(contentType)) {
      throw new BadRequestException(
        'Invalid file type. Only JPEG, PNG, and WEBP are allowed.',
      );
    }

    // Validate file size (4MB limit as per requirements)
    const MAX_SIZE = 4 * 1024 * 1024;
    if (fileBuffer.length > MAX_SIZE) {
      throw new BadRequestException('File is too large. Maximum size is 4MB.');
    }

    // Generate unique filename: {branchId}/buyback_{transactionNo}_{timestamp}_{originalFileName}
    const branchPart = this.sanitizePathPart(branchId);
    const transactionPart = this.sanitizePathPart(dto.transactionNo);
    const timestamp = Date.now();
    const sanitizedFileName = this.sanitizePathPart(
      dto.fileName.replace(/\.[^.]+$/, ''),
    ); // Remove extension from original filename
    const filePath = `${branchPart}/buyback_${transactionPart}_${timestamp}_${sanitizedFileName}.${extension}`;

    // Upload to Supabase storage with upsert enabled
    const { error } = await client.storage
      .from('buyback-proofs')
      .upload(filePath, fileBuffer, {
        upsert: true,
        contentType: contentType,
      });

    if (error) {
      console.error('Upload error:', error);
      throw new InternalServerErrorException(
        `Proof upload failed: ${error.message}`,
      );
    }

    // Get and return public URL
    const { data } = client.storage
      .from('buyback-proofs')
      .getPublicUrl(filePath);

    return { proofUrl: data.publicUrl };
  }

  private sanitizePathPart(value: string): string {
    return value
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private getUploadContentType(fileData: string, fileName?: string): string {
    if (fileData.startsWith('data:')) {
      const header = fileData.slice(0, fileData.indexOf(','));
      const match = header.match(/^data:([^;]+);base64$/i);
      if (match?.[1]) {
        return match[1];
      }
    }

    if (fileName) {
      const ext = fileName.split('.').pop()?.toLowerCase();
      if (ext === 'png') return 'image/png';
      if (ext === 'webp') return 'image/webp';
      if (ext === 'gif') return 'image/gif';
    }

    return 'image/jpeg';
  }

  private getUploadExtension(fileData: string, fileName?: string): string {
    if (fileName && fileName.includes('.')) {
      return fileName.split('.').pop()?.toLowerCase() ?? 'jpg';
    }

    if (fileData.startsWith('data:')) {
      const header = fileData.slice(0, fileData.indexOf(','));
      const match = header.match(/^data:[^/]+\/([^;]+);base64$/i);
      if (match?.[1]) {
        const ext = match[1].toLowerCase();
        if (ext === 'jpeg') return 'jpg';
        return ext;
      }
    }

    return 'jpg';
  }

  async syncPastRenewals() {
    try {
      const renewTx = await this.prisma.transactions.findMany({
        where: {
          purpose: 'Renew',
          related_pawned_item_id: { not: null },
          voided_at: null,
        },
        select: {
          id: true,
          related_pawned_item_id: true,
          transaction_date: true,
          cash_in: true,
        },
      });

      for (const tx of renewTx) {
        const pawnedItemId = tx.related_pawned_item_id!;
        const renewalDate = tx.transaction_date;

        const existingRenewal = await this.prisma.item_renewals.findFirst({
          where: {
            pawned_item_id: pawnedItemId,
            renewal_date: renewalDate,
          },
        });

        if (!existingRenewal) {
          console.log(
            `[Sync] Creating missing item_renewal for pawned item ${pawnedItemId} on date ${tx.transaction_date.toISOString()}`,
          );
          await this.prisma.item_renewals.create({
            data: {
              pawned_item_id: pawnedItemId,
              renewal_date: renewalDate,
              amount_paid: tx.cash_in,
            },
          });
        }
      }

      const pawnedItems = await this.prisma.pawned_items.findMany({
        where: {
          status: 'Active',
          item_renewals: { some: {} },
        },
        include: {
          item_renewals: {
            orderBy: { renewal_date: 'desc' },
            take: 1,
          },
        },
      });

      for (const item of pawnedItems) {
        const latestRenewal = item.item_renewals[0];
        if (latestRenewal) {
          const renewalDate = new Date(latestRenewal.renewal_date);
          const pawnDate = new Date(item.pawn_date);

          if (renewalDate.getTime() > pawnDate.getTime()) {
            console.log(
              `[Sync] Updating pawn_date of item ${item.item_id} from ${pawnDate.toISOString()} to ${renewalDate.toISOString()}`,
            );
            await this.prisma.pawned_items.update({
              where: { id: item.id },
              data: {
                pawn_date: latestRenewal.renewal_date,
                updated_at: new Date(),
              },
            });
          }
        }
      }
      console.log(
        '[Sync] Past renewals synchronization completed successfully.',
      );
    } catch (error) {
      console.error('[Sync] Failed to sync past renewals:', error);
    }
  }
}
