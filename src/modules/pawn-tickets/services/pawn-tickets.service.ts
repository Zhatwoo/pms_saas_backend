import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import {
  requireUserBranchId,
  effectiveBranchIdForQuery,
} from '../../../common/utils/branch-scope.util';
import { CreatePawnTicketDto } from '../dto/create-pawn-ticket.dto';
import { adjustDailyBalance } from '../../../common/utils/daily-balance.util';
import { getPhCalendarDateString } from '../../../common/utils/branch-calendar-date.util';

import { NotificationsService } from '../../notifications/services/notifications.service';

@Injectable()
export class PawnTicketsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly notificationsService: NotificationsService,
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

    return message.includes("Could not find the 'item_photos' column of 'pawned_items' in the schema cache")
      || message.includes("column 'item_photos' does not exist");
  }

  private throwMissingMigrationError() {
    throw new InternalServerErrorException(
      'Database schema is incomplete for pawn tickets. Apply migrations PMS_backend/supabase/migrations/009_create_customers_and_pawn_ticket_relations.sql, PMS_backend/supabase/migrations/018_add_item_photo_to_pawned_items.sql, and PMS_backend/supabase/migrations/020_add_item_photos_to_pawned_items.sql, then refresh the Supabase schema cache.',
    );
  }

  private generateTransactionNo() {
    return `PAWN-${Date.now()}`;
  }

  private generateItemId(unitCode?: string) {
    const value = unitCode?.trim();
    if (value && !value.startsWith('PENDING')) {
      return value.toUpperCase();
    }
    return `PWN-${Date.now()}`;
  }

  private getTodayDateKey() {
    return getPhCalendarDateString();
  }

  private formatSupabaseError(error: unknown): string {
    if (error == null) {
      return 'Unknown database error';
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
    if (typeof error !== 'object') {
      return String(error);
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

  private async generateNextSerialNumberForBranch(branchId: string) {
    const client = this.supabase.getClient();

    const { data: branch, error: branchError } = await client
      .from('branches')
      .select('branch_code')
      .eq('id', branchId)
      .single();

    if (branchError || !branch) {
      throw new InternalServerErrorException(
        branchError?.message || 'Branch code not found',
      );
    }

    const serialDate = this.getTodayDateKey();
    const branchCode = (branch as { branch_code?: string | null }).branch_code;

    if (!branchCode) {
      throw new InternalServerErrorException('Branch code not found');
    }

    const serialPrefix = this.buildSerialPrefix(branchCode);

    const { data: items, error: itemsError } = await client
      .from('pawned_items')
      .select('serial_number')
      .eq('branch_id', branchId)
      .ilike('serial_number', `${serialPrefix}%`)
      .order('serial_number', { ascending: false })
      .limit(100);

    if (itemsError) {
      throw new InternalServerErrorException(itemsError.message);
    }

    let maxNumber = 0;
    const typedItems = (items ?? []) as Array<{ serial_number: string | null }>;

    for (const item of typedItems) {
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
    const client = this.supabase.getClient();
    const branchId = effectiveBranchIdForQuery(user, query.branch);

    let dbQuery = client
      .from('pawned_items')
      .select(
        'id, item_name, item_id, serial_number, amount, pawn_date, status, branch_id, customer_id',
      )
      .order('pawn_date', { ascending: false })
      .limit(500);

    if (branchId) {
      dbQuery = dbQuery.eq('branch_id', branchId);
    }
    if (query.status) {
      dbQuery = dbQuery.eq('status', query.status);
    }

    const { data, error } = await dbQuery;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    let items = (data ?? []) as Array<{
      id: string;
      item_name: string | null;
      item_id: string | null;
      serial_number: string | null;
      amount: number | string | null;
      pawn_date: string | null;
      status: string | null;
      branch_id: string | null;
      customer_id: string | null;
    }>;

    const customerIds = Array.from(
      new Set(items.map((i) => i.customer_id).filter((id): id is string => Boolean(id))),
    );
    const branchIds = Array.from(
      new Set(items.map((i) => i.branch_id).filter((id): id is string => Boolean(id))),
    );

    let customerMap = new Map<
      string,
      { id: string; full_name: string | null; contact_number: string | null }
    >();
    let branchMap = new Map<string, { name: string | null }>();

    if (customerIds.length > 0) {
      const { data: customerRows, error: customerError } = await client
        .from('customers')
        .select('id, full_name, contact_number')
        .in('id', customerIds);
      if (customerError) {
        throw new InternalServerErrorException(customerError.message);
      }
      customerMap = new Map(
        (customerRows ?? []).map((row: any) => [
          row.id,
          {
            id: row.id,
            full_name: row.full_name ?? null,
            contact_number: row.contact_number ?? null,
          },
        ]),
      );
    }

    if (branchIds.length > 0) {
      const { data: branchRows, error: branchError } = await client
        .from('branches')
        .select('id, name')
        .in('id', branchIds);
      if (branchError) {
        throw new InternalServerErrorException(branchError.message);
      }
      branchMap = new Map(
        (branchRows ?? []).map((row: any) => [row.id, { name: row.name ?? null }]),
      );
    }

    let normalized = items.map((item) => ({
      ...item,
      unit_code: item.item_id ?? null,
      customer: item.customer_id ? customerMap.get(item.customer_id) ?? null : null,
      branch: item.branch_id ? branchMap.get(item.branch_id) ?? null : null,
    }));

    if (query.search) {
      const q = query.search.toLowerCase();
      normalized = normalized.filter((item) =>
        (item.item_name ?? '').toLowerCase().includes(q) ||
        (item.item_id ?? '').toLowerCase().includes(q) ||
        (item.serial_number ?? '').toLowerCase().includes(q) ||
        (item.customer?.full_name ?? '').toLowerCase().includes(q),
      );
    }

    return normalized;
  }

  async create(user: AuthenticatedUserProfile, dto: CreatePawnTicketDto) {
    const client = this.supabase.getClient();
    const branchId =
      user.role === Role.SUPER_ADMIN
        ? (dto.branchId ?? requireUserBranchId(user))
        : requireUserBranchId(user);
    const branchName = dto.branchName ?? user.branchName ?? 'Unknown Branch';
    const providedSerialNumber = dto.item.serialNumber?.trim();
    const serialNumber =
      providedSerialNumber && !providedSerialNumber.startsWith('PENDING')
        ? providedSerialNumber
        : await this.generateNextSerialNumberForBranch(branchId);

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
        this.buildUploadPath('id-front'),
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
        this.buildUploadPath('id-front'),
        'id_pictures',
      );

      idBackPhotoUrl = await this.uploadPhoto(
        dto.item.idBackPhoto,
        this.buildUploadPath('id-back'),
        'id_pictures',
      );
    }

    const rawItemPhotos = Array.isArray(dto.item.itemPhotos) && dto.item.itemPhotos.length > 0
      ? dto.item.itemPhotos
      : [];

    const itemPhotoInputs = rawItemPhotos.filter(
      (photo): photo is string => typeof photo === 'string' && photo.trim().length > 0,
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

    let customer: { id: string } | null = null;

    if (dto.customerId) {
      const { data: existingCustomer, error: customerLookupError } =
        await client
          .from('customers')
          .select('*')
          .eq('id', dto.customerId)
          .eq('branch_id', branchId)
          .single();

      if (customerLookupError || !existingCustomer) {
        throw new BadRequestException(
          'Selected customer was not found for the active branch.',
        );
      }

      customer = existingCustomer;
    } else {
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
      };

      const { data: createdCustomer, error: customerError } = await client
        .from('customers')
        .insert([customerPayload])
        .select()
        .single();

      if (customerError) {
        if (this.isPawnTicketMigrationMissing(customerError)) {
          this.throwMissingMigrationError();
        }
        throw new InternalServerErrorException(
          this.formatSupabaseError(customerError),
        );
      }

      customer = createdCustomer;
    }

    const itemPayload = {
      item_id: this.generateItemId(dto.item.unitCode),
      item_name: dto.item.unitName.trim(),
      category: dto.item.category?.trim() || 'Miscellaneous',
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
      customer_id: customer!.id,
      amount: dto.transaction.pawnAmount ?? 0,
    };

    const insertPawnedItem = async (payload: Record<string, unknown>) => {
      const { data, error } = await client
        .from('pawned_items')
        .insert([payload])
        .select()
        .single();

      return { data, error };
    };

    let { data: pawnedItem, error: pawnedError } = await insertPawnedItem(itemPayload);

    if (pawnedError && this.isItemPhotosSchemaCacheError(pawnedError)) {
      ({ data: pawnedItem, error: pawnedError } = await insertPawnedItem({
        ...itemPayload,
        item_photos: undefined,
      }));
    }

    if (pawnedError) {
      if (this.isPawnTicketMigrationMissing(pawnedError)) {
        this.throwMissingMigrationError();
      }
      throw new InternalServerErrorException(
        this.formatSupabaseError(pawnedError),
      );
    }

    const transactionPayload = {
      transaction_no: this.generateTransactionNo(),
      branch_id: branchId,
      branch: branchName,
      purpose: 'Pawn',
      transaction_date:
        dto.transaction.transactionDate || getPhCalendarDateString(),
      transaction_time: dto.transaction.transactionTime || new Date().toTimeString().slice(0, 8),
      // Pawn disbursement is a cash outflow from branch to customer.
      cash_in: 0,
      cash_out: dto.transaction.pawnAmount ?? 0,
      return_amount: dto.transaction.returnAmount ?? 0,
      unit: dto.item.unitName.trim(),
      unit_code: dto.item.unitCode?.trim() ?? null,
      pawn_amount: dto.transaction.pawnAmount ?? 0,
      storage_fee: dto.transaction.storageFee ?? 0,
      details: dto.transaction.details?.trim() ?? null,
      related_pawned_item_id: pawnedItem.id,
      created_by_user_id: user.id,
      profile_photo: profilePhotoUrl,
      id_photo: idPhotoUrl,
      id_back_photo: idBackPhotoUrl,
    };

    const { data: transaction, error: transactionError } = await client
      .from('transactions')
      .insert([transactionPayload])
      .select()
      .single();

    if (transactionError) {
      throw new InternalServerErrorException(
        this.formatSupabaseError(transactionError),
      );
    }

    // 3b. Adjust daily balance for this pawn cash outflow
    const pawnCashIn = Number(transactionPayload.cash_in ?? 0);
    const pawnCashOut = Number(transactionPayload.cash_out ?? 0);
    const netChange = pawnCashIn - pawnCashOut;
    if (netChange !== 0) {
      try {
        await adjustDailyBalance(client, branchId, netChange);
      } catch (e) {
        console.error(
          '[PawnTicketsService] adjustDailyBalance failed after pawn create',
          { branchId, netChange, transactionNo: transactionPayload.transaction_no },
          e,
        );
        throw e instanceof InternalServerErrorException
          ? e
          : new InternalServerErrorException(
              e instanceof Error ? e.message : this.formatSupabaseError(e),
            );
      }
    }

    // 4. Create Notification
    try {
      await this.notificationsService.create({
        title: `New pawn transaction created - ${transactionPayload.transaction_no}`,
        subtitle: `Transaction Alert: new pawn [${dto.item.unitName}]`,
        category: 'Transactions',
        branch_id: branchId,
      });
    } catch (e) {
      console.warn('[PawnTicketsService] Failed to create notification', e);
    }

    return {
      customer,
      pawnedItem,
      transaction,
    };
  }

  async generateNextUnitCode(user: AuthenticatedUserProfile) {
    const client = this.supabase.getClient();
    const branchId = requireUserBranchId(user);

    // 1. Get branch code
    const { data: branch, error: branchError } = await client
      .from('branches')
      .select('branch_code')
      .eq('id', branchId)
      .single();

    if (branchError || !branch) {
      throw new InternalServerErrorException(
        branchError?.message || 'Branch code not found',
      );
    }

    // 2. Get the highest numeric sequence for this branch's pattern
    // Pattern: [branchCode]-jclb-%
    const branchCode = (branch as { branch_code: string }).branch_code;
    const pattern = `${branchCode}-jclb-%`;

    const { data: items, error: itemsError } = await client
      .from('pawned_items')
      .select('item_id')
      .eq('branch_id', branchId)
      .ilike('item_id', pattern)
      .order('item_id', { ascending: false })
      .limit(100);

    if (itemsError) {
      throw new InternalServerErrorException(itemsError.message);
    }

    let maxNumber = 0;

    if (items && items.length > 0) {
      items.forEach((item) => {
        const parts = item.item_id.split('-');
        if (parts.length === 3) {
          const numPart = parseInt(parts[2], 10);
          if (!isNaN(numPart) && numPart > maxNumber) {
            maxNumber = numPart;
          }
        }
      });
    }

    const nextNumber = maxNumber + 1;
    const formattedNumber = String(nextNumber).padStart(5, '0');

    return {
      unitCode: `${branch.branch_code}-jclb-${formattedNumber}`,
    };
  }

  async generateNextSerialNumber(user: AuthenticatedUserProfile) {
    const branchId = requireUserBranchId(user);
    const serialNumber = await this.generateNextSerialNumberForBranch(branchId);

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

    const { data, error } = await client.storage
      .from(bucket)
      .upload(path, buf, {
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

  async findByUnitCode(unitCode: string) {
    const client = this.supabase.getClient();
    const cleanCode = unitCode.trim().toUpperCase();

    const { data: item, error: itemError } = await client
      .from('pawned_items')
      .select('*, customer:customers(*), branch_info:branches(*)')
      .eq('item_id', cleanCode)
      .maybeSingle();

    if (itemError || !item) {
      throw new BadRequestException('Item not found or unit code is invalid.');
    }

    // Resolve storage URLs for photos
    const [profilePhoto, itemPhotos, idPhoto, idBackPhoto] = await Promise.all([
      this.resolveStorageUrl(item.profile_photo),
      this.resolveStorageUrls(item.item_photos ?? []),
      this.resolveStorageUrl(item.id_photo),
      this.resolveStorageUrl(item.id_back_photo),
    ]);

    return {
      ...item,
      profile_photo: profilePhoto,
      item_photos: itemPhotos,
      id_photo: idPhoto,
      id_back_photo: idBackPhoto,
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
      
      const { data } = await this.supabase
        .getClient()
        .storage.from(bucket)
        .createSignedUrl(path, 60 * 60 * 24 * 7);
        
      return data?.signedUrl || storedUrl;
    }

    try {
      const parsedUrl = new URL(storedUrl);
      const storagePrefix = '/storage/v1/object/public/';

      if (!parsedUrl.pathname.includes(storagePrefix)) {
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
        .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
        .map((url) => this.resolveStorageUrl(url)),
    );
  }
}
