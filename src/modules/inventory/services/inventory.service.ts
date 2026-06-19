import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { Role } from '../../../common/enums';
import { NotificationsService } from '../../notifications/services/notifications.service';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import {
  assertResourceBranch,
  inventoryBranchFilters,
  requireUserBranchId,
} from '../../../common/utils/branch-scope.util';
import { getPhCalendarDateString } from '../../../common/utils/branch-calendar-date.util';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { FinanceDailyBalanceService } from '../../branch-finance/services/finance-daily-balance.service';
import {
  INVENTORY_VALUATION_STATUSES,
  isStatusIncludedInInventoryValuation,
  findInterestRateGroup,
} from '../../../common/utils/inventory-valuation.util';
import {
  environmentCreateFields,
  getEnvironment,
} from '../../../common/utils/authorization.util';

interface QueryFilters {
  branch?: string;
  category?: string;
  status?: string;
  search?: string;
  viewMode?: string;
  date?: string; // ISO date string YYYY-MM-DD for single-day filter
  page: number;
  limit: number;
}

@Injectable()
export class InventoryService {
  constructor(
    private supabase: SupabaseService,
    private notificationsService: NotificationsService,
    private readonly encryption: EncryptionService,
    private readonly financeDailyBalance: FinanceDailyBalanceService,
  ) {}

