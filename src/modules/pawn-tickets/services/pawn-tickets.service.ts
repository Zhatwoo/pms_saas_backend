import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { PrismaService } from '../../../infrastructure/prisma';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import {
  requireUserBranchId,
  effectiveBranchIdForQuery,
} from '../../../common/utils/branch-scope.util';
import {
  applyEnvironmentFilter,
  assertBranchAccess,
  environmentCreateFields,
  getEnvironment,
} from '../../../common/utils/authorization.util';
import { CreatePawnTicketDto } from '../dto/create-pawn-ticket.dto';
import {
  getPhCalendarDateString,
  getPhWallClockTimeString,
  resolveTransactionCalendarDate,
  resolveTransactionWallClockTime,
} from '../../../common/utils/branch-calendar-date.util';

import { NotificationsService } from '../../notifications/services/notifications.service';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { FinanceDailyBalanceService } from '../../branch-finance/services/finance-daily-balance.service';
import {
  findInterestRateGroup,
  normalizeInterestRates,
} from '../../../common/utils/inventory-valuation.util';

type PawnTicketDbClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class PawnTicketsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly encryption: EncryptionService,
    private readonly financeDailyBalance: FinanceDailyBalanceService,
  ) {}

  private getVerificationMode(idPresented?: string | null) {
    const value = idPresented?.trim() || '';

    if (value === 'No ID / None') {
      return 'no-id';
    }

    if (value === 'NBI Clearance' || value === 'Police Clearance') {
      return 'single-document';
    }

    return 'standard-id';
  }

  private isPawnTicketMigrationMissing(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const rec = error as Record<string, unknown>;
    const message = typeof rec.message === 'string' ? rec.message : '';

    return (
      message.includes("Could not find the table 'public.customers'") ||
      message.includes("column 'customer_id' does not exist") ||
      message.includes("column 'created_by_user_id' does not exist") ||
      message.includes("column 'id_back_photo' does not exist") ||
      message.includes('relation "public.customers" does not exist')
    );
  }

  private isItemPhotosSchemaCacheError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const rec = error as Record<string, unknown>;
    const message = typeof rec.message === 'string' ? rec.message : '';

    return (
      message.includes(
        "Could not find the 'item_photos' column of 'pawned_items' in the schema cache",
      ) || message.includes("column 'item_photos' does not exist")
    );
  }

  private throwMissingMigrationError() {
    throw new InternalServerErrorException(
      'Database schema is incomplete for pawn tickets. Apply migrations PMS_backend/supabase/migrations/009_create_customers_and_pawn_ticket_relations.sql, PMS_backend/supabase/migrations/018_add_item_photo_to_pawned_items.sql, and PMS_backend/supabase/migrations/020_add_item_photos_to_pawned_items.sql, then refresh the Supabase schema cache.',
    );
  }

  private generateTransactionNo() {
    return `PAWN-${Date.now()}`;
  }

  private normalizeProvidedItemId(unitCode?: string) {
    const value = unitCode?.trim();
    if (value && !value.startsWith('PENDING')) {
      return value.toUpperCase();
    }
    return null;
  }

  private parseUnitCodeSequence(itemId: string) {
    const match = itemId.trim().match(/(\d+)$/);
    if (!match) return 0;
    const sequenceNumber = Number.parseInt(match[1], 10);
    return Number.isNaN(sequenceNumber) ? 0 : sequenceNumber;
  }

  private async generateNextItemIdForBranch(
    branchId: string,
    branchCode: string,
    client: PawnTicketDbClient = this.prisma,
  ) {
    const normalizedCode = branchCode?.toUpperCase() || '001';

    // Query globally across all pawned_items matching prefix (item_id is globally @unique)
    const items = await client.pawned_items.findMany({
      where: {
        item_id: { startsWith: `${normalizedCode}-`, mode: 'insensitive' },
      },
      select: { item_id: true },
      take: 5000,
    });

    const used = new Set(items.map((item) => item.item_id.toUpperCase()));
    let maxNumber = 0;
    for (const item of items) {
      const seq = this.parseUnitCodeSequence(item.item_id);
      if (seq > maxNumber) maxNumber = seq;
    }

    for (let next = maxNumber + 1; next < maxNumber + 10000; next += 1) {
      const candidate = `${normalizedCode}-JCLB-${String(next).padStart(5, '0')}`;
      if (!used.has(candidate)) {
        const exists = await client.pawned_items.findFirst({
          where: { item_id: { equals: candidate, mode: 'insensitive' } },
          select: { id: true },
        });
        if (!exists) {
          return candidate;
        }
      }
    }

    return `${normalizedCode}-JCLB-${Date.now()}`;
  }

  private async resolveItemId(
    branchId: string,
    branchCode: string,
    unitCode?: string,
    client: PawnTicketDbClient = this.prisma,
  ) {
    const provided = this.normalizeProvidedItemId(unitCode);
    if (provided) {
      const existing = await client.pawned_items.findFirst({
        where: {
          item_id: { equals: provided, mode: 'insensitive' },
        },
        select: { id: true },
      });

      if (!existing) {
        return provided;
      }
    }

    return this.generateNextItemIdForBranch(branchId, branchCode, client);
  }

  private isItemIdUniqueError(error: unknown) {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const rec = error as Record<string, unknown>;
    if (rec.code !== 'P2002') {
      return false;
    }

    const meta = rec.meta as Record<string, unknown> | undefined;
    const target = meta?.target;
    const message = typeof rec.message === 'string' ? rec.message : '';

    const isP2002 = rec.code === 'P2002';
    const mentionsItemId =
      message.toLowerCase().includes('item_id') ||
      (Array.isArray(target)
        ? target.some((t) => String(t).toLowerCase().includes('item_id'))
        : typeof target === 'string' &&
          target.toLowerCase().includes('item_id'));

    return isP2002 && (mentionsItemId || !target);
  }

  private getTodayDateKey() {
    return getPhCalendarDateString();
  }

  private async loadInterestRates(user: AuthenticatedUserProfile) {
    const row = await this.prisma.shop_settings.findFirst({
      where: {
        setting_key: 'interest_rates',
        ...applyEnvironmentFilter(user),
      },
      select: { setting_value: true },
    });
    return normalizeInterestRates(row?.setting_value);
  }

  private toDbDate(value?: string | null): Date {
    return new Date(`${value || getPhCalendarDateString()}T00:00:00.000Z`);
  }

  private toDbTime(value?: string | null): Date {
    const time = value || getPhWallClockTimeString();
    return new Date(`1970-01-01T${time}.000Z`);
  }

  private formatDate(value?: Date | null): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
  }

  private toNumber(value: Prisma.Decimal | number | string | null | undefined) {
    if (value == null) return 0;
    return Number(value);
  }

  private formatSupabaseError(error: unknown): string {
    if (error == null) {
      return 'Unknown database error';
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
    if (typeof error === 'number' || typeof error === 'boolean') {
      return String(error);
    }
    if (typeof error !== 'object') {
      // Non-object, non-string/number/boolean primitive (e.g. bigint, symbol).
      return 'Unknown database error';
    }
    const rec = error as Record<string, unknown>;
    const parts = [rec.message, rec.details, rec.hint, rec.code].filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    if (parts.length > 0) {
      return parts.join(' — ');
    }
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown database error';
    }
  }

  private buildSerialPrefix(branchCode: string) {
    return `${branchCode}-SN-${this.getTodayDateKey().replaceAll('-', '')}-`;
  }

  private async generateNextSerialNumberForBranch(
    branchId: string,
    branchCode: string,
  ) {
    if (!branchCode) {
      throw new InternalServerErrorException('Branch code not found');
    }

    const serialPrefix = this.buildSerialPrefix(branchCode);

    const items = await this.prisma.pawned_items.findMany({
      where: {
        branch_id: branchId,
        serial_number: { startsWith: serialPrefix, mode: 'insensitive' },
      },
      select: { serial_number: true },
      orderBy: { serial_number: 'desc' },
      take: 100,
    });

    let maxNumber = 0;
    for (const item of items) {
      const serialNumber = item.serial_number?.trim();
      if (!serialNumber || !serialNumber.startsWith(serialPrefix)) {
        continue;
      }

      const sequencePart = serialNumber.slice(serialPrefix.length);
      const sequenceNumber = Number.parseInt(sequencePart, 10);
      if (!Number.isNaN(sequenceNumber) && sequenceNumber > maxNumber) {
        maxNumber = sequenceNumber;
      }
    }

    const nextNumber = String(maxNumber + 1).padStart(3, '0');

    return `${serialPrefix}${nextNumber}`;
  }

  async findAll(
    user: AuthenticatedUserProfile,
    query: { branch?: string; status?: string; search?: string },
  ) {
    const branchId = effectiveBranchIdForQuery(user, query.branch);
    const where: Prisma.pawned_itemsWhereInput = applyEnvironmentFilter(user);
    if (branchId) where.branch_id = branchId;
    if (query.status) where.status = query.status;

    const items = await this.prisma.pawned_items.findMany({
      where,
      select: {
        id: true,
        item_name: true,
        item_id: true,
        serial_number: true,
        amount: true,
        pawn_date: true,
        status: true,
        branch_id: true,
        customer_id: true,
        customers: {
          select: { id: true, full_name: true, contact_number: true },
        },
        branches: { select: { name: true } },
      },
      orderBy: { pawn_date: 'desc' },
      take: 500,
    });

    let normalized = items.map((item) => {
      const cust = item.customers
        ? (this.encryption.decryptCustomerEmbed(
            item.customers,
          ) as typeof item.customers)
        : null;
      return {
        ...item,
        amount: this.toNumber(item.amount),
        pawn_date: this.formatDate(item.pawn_date),
        unit_code: item.item_id ?? null,
        customer: cust ?? null,
        branch: item.branches ?? null,
        customers: undefined,
        branches: undefined,
      };
    });

    if (query.search) {
      const q = query.search.toLowerCase();
      normalized = normalized.filter(
        (item) =>
          (item.item_name ?? '').toLowerCase().includes(q) ||
          (item.item_id ?? '').toLowerCase().includes(q) ||
          (item.serial_number ?? '').toLowerCase().includes(q) ||
          (item.customer?.full_name ?? '').toLowerCase().includes(q),
      );
    }

    return normalized;
  }

  async create(user: AuthenticatedUserProfile, dto: CreatePawnTicketDto) {
    const environmentFields = environmentCreateFields(user);
    const environment = getEnvironment(user);
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? (dto.branchId ?? requireUserBranchId(user))
        : requireUserBranchId(user);
    assertBranchAccess(user, branchId);

    const branch = await this.prisma.branches.findFirst({
      where: { id: branchId, environment },
      select: { name: true, status: true, branch_code: true },
    });
    if (!branch || branch.status?.trim().toLowerCase() !== 'active') {
      throw new BadRequestException('Invalid or inactive branch');
    }

    const pawnAmount = Number(Number(dto.transaction.pawnAmount).toFixed(2));
    const storageFee = Number(
      Number(dto.transaction.storageFee ?? 0).toFixed(2),
    );
    const returnAmount = Number(
      Number(dto.transaction.returnAmount ?? 0).toFixed(2),
    );
    if (
      !Number.isFinite(pawnAmount) ||
      !Number.isFinite(storageFee) ||
      !Number.isFinite(returnAmount) ||
      pawnAmount <= 0 ||
      storageFee < 0 ||
      returnAmount < 0
    ) {
      throw new BadRequestException('Invalid pawn transaction amounts');
    }

    const branchName = branch.name;
    const interestRates = await this.loadInterestRates(user);
    const itemCategory = dto.item.category?.trim() || 'Miscellaneous';
    const matchedRateGroup = findInterestRateGroup(interestRates, itemCategory);
    const interestRateSnapshot: Prisma.InputJsonValue | typeof Prisma.JsonNull =
      matchedRateGroup
        ? ({ ...matchedRateGroup } as Prisma.InputJsonValue)
        : Prisma.JsonNull;

    const providedSerialNumber = dto.item.serialNumber?.trim();
    const serialNumber =
      providedSerialNumber && !providedSerialNumber.startsWith('PENDING')
        ? providedSerialNumber
        : await this.generateNextSerialNumberForBranch(
            branchId,
            branch.branch_code,
          );
    const selectedCustomerId = dto.customerId?.trim() || null;
    const customerIdForUpload = selectedCustomerId || randomUUID();

    // 1. Process Photos if present
    const verificationMode = this.getVerificationMode(dto.customer.idPresented);
    let profilePhotoUrl: string | null = null;
    let idPhotoUrl: string | null = null;
    let idBackPhotoUrl: string | null = null;
    let itemPhotoUrls: string[] = [];

    if (verificationMode === 'no-id') {
      if (!dto.item.profilePhoto) {
        throw new BadRequestException(
          'Customer photo is required when No ID / None is selected.',
        );
      }

      profilePhotoUrl = await this.uploadPhoto(
        dto.item.profilePhoto,
        this.buildUploadPath('profile'),
        'profile_image',
      );
    } else if (verificationMode === 'single-document') {
      if (!dto.item.idPhoto) {
        throw new BadRequestException(
          'Document image is required for clearance verification.',
        );
      }

      idPhotoUrl = await this.uploadPhoto(
        dto.item.idPhoto,
        this.buildCustomerIdUploadPath(
          branchId,
          customerIdForUpload,
          'id-front',
        ),
        'id_pictures',
      );
    } else {
      if (!dto.item.idPhoto || !dto.item.idBackPhoto) {
        throw new BadRequestException(
          'Front and back ID photos are required for standard IDs.',
        );
      }

      idPhotoUrl = await this.uploadPhoto(
        dto.item.idPhoto,
        this.buildCustomerIdUploadPath(
          branchId,
          customerIdForUpload,
          'id-front',
        ),
        'id_pictures',
      );

      idBackPhotoUrl = await this.uploadPhoto(
        dto.item.idBackPhoto,
        this.buildCustomerIdUploadPath(
          branchId,
          customerIdForUpload,
          'id-back',
        ),
        'id_pictures',
      );
    }

    const rawItemPhotos =
      Array.isArray(dto.item.itemPhotos) && dto.item.itemPhotos.length > 0
        ? dto.item.itemPhotos
        : [];

    const itemPhotoInputs = rawItemPhotos.filter(
      (photo): photo is string =>
        typeof photo === 'string' && photo.trim().length > 0,
    );

    if (itemPhotoInputs.length === 0) {
      throw new BadRequestException('Item photo is required for pawned items.');
    }

    itemPhotoUrls = await Promise.all(
      itemPhotoInputs.map((photo, index) =>
        this.uploadPhoto(
          photo,
          this.buildBranchScopedUploadPath(branchId, `item-${index + 1}`),
          'pawned_items',
        ),
      ),
    );

    const customerPayload = {
      full_name: dto.customer.fullName.trim(),
      address: dto.customer.address.trim(),
      barangay: dto.customer.barangay?.trim() ?? null,
      city: dto.customer.city?.trim() ?? null,
      region: dto.customer.region?.trim() ?? null,
      contact_number: dto.customer.contactNumber?.trim() ?? null,
      email: dto.customer.email?.trim() ?? null,
      id_presented: dto.customer.idPresented?.trim() ?? null,
      branch_id: branchId,
      ...environmentFields,
    };

    const pawnedItemSelect = {
      id: true,
      item_id: true,
      item_name: true,
      category: true,
      branch_id: true,
      branch: true,
      pawn_date: true,
      status: true,
      remarks: true,
      qr_code: true,
      condition_report: true,
      created_at: true,
      updated_at: true,
      customer_id: true,
      profile_photo: true,
      id_photo: true,
      amount: true,
      serial_number: true,
      items_included: true,
      condition: true,
      memory_storage: true,
      id_back_photo: true,
      item_photos: true,
    } satisfies Prisma.pawned_itemsSelect;

    type CreatedPawnedItem = Prisma.pawned_itemsGetPayload<{
      select: typeof pawnedItemSelect;
    }>;
    let result: {
      customer: { id: string; [key: string]: unknown };
      pawnedItem: CreatedPawnedItem;
      transaction: Prisma.transactionsGetPayload<Record<string, never>>;
      transactionNo: string;
    } | null = null;

    let itemId = '';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await this.prisma.$transaction(async (tx) => {
          itemId = await this.resolveItemId(
            branchId,
            branch.branch_code,
            attempt === 0 ? dto.item.unitCode : undefined,
            tx,
          );

          const manilaDate = getPhCalendarDateString();
          await this.financeDailyBalance.assertNetChangePermittedInTx(
            tx,
            branchId,
            manilaDate,
            -pawnAmount,
          );

          let customer: { id: string; [key: string]: unknown } | null = null;

          if (selectedCustomerId) {
            const existingCustomer = await tx.customers.findFirst({
              where: {
                id: selectedCustomerId,
                branch_id: branchId,
                environment,
                deleted_at: null,
              },
            });

            if (!existingCustomer) {
              throw new BadRequestException(
                'Selected customer was not found for the active branch.',
              );
            }

            customer = existingCustomer;
          } else {
            const customerWrite = { ...customerPayload } as Record<
              string,
              unknown
            >;
            customerWrite.id = customerIdForUpload;
            this.encryption.applyCustomerFieldsForWrite(customerWrite);
            customer = await tx.customers.create({
              data: customerWrite as typeof customerPayload,
              select: { id: true },
            });
          }

          const itemIdTaken = await tx.pawned_items.findUnique({
            where: { item_id: itemId },
            select: { id: true },
          });
          if (itemIdTaken) {
            itemId = await this.generateNextItemIdForBranch(
              branchId,
              branch.branch_code,
              tx,
            );
          }

          const itemPayload = {
            item_id: itemId,
            item_name: dto.item.unitName.trim(),
            category: itemCategory,
            branch_id: branchId,
            branch: branchName,
            pawn_date: dto.item.purchasedDate || getPhCalendarDateString(),
            status: 'Active',
            remarks: dto.item.remarks?.trim() ?? '',
            qr_code: dto.item.qrCode ?? null,
            profile_photo: profilePhotoUrl,
            item_photos: itemPhotoUrls,
            id_photo: idPhotoUrl,
            id_back_photo: idBackPhotoUrl,
            condition: dto.item.condition?.trim() ?? '',
            serial_number: serialNumber,
            items_included: dto.item.itemsIncluded?.trim() ?? '',
            memory_storage: dto.item.memoryStorage?.trim() ?? '',
            condition_report: dto.item.condition?.trim() ?? '',
            customer_id: customer.id,
            amount: pawnAmount,
            interest_rate_snapshot: interestRateSnapshot,
          };

          const pawnedItem = await tx.pawned_items.create({
            data: {
              ...itemPayload,
              ...environmentFields,
              pawn_date: this.toDbDate(itemPayload.pawn_date),
              amount: itemPayload.amount,
            },
            select: pawnedItemSelect,
          });

          const recordedAt = new Date();
          const transactionDate = resolveTransactionCalendarDate(
            dto.transaction?.transactionDate,
            recordedAt,
          );
          const transactionTime = resolveTransactionWallClockTime(
            dto.transaction?.transactionTime,
            recordedAt,
          );

          const transactionPayload = {
            transaction_no: this.generateTransactionNo(),
            branch_id: branchId,
            branch: branchName,
            purpose: 'Pawn',
            transaction_date: this.toDbDate(transactionDate),
            transaction_time: this.toDbTime(transactionTime),
            // Pawn disbursement is a cash outflow from branch to customer.
            cash_in: 0,
            cash_out: pawnAmount,
            return_amount: returnAmount,
            unit: dto.item.unitName.trim(),
            unit_code: itemId,
            pawn_amount: pawnAmount,
            storage_fee: storageFee,
            details: this.encryption.encryptTransactionDetails(
              dto.transaction.details?.trim() ?? null,
            ),
            related_pawned_item_id: pawnedItem.id ?? null,
            created_by_user_id: user.id,
            profile_photo: profilePhotoUrl,
            id_photo: idPhotoUrl,
            id_back_photo: idBackPhotoUrl,
            ...environmentFields,
          };

          const transaction = await tx.transactions.create({
            data: transactionPayload,
          });

          const netChange =
            Number(transactionPayload.cash_in ?? 0) -
            Number(transactionPayload.cash_out ?? 0);
          if (netChange !== 0) {
            await this.financeDailyBalance.applyNetChange(
              branchId,
              getPhCalendarDateString(),
              netChange,
              tx,
              {
                environment: environmentFields.environment,
                createdBy: environmentFields.created_by,
              },
            );
          }

          await tx.activity_logs.create({
            data: {
              user_id: user.id,
              branch_id: branchId,
              action: 'PAWN_TICKET_CREATED',
              ...environmentFields,
              details: JSON.stringify({
                pawnedItemId: pawnedItem.id ?? null,
                transactionId: transaction.id,
                transactionNo: transactionPayload.transaction_no,
                pawnAmount,
                storageFee,
                returnAmount,
                netChange,
              }),
            },
          });

          return {
            customer,
            pawnedItem,
            transaction,
            transactionNo: transactionPayload.transaction_no,
          };
        });
        break;
      } catch (e) {
        if (this.isItemIdUniqueError(e) && attempt < 2) {
          continue;
        }

        throw e;
      }
    }

    if (!result) {
      throw new InternalServerErrorException('Failed to create pawn ticket.');
    }

    // 4. Create Notification
    try {
      await this.notificationsService.create({
        title: `New pawn transaction created - ${result.transactionNo}`,
        subtitle: `Transaction Alert: new pawn [${dto.item.unitName}]`,
        category: 'Transactions',
        branch_id: branchId,
        event_key: `pawn-ticket:${result.transaction.id}`,
        entity_type: 'transaction',
        entity_id: result.transactionNo,
      });
    } catch (e) {
      console.warn('[PawnTicketsService] Failed to create notification', e);
    }

    return {
      customer: result.customer,
      pawnedItem: result.pawnedItem,
      transaction: {
        ...result.transaction,
        details: this.encryption.decryptTransactionDetails(
          result.transaction.details,
        ),
      },
    };
  }

  async generateNextUnitCode(user: AuthenticatedUserProfile) {
    const branchId = requireUserBranchId(user);
    const branch = await this.prisma.branches.findUnique({
      where: { id: branchId },
      select: { branch_code: true },
    });

    if (!branch?.branch_code) {
      throw new InternalServerErrorException('Branch code not found');
    }

    return {
      unitCode: await this.generateNextItemIdForBranch(
        branchId,
        branch.branch_code,
      ),
    };
  }

  async generateNextSerialNumber(user: AuthenticatedUserProfile) {
    const branchId = requireUserBranchId(user);
    const branch = await this.prisma.branches.findUnique({
      where: { id: branchId },
      select: { branch_code: true },
    });

    if (!branch?.branch_code) {
      throw new InternalServerErrorException('Branch code not found');
    }

    const serialNumber = await this.generateNextSerialNumberForBranch(
      branchId,
      branch.branch_code,
    );

    return {
      serialNumber,
    };
  }

  private async uploadPhoto(
    base64: string,
    path: string,
    bucket: string,
  ): Promise<string> {
    const client = this.supabase.getClient();
    // Remove data:image/jpeg;base64, or similar prefix
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

  private buildUploadPath(prefix: string) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  }

  private buildBranchScopedUploadPath(branchId: string, prefix: string) {
    return `${branchId}/${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  }

  private buildCustomerIdUploadPath(
    branchId: string,
    customerId: string,
    filename: 'id-front' | 'id-back',
  ) {
    return `${branchId}/${customerId}/${filename}.jpg`;
  }

  async findByUnitCode(unitCode: string) {
    const cleanCode = (() => {
      const raw = String(unitCode || '').trim();
      try {
        return decodeURIComponent(raw).trim().toUpperCase();
      } catch {
        return raw.toUpperCase();
      }
    })();

    if (!cleanCode) {
      throw new BadRequestException('Item not found or unit code is invalid.');
    }

    const item = await this.prisma.pawned_items.findFirst({
      where: { item_id: { equals: cleanCode, mode: 'insensitive' } },
      include: { customers: true, branches: true },
    });

    if (item) {
      return this.mapPublicPawnedTicket(item);
    }

    const saleItem = await this.prisma.sale_items.findFirst({
      where: { item_id: { equals: cleanCode, mode: 'insensitive' } },
      include: {
        customers: true,
        branches: true,
        pawned_items: { include: { customers: true } },
      },
    });

    if (!saleItem) {
      throw new BadRequestException('Item not found or unit code is invalid.');
    }

    return this.mapPublicSaleTicket(saleItem);
  }

  private async mapPublicPawnedTicket(
    item: Prisma.pawned_itemsGetPayload<{
      include: { customers: true; branches: true };
    }>,
  ) {
    const [profilePhoto, itemPhotos, idPhoto, idBackPhoto] = await Promise.all([
      this.resolveStorageUrl(item.profile_photo),
      this.resolveStorageUrls(
        item.item_photos as Array<string | null> | string | null,
      ),
      this.resolveStorageUrl(item.id_photo),
      this.resolveStorageUrl(item.id_back_photo),
    ]);

    return {
      listing_type: 'pawn' as const,
      ...item,
      customer: item.customers
        ? (this.encryption.decryptCustomerEmbed(
            item.customers,
          ) as (typeof item)['customers'])
        : null,
      branch_info: item.branches,
      customers: undefined,
      branches: undefined,
      amount: this.toNumber(item.amount),
      pawn_date: this.formatDate(item.pawn_date),
      profile_photo: profilePhoto,
      item_photos: itemPhotos,
      id_photo: idPhoto,
      id_back_photo: idBackPhoto,
    };
  }

  private async mapPublicSaleTicket(
    saleItem: Prisma.sale_itemsGetPayload<{
      include: {
        customers: true;
        branches: true;
        pawned_items: { include: { customers: true } };
      };
    }>,
  ) {
    const pawned = saleItem.pawned_items;
    const customerSource = saleItem.customers ?? pawned?.customers ?? null;
    const [saleImage, profilePhoto, pawnedPhotos] = await Promise.all([
      this.resolveStorageUrl(saleItem.image_url),
      this.resolveStorageUrl(pawned?.profile_photo),
      this.resolveStorageUrls(
        (pawned?.item_photos as Array<string | null> | string | null) ?? null,
      ),
    ]);

    const itemPhotos = [
      ...(saleImage ? [saleImage] : []),
      ...pawnedPhotos.filter((url) => url && url !== saleImage),
    ];

    return {
      listing_type: 'sale' as const,
      id: saleItem.id,
      item_id: saleItem.item_id,
      item_name: saleItem.item_name,
      category: saleItem.category,
      amount: this.toNumber(saleItem.price),
      pawn_date: this.formatDate(saleItem.available_date),
      serial_number: pawned?.serial_number ?? null,
      condition: pawned?.condition ?? saleItem.status,
      items_included: pawned?.items_included ?? null,
      memory_storage: pawned?.memory_storage ?? null,
      remarks: null,
      status: saleItem.status,
      customer: customerSource
        ? (this.encryption.decryptCustomerEmbed(
            customerSource,
          ) as typeof customerSource)
        : null,
      branch_info: saleItem.branches,
      profile_photo: profilePhoto,
      item_photos: itemPhotos,
      id_photo: '',
      id_back_photo: '',
    };
  }

  private async resolveStorageUrl(storedUrl?: string | null): Promise<string> {
    if (!storedUrl) {
      return '';
    }

    if (!storedUrl.startsWith('http')) {
      // If it's a relative path like "bucket/path"
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

  private async resolveStorageUrls(
    storedUrls?: Array<string | null> | string | null,
  ): Promise<string[]> {
    const urls = Array.isArray(storedUrls)
      ? storedUrls
      : typeof storedUrls === 'string' && storedUrls.trim()
        ? [storedUrls]
        : [];

    return Promise.all(
      urls
        .filter(
          (url): url is string =>
            typeof url === 'string' && url.trim().length > 0,
        )
        .map((url) => this.resolveStorageUrl(url)),
    );
  }
}