  private async resolveStorageUrl(storedUrl?: string | null): Promise<string> {
    if (!storedUrl) {
      return '';
    }

    if (!storedUrl.startsWith('http')) {
      return storedUrl;
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

  private nextDay(date: string): string {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  /** Routes inventory-driven cash deltas through the unified daily balance writer (Manila date). */
  private async adjustBalance(branchId: string, delta: number): Promise<void> {
    await this.financeDailyBalance.applyNetChange(
      branchId,
      getPhCalendarDateString(),
      delta,
    );
  }

  // ═══════════════════════════════════════════════════════════
  // PAWNED ITEMS
  // ═══════════════════════════════════════════════════════════

  async findAllPawned(user: UserWithBranch, filters: QueryFilters) {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(
      user,
      filters.branch,
    );

    let query = client
      .from('pawned_items')
      .select('*, customers(*), item_renewals(*)');
    query = query.eq('environment', getEnvironment(user));

    if (branchId) {
      query = query.eq('branch_id', branchId);
    } else if (branchNameIlike) {
      query = query.ilike('branch', `%${branchNameIlike}%`);
    }

    if (filters.category) {
      query = query.ilike('category', `%${filters.category}%`);
    }
    if (filters.status) {
      query = query.eq('status', filters.status);
    } else {
      query = query.neq('status', 'Expired');
    }
    if (filters.search) {
      query = query.or(
        `item_name.ilike.%${filters.search}%,item_id.ilike.%${filters.search}%,serial_number.ilike.%${filters.search}%`,
      );
    }

    if (filters.date) {
      // Support both plain date "YYYY-MM-DD" and timestamp columns
      query = query
        .gte('pawn_date', filters.date)
        .lt('pawn_date', this.nextDay(filters.date));
    }

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const { data: interestRatesData } = await client
      .from('shop_settings')
      .select('setting_value')
      .eq('setting_key', 'interest_rates')
      .eq('environment', getEnvironment(user))
      .maybeSingle();
    const interestRates = (interestRatesData?.setting_value as any[]) || [];
    const today = new Date();

    const filteredItems = (data || []).filter((item: any) => {
      if (item.status !== 'Active') {
        return true;
      }
      if (!item.pawn_date) {
        return true;
      }
      const category = item.category;
      const group = findInterestRateGroup(interestRates, category);
      const defaultDuration = group ? (group.defaultDuration ?? 30) : 30;

      const maturityDate = new Date(item.pawn_date);
      maturityDate.setDate(maturityDate.getDate() + defaultDuration);

      const daysRemaining = Math.ceil(
        (maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );

      return daysRemaining > 0;
    });

    // Order by created_at descending in memory
    filteredItems.sort((a: any, b: any) => {
      const dateA = new Date(a.created_at || 0).getTime();
      const dateB = new Date(b.created_at || 0).getTime();
      return dateB - dateA;
    });

    const totalCount = filteredItems.length;
    const from = (filters.page - 1) * filters.limit;
    const paginatedItems = filteredItems.slice(from, from + filters.limit);

    return {
      items: await Promise.all(
        paginatedItems.map(async (item: any) => ({
          id: item.id,
          itemId: item.item_id,
          itemName: item.item_name,
          category: item.category,
          branch: item.branch,
          pawnDate: item.pawn_date,
          status: item.status,
          renewalCount: (item.item_renewals || []).length,
          renewals: (item.item_renewals || []).map((r: any) => ({
            date: r.renewal_date,
            amount: r.amount_paid,
          })),
          remarks: item.remarks || '',
          qrCode: item.qr_code || '',
          originalPhoto: await this.resolveStorageUrl(item.profile_photo),
          itemPhotos: await this.resolveStorageUrls(item.item_photos),
          conditionReport: item.condition_report || '',
          amount: item.amount || 0,
          customers: item.customers
            ? this.encryption.decryptCustomerEmbed(
                item.customers as Record<string, unknown>,
              )
            : item.customers,
          serialNumber: item.serial_number,
          itemsIncluded: item.items_included,
          condition: item.condition,
          memoryStorage: item.memory_storage,
        })),
      ),
      total: totalCount,
    };
  }

  async findPawnedCategories(
    user: UserWithBranch,
    branch?: string,
    date?: string,
  ): Promise<{ category: string; count: number }[]> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client
      .from('pawned_items')
      .select('category')
      .eq('environment', getEnvironment(user));

    if (branchId) {
      query = query.eq('branch_id', branchId);
    } else if (branchNameIlike) {
      query = query.ilike('branch', `%${branchNameIlike}%`);
    }

    if (date) {
      // Support both plain date "YYYY-MM-DD" and timestamp columns
      query = query
        .gte('pawn_date', `${date}`)
        .lt('pawn_date', this.nextDay(date));
    }

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    const counts: Record<string, number> = {};
    for (const row of data || []) {
      const cat = (row.category || 'Uncategorized').trim();
      counts[cat] = (counts[cat] || 0) + 1;
    }

    return Object.entries(counts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }

  async findPawnedCalendar(
    user: UserWithBranch,
    branch?: string,
    month?: string,
  ): Promise<Record<string, number>> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client
      .from('pawned_items')
      .select('pawn_date')
      .eq('environment', getEnvironment(user));

    if (branchId) {
      query = query.eq('branch_id', branchId);
    } else if (branchNameIlike) {
      query = query.ilike('branch', `%${branchNameIlike}%`);
    }

    if (month) {
      // month = YYYY-MM, filter pawn_date >= first day and <= last day
      const [y, m] = month.split('-').map(Number);
      const firstDay = `${month}-01`;
      const lastDay = new Date(y, m, 0).toISOString().split('T')[0];
      query = query.gte('pawn_date', firstDay).lte('pawn_date', lastDay);
    }

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    const counts: Record<string, number> = {};
    for (const row of data || []) {
      if (row.pawn_date) {
        // Normalize to YYYY-MM-DD in case column is a timestamp
        const dateKey = String(row.pawn_date).slice(0, 10);
        counts[dateKey] = (counts[dateKey] || 0) + 1;
      }
    }
    return counts;
  }

  async createPawned(user: UserWithBranch, dto: any) {
    const client = this.supabase.getClient();
    const payload =
      user.role === Role.SUPER_ADMIN
        ? { ...dto }
        : {
            ...dto,
            branch_id: requireUserBranchId(user),
          };
    Object.assign(payload, environmentCreateFields(user));
    const { data, error } = await client
      .from('pawned_items')
      .insert([payload])
      .select()
      .single();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
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

  async findOnePawned(user: UserWithBranch, id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('pawned_items')
      .select('*, item_renewals(*), customer:customers(*), transactions(*, users!transactions_created_by_user_id_fkey(id, full_name))')
      .eq('id', id)
      .eq('environment', getEnvironment(user))
      .single();

    if (error) {
      throw new NotFoundException('Item not found');
    }
    assertResourceBranch(user, data?.branch_id);

    // Resolve storage URLs for photos
    const [profilePhoto, itemPhotos, idPhoto, idBackPhoto] = await Promise.all([
      this.resolveStorageUrl(data.profile_photo),
      this.resolveStorageUrls(data.item_photos ?? []),
      this.resolveStorageUrl(data.id_photo),
      this.resolveStorageUrl(data.id_back_photo),
    ]);

    const pawnTx = (data.transactions || []).find((t: any) => t.purpose === 'Pawn');
    const createdByUser = pawnTx?.users ? this.encryption.decryptUsersJoin(pawnTx.users) : null;
    const processorName = createdByUser ? this.decryptUserDisplayName(createdByUser.full_name) : null;

    return {
      ...data,
      customer: data.customer
        ? this.encryption.decryptCustomerEmbed(
            data.customer as Record<string, unknown>,
          )
        : data.customer,
      profile_photo: profilePhoto,
      item_photos: itemPhotos,
      id_photo: idPhoto,
      id_back_photo: idBackPhoto,
      renewalCount: (data.item_renewals || []).length,
      renewals: (data.item_renewals || []).map((r: any) => ({
        date: r.renewal_date,
        amount: r.amount_paid,
      })),
      created_by_user: processorName ? { full_name: processorName } : null,
    };
  }

  async findByItemId(user: UserWithBranch, itemId: string) {
    const client = this.supabase.getClient();
    const cleanId = itemId.trim().toUpperCase();

    const scopedBranchId =
      user.role === Role.SUPER_ADMIN ? null : requireUserBranchId(user);

    // Resolve the live inventory row first. A stale pawned row can remain in the
    // table after a buy-back/redeem flow, so prefer the current Available sale row
    // when the same item ID exists in both places.
    let pawnedQuery = client
      .from('pawned_items')
      .select('*, item_renewals(*)')
      .ilike('item_id', cleanId)
      .eq('environment', getEnvironment(user))
      .in('status', ['Active', 'Expired', 'Inventory'])
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false });

    if (scopedBranchId) {
      pawnedQuery = pawnedQuery.eq('branch_id', scopedBranchId);
    }

    let saleQuery = client
      .from('sale_items')
      .select('*')
      .ilike('item_id', cleanId)
      .eq('environment', getEnvironment(user))
      .in('status', ['Available', 'available'])
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false });

    if (scopedBranchId) {
      saleQuery = saleQuery.eq('branch_id', scopedBranchId);
    }

    const [pawnedResult, saleResult] = await Promise.all([
      pawnedQuery.limit(1),
      saleQuery.limit(1),
    ]);

    const { data: pawnedRows, error: pawnedError } = pawnedResult;
    const pawnedData = Array.isArray(pawnedRows) ? pawnedRows[0] : null;
    const { data: saleRows, error: saleError } = saleResult;
    const saleData = Array.isArray(saleRows) ? saleRows[0] : null;

    if (pawnedError) {
      console.error(
        `[InventoryService] Error fetching pawned item ${cleanId}:`,
        pawnedError,
      );
    }

    if (saleError) {
      console.error(
        `[InventoryService] Error fetching sale item ${cleanId}:`,
        saleError,
      );
    }

    const pawnedStatus = String(pawnedData?.status || '').trim();
    const pawnedIsCurrentInventory = isStatusIncludedInInventoryValuation(pawnedStatus);

    if (saleData) {
      assertResourceBranch(user, saleData.branch_id);
      const originalPhoto = await this.resolveStorageUrl(saleData.image_url);

      return {
        id: saleData.id,
        itemId: saleData.item_id,
        itemName: saleData.item_name,
        category: saleData.category,
        branch: saleData.branch,
        pawnDate: saleData.available_date,
        status: saleData.status,
        originalPhoto,
        type: 'SALE',
      };
    }

    if (pawnedData && pawnedIsCurrentInventory) {
      assertResourceBranch(user, pawnedData.branch_id);

      type CustomerSnapshot = {
        full_name: string;
        address: string;
        barangay?: string | null;
        city?: string | null;
        region?: string | null;
        contact_number?: string | null;
        id_presented?: string | null;
      };

      let customerData: CustomerSnapshot | null = null;

      if (pawnedData.customer_id) {
        const { data: customer, error: customerError } = await client
          .from('customers')
          .select(
            'full_name, address, barangay, city, region, contact_number, id_presented',
          )
          .eq('id', pawnedData.customer_id)
          .eq('environment', getEnvironment(user))
          .maybeSingle();

        if (customerError) {
          console.error(
            `[InventoryService] Error fetching customer for pawned item ${cleanId}:`,
            customerError,
          );
        } else if (customer) {
          customerData = this.encryption.decryptCustomerRow(customer);
        }
      }

      const [originalPhoto, itemPhotos, ownerIdPhoto, ownerIdBackPhoto] =
        await Promise.all([
          this.resolveStorageUrl(pawnedData.profile_photo),
          this.resolveStorageUrls(pawnedData.item_photos ?? []),
          this.resolveStorageUrl(pawnedData.id_photo),
          this.resolveStorageUrl(pawnedData.id_back_photo),
        ]);

      return {
        id: pawnedData.id,
        itemId: pawnedData.item_id,
        itemName: pawnedData.item_name,
        serialNumber: pawnedData.serial_number,
        category: pawnedData.category,
        branch: pawnedData.branch,
        pawnDate: pawnedData.pawn_date,
        status: pawnedData.status,
        amount: pawnedData.amount ?? 0,
        originalPhoto,
        itemPhotos,
        ownerIdPhoto,
        ownerIdBackPhoto,
        customerName: customerData?.full_name || '',
        customerAddress: customerData
          ? [
              customerData.address,
              customerData.barangay,
              customerData.city,
              customerData.region,
            ]
              .filter(Boolean)
              .join(', ')
          : '',
        customerContact: customerData?.contact_number || '',
        customerIdPresented: customerData?.id_presented || '',
        type: 'PAWNED',
      };
    }

    throw new NotFoundException(
      `Item ID "${cleanId}" not found in branch inventory. Please verify the ID or contact admin.`,
    );
  }

  async updatePawned(user: UserWithBranch, id: string, dto: any) {
    await this.findOnePawned(user, id);
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('pawned_items')
      .update(dto)
      .eq('id', id)
      .eq('environment', getEnvironment(user))
      .select()
      .single();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async deletePawned(user: UserWithBranch, id: string) {
    await this.findOnePawned(user, id);
    const client = this.supabase.getClient();
    const { error } = await client
      .from('pawned_items')
      .delete()
      .eq('id', id)
      .eq('environment', getEnvironment(user));
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return { message: 'Item deleted' };
  }

  async addRenewal(
    user: UserWithBranch,
    itemId: string,
    dto: { renewal_date: string; amount_paid: number },
  ) {
    await this.findOnePawned(user, itemId);
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('item_renewals')
      .insert([{ pawned_item_id: itemId, ...dto, ...environmentCreateFields(user) }])
      .select()
      .single();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async addRemark(user: UserWithBranch, itemId: string, remark: string) {
    await this.findOnePawned(user, itemId);
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('pawned_items')
      .update({ remarks: remark })
      .eq('id', itemId)
      .eq('environment', getEnvironment(user))
      .select()
      .single();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async expireAndTransfer(user: UserWithBranch, itemId: string) {
    const client = this.supabase.getClient();

    const { data: pawnedItem, error: fetchErr } = await client
      .from('pawned_items')
      .select('*')
      .eq('id', itemId)
      .eq('environment', getEnvironment(user))
      .single();
    if (fetchErr || !pawnedItem) {
      throw new NotFoundException('Pawned item not found');
    }
    assertResourceBranch(user, pawnedItem.branch_id);

    const { data: existingSaleItem, error: existingSaleItemError } =
      await client
        .from('sale_items')
        .select('*')
        .eq('original_pawn_id', pawnedItem.id)
        .eq('environment', getEnvironment(user))
        .maybeSingle();

    if (existingSaleItemError) {
      throw new InternalServerErrorException(existingSaleItemError.message);
    }

    if (existingSaleItem) {
      if (pawnedItem.status !== 'Expired') {
        const { error: syncStatusError } = await client
          .from('pawned_items')
          .update({ status: 'Expired' })
          .eq('id', itemId)
          .eq('environment', getEnvironment(user));

        if (syncStatusError) {
          throw new InternalServerErrorException(syncStatusError.message);
        }
      }

      return {
        message: 'Item was already transferred to Items for Sale',
        saleItem: existingSaleItem,
      };
    }

    const { error: updateErr } = await client
      .from('pawned_items')
      .update({ status: 'Expired' })
      .eq('id', itemId)
      .eq('environment', getEnvironment(user));
    if (updateErr) {
      throw new InternalServerErrorException(updateErr.message);
    }

    const saleItemId =
      typeof pawnedItem.item_id === 'string' &&
      pawnedItem.item_id.trim().length > 0
        ? pawnedItem.item_id.trim()
        : `PAWN-${String(pawnedItem.id).slice(0, 8).toUpperCase()}`;

    const { data: saleItem, error: insertErr } = await client
      .from('sale_items')
      .insert([
        {
          item_id: saleItemId,
          item_name: pawnedItem.item_name,
          category: pawnedItem.category,
          branch: pawnedItem.branch,
          branch_id: pawnedItem.branch_id,
          available_date: new Date().toISOString().split('T')[0],
          price: 0,
          status: 'Available',
          original_pawn_id: pawnedItem.id,
          ...environmentCreateFields(user),
        },
      ])
      .select()
      .single();
    if (insertErr) {
      if (/duplicate|unique/i.test(insertErr.message)) {
        throw new ConflictException(
          'Item was already transferred to Items for Sale',
        );
      }
      throw new InternalServerErrorException(insertErr.message);
    }

    // 4. Create Notification
    try {
      await this.notificationsService.create({
        title: `${pawnedItem.item_name} - Item already expired`,
        subtitle: `Transaction Alert: expired pawn item [${pawnedItem.item_id}]`,
        category: 'Alerts',
        branch_id: pawnedItem.branch_id,
        event_key: `inventory-expired:${pawnedItem.id}`,
        entity_type: 'pawn_item',
        entity_id: pawnedItem.item_id,
        environment: getEnvironment(user),
        created_by: user.authId,
      });
    } catch (e) {
      console.warn('[InventoryService] Failed to create notification', e);
    }

    return {
      message: 'Item expired and transferred to Items for Sale',
      saleItem,
    };
  }

  async requestExpireApproval(
    user: UserWithBranch & { id: string },
    itemId: string,
    message?: string,
  ) {
    const client = this.supabase.getClient();
    const trimmedMessage = message?.trim() ?? '';

    if (!trimmedMessage) {
      throw new BadRequestException('Approval message is required');
    }

    if (trimmedMessage.length > 500) {
      throw new BadRequestException('Approval message is too long');
    }

    const { data: pawnedItem, error: fetchErr } = await client
      .from('pawned_items')
      .select('id, item_id, item_name, branch, branch_id, status')
      .eq('id', itemId)
      .eq('environment', getEnvironment(user))
      .single();

    if (fetchErr || !pawnedItem) {
      throw new NotFoundException('Pawned item not found');
    }

    assertResourceBranch(user, pawnedItem.branch_id);

    if (pawnedItem.status === 'Expired') {
      throw new BadRequestException(
        'Item is already expired and no longer needs approval',
      );
    }

    const { error: logError } = await client.from('activity_logs').insert({
      user_id: user.id,
      branch_id: pawnedItem.branch_id,
      action: 'PAWN_ITEM_EXPIRE_REQUEST',
      ...environmentCreateFields(user),
      details: JSON.stringify({
        itemId: pawnedItem.item_id,
        itemName: pawnedItem.item_name,
        pawnedItemId: pawnedItem.id,
        branch: pawnedItem.branch,
        requestedByRole: user.role,
        message: trimmedMessage,
        requestStatus: 'pending',
        requestedAt: new Date().toISOString(),
      }),
    });

    if (logError) {
      throw new InternalServerErrorException(logError.message);
    }

    return {
      message: 'Expire request sent to super admin for approval',
    };
  }

  async reviewExpireApproval(
    user: UserWithBranch & { id: string },
    itemId: string,
    requestId: string,
    decision?: 'approve' | 'reject',
    note?: string,
  ) {
    const client = this.supabase.getClient();
    const normalizedDecision = decision?.trim().toLowerCase();

    if (normalizedDecision !== 'approve' && normalizedDecision !== 'reject') {
      throw new BadRequestException(
        'Decision must be either approve or reject',
      );
    }

    const trimmedNote = note?.trim() ?? '';
    if (trimmedNote.length > 500) {
      throw new BadRequestException('Review note is too long');
    }

    const { data: requestLog, error: requestLogError } = await client
      .from('activity_logs')
      .select('id, action, details')
      .eq('id', requestId)
      .eq('environment', getEnvironment(user))
      .maybeSingle();

    if (requestLogError) {
      throw new InternalServerErrorException(requestLogError.message);
    }

    if (!requestLog) {
      throw new NotFoundException('Expire request not found');
    }

    if (requestLog.action !== 'PAWN_ITEM_EXPIRE_REQUEST') {
      throw new BadRequestException('Expire request was already reviewed');
    }

    let parsedDetails: Record<string, unknown> = {};
    if (typeof requestLog.details === 'string' && requestLog.details.trim()) {
      try {
        parsedDetails = JSON.parse(requestLog.details) as Record<
          string,
          unknown
        >;
      } catch {
        parsedDetails = {};
      }
    }

    const requestItemId =
      typeof parsedDetails.pawnedItemId === 'string'
        ? parsedDetails.pawnedItemId
        : null;

    if (requestItemId && requestItemId !== itemId) {
      throw new BadRequestException(
        'Request does not belong to this pawned item',
      );
    }

    const requestStatus =
      typeof parsedDetails.requestStatus === 'string'
        ? parsedDetails.requestStatus.toLowerCase()
        : 'pending';

    if (requestStatus !== 'pending') {
      throw new ConflictException('Expire request was already reviewed');
    }

    if (normalizedDecision === 'approve') {
      await this.expireAndTransfer(user, itemId);
    }

    const reviewedAt = new Date().toISOString();
    const reviewedAction =
      normalizedDecision === 'approve'
        ? 'PAWN_ITEM_EXPIRE_REQUEST_APPROVED'
        : 'PAWN_ITEM_EXPIRE_REQUEST_REJECTED';

    const reviewDetails = {
      ...parsedDetails,
      requestStatus: normalizedDecision === 'approve' ? 'approved' : 'rejected',
      reviewedAt,
      reviewedByUserId: user.id,
      reviewedByRole: user.role,
      reviewNote: trimmedNote || null,
    };

    const { error: updateErr } = await client
      .from('activity_logs')
      .update({
        action: reviewedAction,
        details: JSON.stringify(reviewDetails),
      })
      .eq('id', requestId)
      .eq('environment', getEnvironment(user));

    if (updateErr) {
      throw new InternalServerErrorException(updateErr.message);
    }

    return {
      message:
        normalizedDecision === 'approve'
          ? 'Expire request approved and item moved to Items for Sale'
          : 'Expire request rejected',
      status: normalizedDecision,
    };
  }

  async qrTally(
    user: UserWithBranch,
    branchIdParam: string | number,
    scannedItemIds: string[],
    checklistSource: 'pawned' | 'sale' | null = null,
  ) {
    const branchId = String(branchIdParam);
    assertResourceBranch(user, branchId);

    const client = this.supabase.getClient();

    let systemItemListSource:
      | Array<{ item_id?: string | null; item_name?: string | null; category?: string | null; status?: string | null }>
      = [];

    if (checklistSource === 'sale') {
      const { data: saleItems, error: saleError } = await client
        .from('sale_items')
        .select('item_id, item_name, category')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .in('status', ['Available', 'available']);
      if (saleError) {
        throw new InternalServerErrorException(saleError.message);
      }

      systemItemListSource = Array.isArray(saleItems) ? saleItems : [];
    } else if (checklistSource === 'pawned') {
      const { data: pawnedItems, error: pawnedError } = await client
        .from('pawned_items')
        .select('item_id, item_name, category, status')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .in('status', INVENTORY_VALUATION_STATUSES as unknown as string[]);
      if (pawnedError) {
        throw new InternalServerErrorException(pawnedError.message);
      }

      const { data: redeemedRows, error: redeemedError } = await client
        .from('transactions')
        .select('related_pawned_item_id')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .in('purpose', ['Redeem', 'Buy Back']);
      if (redeemedError) {
        throw new InternalServerErrorException(redeemedError.message);
      }

      const redeemedPawnedIds = new Set(
        (Array.isArray(redeemedRows) ? redeemedRows : [])
          .map((row: { related_pawned_item_id?: string | null }) => row.related_pawned_item_id)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      );

      systemItemListSource = (Array.isArray(pawnedItems) ? pawnedItems : []).filter(
        (item: { item_id?: string | null; status?: string | null }) =>
          isStatusIncludedInInventoryValuation(item.status) &&
          typeof item.item_id === 'string' &&
          item.item_id.trim().length > 0 &&
          !redeemedPawnedIds.has(item.item_id),
      );
    } else {
      const { data: pawnedItems, error: pawnedError } = await client
        .from('pawned_items')
        .select('item_id, item_name, category, status')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .in('status', INVENTORY_VALUATION_STATUSES as unknown as string[]);
      if (pawnedError) {
        throw new InternalServerErrorException(pawnedError.message);
      }

      const { data: redeemedRows, error: redeemedError } = await client
        .from('transactions')
        .select('related_pawned_item_id')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .in('purpose', ['Redeem', 'Buy Back']);
      if (redeemedError) {
        throw new InternalServerErrorException(redeemedError.message);
      }

      const redeemedPawnedIds = new Set(
        (Array.isArray(redeemedRows) ? redeemedRows : [])
          .map((row: { related_pawned_item_id?: string | null }) => row.related_pawned_item_id)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      );

      const { data: saleItems, error: saleError } = await client
        .from('sale_items')
        .select('item_id, item_name, category')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .in('status', ['Available', 'available']);
      if (saleError) {
        throw new InternalServerErrorException(saleError.message);
      }

      systemItemListSource = [
        ...((Array.isArray(pawnedItems) ? pawnedItems : []).filter(
          (item: { item_id?: string | null; status?: string | null }) =>
            isStatusIncludedInInventoryValuation(item.status) &&
            typeof item.item_id === 'string' &&
            item.item_id.trim().length > 0 &&
            !redeemedPawnedIds.has(item.item_id),
        )),
        ...(Array.isArray(saleItems) ? saleItems : []),
      ];
    }

    const normalizeId = (value: string) => value.trim().toUpperCase();

    const systemItemList = Array.from(
      (systemItemListSource || [])
        .filter(
          (item: any) =>
            typeof item?.item_id === 'string' && item.item_id.trim().length > 0,
        )
        .reduce((map, item: any) => {
          const normalizedId = normalizeId(item.item_id);
          if (!map.has(normalizedId)) {
            map.set(normalizedId, {
              itemId: normalizedId,
              itemName: item.item_name || item.item_id,
              category: item.category || 'Uncategorized',
            });
          }
          return map;
        }, new Map<string, { itemId: string; itemName: string; category: string }>())
        .values(),
    );

    const systemIds = systemItemList.map((item) => item.itemId);

    const normalizedScannedIds = Array.from(
      new Set(
        scannedItemIds
          .filter(
            (value): value is string =>
              typeof value === 'string' && value.trim().length > 0,
          )
          .map(normalizeId),
      ),
    );

    const missingInVault = systemIds.filter(
      (id: string) => !normalizedScannedIds.includes(id),
    );
    const missingItems = systemItemList.filter((item) =>
      missingInVault.includes(item.itemId),
    );
    const extraInVault = normalizedScannedIds.filter(
      (id) => !systemIds.includes(id),
    );

    return {
      totalInSystem: systemIds.length,
      totalScanned: normalizedScannedIds.length,
      matched: normalizedScannedIds.filter((id) => systemIds.includes(id))
        .length,
      missingInVault,
      missingItems,
      extraInVault,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // ITEMS FOR SALE
  // ═══════════════════════════════════════════════════════════

  private async uploadPhoto(
    base64: string,
    path: string,
    bucket: string,
  ): Promise<string> {
    const client = this.supabase.getClient();
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
        `Photo upload failed: ${error.message}`,
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

  async createForSale(user: UserWithBranch, dto: any) {
    const client = this.supabase.getClient();

    // Ensure branch_id is set
    let branchId = dto.branch_id;
    if (!branchId && user.role !== Role.SUPER_ADMIN) {
      branchId = requireUserBranchId(user);
    }

    if (!branchId) {
      throw new BadRequestException('Branch ID is required');
    }

    // Check branch name if not provided
    let branchName = dto.branch;
    if (!branchName) {
      const { data: branchData } = await client
        .from('branches')
        .select('name')
        .eq('id', branchId)
        .eq('environment', getEnvironment(user))
        .single();
      branchName = branchData?.name || 'Unknown';
    }

    let imageUrl = dto.image_url;
    if (imageUrl && imageUrl.startsWith('data:image')) {
      const path = `sales_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
      imageUrl = await this.uploadPhoto(imageUrl, path, 'pawned_items');
    }

    const { data, error } = await client
      .from('sale_items')
      .insert([
        {
          item_id: dto.item_id || `SALE-${Date.now()}`,
          item_name: dto.item_name,
          category: dto.category,
          branch: branchName,
          branch_id: branchId,
          available_date: new Date().toISOString().split('T')[0],
          price: dto.price || 0,
          status: dto.status || 'Available',
          image_url: imageUrl || null,
          ...environmentCreateFields(user),
        },
      ])
      .select()
      .single();

    if (error) {
      console.error('SUPABASE INSERT ERROR:', error);
      require('fs').appendFileSync(
        'supabase-error.log',
        JSON.stringify(error) + '\n',
      );
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async findAllForSale(user: UserWithBranch, filters: QueryFilters) {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(
      user,
      filters.branch,
    );

    let query = client
      .from('sale_items')
      .select('*', { count: 'exact' })
      .eq('environment', getEnvironment(user))
      .order('created_at', { ascending: false });

    if (branchId) {
      query = query.eq('branch_id', branchId);
    } else if (branchNameIlike) {
      query = query.ilike('branch', `%${branchNameIlike}%`);
    }

    if (filters.category) {
      query = query.ilike('category', `%${filters.category}%`);
    }
    if (filters.search) {
      query = query.ilike('item_name', `%${filters.search}%`);
    }

    if (filters.viewMode === 'history') {
      query = query.eq('status', 'Sold');
    } else if (!filters.status || filters.status === 'all') {
      // No status filter — show all
    } else {
      query = query.eq('status', filters.status);
    }

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.date) {
      query = query
        .gte('available_date', filters.date)
        .lt('available_date', this.nextDay(filters.date));
    }

    const from = (filters.page - 1) * filters.limit;
    query = query.range(from, from + filters.limit - 1);

    const { data, error, count } = await query;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      items: (data || []).map((item: any) => ({
        id: item.id,
        itemId: item.item_id,
        itemName: item.item_name,
        category: item.category,
        branch: item.branch,
        availableDate: item.available_date,
        price: item.price,
        stockLevel: item.stock_level || 1,
        status: item.status || 'Available',
        originalPawnId: item.original_pawn_id || null,
      })),
      total: count || 0,
    };
  }

  async findForSaleStats(
    user: UserWithBranch,
    branch?: string,
  ): Promise<{
    totalAvailable: number;
    totalSold: number;
    unpricedCount: number;
    soldThisMonth: number;
    revenueThisMonth: number;
  }> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client
      .from('sale_items')
      .select('status, price, available_date')
      .eq('environment', getEnvironment(user));
    if (branchId) query = query.eq('branch_id', branchId);
    else if (branchNameIlike)
      query = query.ilike('branch', `%${branchNameIlike}%`);

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let totalAvailable = 0,
      totalSold = 0,
      unpricedCount = 0,
      soldThisMonth = 0,
      revenueThisMonth = 0;
    for (const row of data || []) {
      if (row.status === 'Available') {
        totalAvailable++;
        if (!row.price || row.price === 0) unpricedCount++;
      } else if (row.status === 'Sold') {
        totalSold++;
        const dateKey = String(row.available_date || '').slice(0, 7);
        if (dateKey === monthPrefix) {
          soldThisMonth++;
          revenueThisMonth += Number(row.price) || 0;
        }
      }
    }
    return {
      totalAvailable,
      totalSold,
      unpricedCount,
      soldThisMonth,
      revenueThisMonth,
    };
  }

  async findPublicForSale(): Promise<{
    items: Array<{
      id: string;
      itemId: string;
      itemName: string;
      category: string;
      branch: string;
      branchLocation: string;
      availableDate: string;
      price: number;
      status: string;
      imageUrl: string;
    }>;
    total: number;
  }> {
    const client = this.supabase.getClient();

    const [saleResult, branchResult] = await Promise.all([
      client
        .from('sale_items')
        .select(
          'id, item_id, item_name, category, branch, branch_id, available_date, price, status, image_url, created_at',
        )
        .eq('environment', 'production')
        .eq('status', 'Available')
        .gt('price', 0)
        .order('created_at', { ascending: false }),
      client
        .from('branches')
        .select('id, name, location')
        .eq('environment', 'production'),
    ]);

    if (saleResult.error) {
      throw new InternalServerErrorException(saleResult.error.message);
    }

    if (branchResult.error) {
      throw new InternalServerErrorException(branchResult.error.message);
    }

    const branchLookup = new Map<string, { name: string; location: string }>();
    for (const branch of branchResult.data || []) {
      branchLookup.set(String(branch.id), {
        name: branch.name || 'Branch',
        location: branch.location || '',
      });
    }

    const items = await Promise.all(
      (saleResult.data || []).map(async (item: any) => {
        const branchInfo = branchLookup.get(String(item.branch_id));
        const imageUrl = await this.resolveStorageUrl(item.image_url);

        return {
          id: item.id,
          itemId: item.item_id,
          itemName: item.item_name,
          category: item.category,
          branch: branchInfo?.name || item.branch || 'Branch',
          branchLocation: branchInfo?.location || '',
          availableDate: item.available_date,
          price: Number(item.price || 0),
          status: item.status || 'Available',
          imageUrl,
        };
      }),
    );

    return {
      items,
      total: items.length,
    };
  }

  async findForSaleCategories(
    user: UserWithBranch,
    branch?: string,
  ): Promise<{ category: string; count: number }[]> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client
      .from('sale_items')
      .select('category')
      .eq('environment', getEnvironment(user));
    if (branchId) query = query.eq('branch_id', branchId);
    else if (branchNameIlike)
      query = query.ilike('branch', `%${branchNameIlike}%`);

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    const counts: Record<string, number> = {};
    for (const row of data || []) {
      const cat = (row.category || 'Uncategorized').trim();
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }

  async findForSaleCalendar(
    user: UserWithBranch,
    branch?: string,
    month?: string,
  ): Promise<Record<string, { available: number; sold: number }>> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client
      .from('sale_items')
      .select('available_date, status')
      .eq('environment', getEnvironment(user));
    if (branchId) query = query.eq('branch_id', branchId);
    else if (branchNameIlike)
      query = query.ilike('branch', `%${branchNameIlike}%`);

    if (month) {
      const [y, m] = month.split('-').map(Number);
      const firstDay = `${month}-01`;
      const lastDay = new Date(y, m, 0).toISOString().split('T')[0];
      query = query
        .gte('available_date', firstDay)
        .lte('available_date', lastDay);
    }

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    const result: Record<string, { available: number; sold: number }> = {};
    for (const row of data || []) {
      if (!row.available_date) continue;
      const dateKey = String(row.available_date).slice(0, 10);
      if (!result[dateKey]) result[dateKey] = { available: 0, sold: 0 };
      if (row.status === 'Sold') result[dateKey].sold++;
      else result[dateKey].available++;
    }
    return result;
  }

  async markSoldAndAddToBalance(
    user: UserWithBranch,
    itemId: string,
    soldPrice: number,
    branchIdParam: string | number,
    customerId?: string,
  ) {
    const item = await this.findOneForSale(user, itemId);

    if (item.status === 'Sold') {
      return {
        message: 'Item was already marked as sold',
      };
    }

    const branchId = String(item.branch_id ?? branchIdParam);
    assertResourceBranch(user, branchId);

    const client = this.supabase.getClient();

    const { error: updateErr } = await client
      .from('sale_items')
      .update({
        status: 'Sold',
        price: soldPrice,
        customer_id: customerId || null,
      })
      .eq('id', itemId)
      .eq('environment', getEnvironment(user));
    if (updateErr) {
      throw new InternalServerErrorException(updateErr.message);
    }

    // Create a transactions row so ledger, reports, and dashboard all see this sale.
    const today = getPhCalendarDateString();
    const { error: txErr } = await client.from('transactions').insert([
      {
        transaction_no: `SELL-${Date.now()}`,
        branch_id: branchId,
        branch: item.branch ?? 'Unknown',
        purpose: 'Sold Item',
        transaction_date: today,
        transaction_time: new Date().toTimeString().slice(0, 8),
        cash_in: soldPrice,
        cash_out: 0,
        unit: item.item_name ?? null,
        unit_code: item.item_id ?? null,
        details: `Item sold: ${item.item_name ?? 'Unknown'} for ₱${soldPrice.toLocaleString()}`,
        related_sale_item_id: itemId,
        customer_id: customerId || null,
        ...environmentCreateFields(user),
      },
    ]);
    if (txErr) {
      console.error(
        '[InventoryService] Failed to create sale transaction',
        txErr,
      );
    }

    await this.financeDailyBalance.applyNetChange(
      branchId,
      getPhCalendarDateString(),
      soldPrice,
    );

    return {
      message: 'Item marked as sold, amount added to branch balance',
    };
  }

  async findOneForSale(user: UserWithBranch, id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('sale_items')
      .select('*')
      .eq('id', id)
      .eq('environment', getEnvironment(user))
      .single();
    if (error) {
      throw new NotFoundException('Item not found');
    }
    assertResourceBranch(user, data?.branch_id);
    return data;
  }

  async updateForSale(user: UserWithBranch, id: string, dto: any) {
    await this.findOneForSale(user, id);
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('sale_items')
      .update(dto)
      .eq('id', id)
      .eq('environment', getEnvironment(user))
      .select()
      .single();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async requestQrReplacement(
    user: UserWithBranch & { id: string },
    itemId: string,
    reason: 'Damaged' | 'Lost' | 'Torn',
    message?: string,
    proofPhoto?: string,
  ) {
    const client = this.supabase.getClient();
    const { data: pawnedItem, error: fetchErr } = await client
      .from('pawned_items')
      .select('id, item_id, item_name, branch, branch_id')
      .eq('id', itemId)
      .eq('environment', getEnvironment(user))
      .single();

    if (fetchErr || !pawnedItem) {
      throw new NotFoundException('Pawned item not found');
    }

    assertResourceBranch(user, pawnedItem.branch_id);

    const { error: logError } = await client.from('activity_logs').insert({
      user_id: user.id,
      branch_id: pawnedItem.branch_id,
      action: 'QR_REPLACEMENT_REQUEST',
      ...environmentCreateFields(user),
      details: JSON.stringify({
        itemId: pawnedItem.item_id,
        itemName: pawnedItem.item_name,
        pawnedItemId: pawnedItem.id,
        branch: pawnedItem.branch,
        requestedByRole: user.role,
        reason,
        proofPhoto: proofPhoto || null,
        message:
          message ||
          `Replacement requested due to sticker being ${reason.toLowerCase()}.`,
        requestStatus: 'pending',
        requestedAt: new Date().toISOString(),
      }),
    });

    if (logError) {
      throw new InternalServerErrorException(logError.message);
    }

    return {
      message: 'QR replacement request sent to super admin for approval',
    };
  }

  async reviewQrReplacement(
    user: UserWithBranch & { id: string },
    requestId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ) {
    const client = this.supabase.getClient();

    const { data: requestLog, error: requestLogError } = await client
      .from('activity_logs')
      .select('*')
      .eq('id', requestId)
      .eq('environment', getEnvironment(user))
      .single();

    if (requestLogError || !requestLog) {
      throw new NotFoundException('Replacement request not found');
    }

    const parsedDetails = JSON.parse(requestLog.details || '{}');
    if (parsedDetails.requestStatus !== 'pending') {
      throw new ConflictException('Request already processed');
    }

    const reviewedAction =
      decision === 'approve'
        ? 'QR_REPLACEMENT_APPROVED'
        : 'QR_REPLACEMENT_REJECTED';

    const updatedDetails = {
      ...parsedDetails,
      requestStatus: decision === 'approve' ? 'approved' : 'rejected',
      reviewedAt: new Date().toISOString(),
      reviewedByUserId: user.id,
      reviewNote: note || '',
    };

    const { error: updateErr } = await client
      .from('activity_logs')
      .update({
        action: reviewedAction,
        details: JSON.stringify(updatedDetails),
      })
      .eq('id', requestId)
      .eq('environment', getEnvironment(user));

    if (updateErr) {
      throw new InternalServerErrorException(updateErr.message);
    }

    return {
      message: `QR replacement request ${decision}ed successfully`,
    };
  }

  async deleteForSale(user: UserWithBranch, id: string) {
    await this.findOneForSale(user, id);
    const client = this.supabase.getClient();
    const { error } = await client
      .from('sale_items')
      .delete()
      .eq('id', id)
      .eq('environment', getEnvironment(user));
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return { message: 'Item deleted' };
  }
}
