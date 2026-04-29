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
import { adjustDailyBalance } from '../../../common/utils/daily-balance.util';

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

  private nextDay(date: string): string {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  private async adjustBalance(branchId: string, delta: number): Promise<void> {
    await adjustDailyBalance(this.supabase.getClient(), branchId, delta);
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
      .select('*, customers(*), item_renewals(*)', { count: 'exact' })
      .order('created_at', { ascending: false });

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
    }
    if (filters.search) {
      query = query.or(
        `item_name.ilike.%${filters.search}%,item_id.ilike.%${filters.search}%,serial_number.ilike.%${filters.search}%`,
      );
    }

    if (filters.date) {
      // Support both plain date "YYYY-MM-DD" and timestamp columns
      query = query.gte('pawn_date', filters.date).lt('pawn_date', this.nextDay(filters.date));
    }

    const from = (filters.page - 1) * filters.limit;
    query = query.range(from, from + filters.limit - 1);

    const { data, error, count } = await query;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      items: await Promise.all(
        (data || []).map(async (item: any) => ({
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
          customers: item.customers,
          serialNumber: item.serial_number,
          itemsIncluded: item.items_included,
          condition: item.condition,
          memoryStorage: item.memory_storage,
        })),
      ),
      total: count || 0,
    };
  }

  async findPawnedCategories(user: UserWithBranch, branch?: string, date?: string): Promise<{ category: string; count: number }[]> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client
      .from('pawned_items')
      .select('category');

    if (branchId) {
      query = query.eq('branch_id', branchId);
    } else if (branchNameIlike) {
      query = query.ilike('branch', `%${branchNameIlike}%`);
    }

    if (date) {
      // Support both plain date "YYYY-MM-DD" and timestamp columns
      query = query.gte('pawn_date', `${date}`).lt('pawn_date', this.nextDay(date));
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

  async findPawnedCalendar(user: UserWithBranch, branch?: string, month?: string): Promise<Record<string, number>> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client
      .from('pawned_items')
      .select('pawn_date');

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

  async findOnePawned(user: UserWithBranch, id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('pawned_items')
      .select('*, item_renewals(*), customer:customers(*)')
      .eq('id', id)
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

    return {
      ...data,
      profile_photo: profilePhoto,
      item_photos: itemPhotos,
      id_photo: idPhoto,
      id_back_photo: idBackPhoto,
      renewalCount: (data.item_renewals || []).length,
      renewals: (data.item_renewals || []).map((r: any) => ({
        date: r.renewal_date,
        amount: r.amount_paid,
      })),
    };
  }

  async findByItemId(user: UserWithBranch, itemId: string) {
    const client = this.supabase.getClient();
    const cleanId = itemId.trim().toUpperCase();

    const scopedBranchId =
      user.role === Role.SUPER_ADMIN ? null : requireUserBranchId(user);

    // 1. Try Pawned Items
    let pawnedQuery = client
      .from('pawned_items')
      .select('*, item_renewals(*)')
      .ilike('item_id', cleanId);

    if (scopedBranchId) {
      pawnedQuery = pawnedQuery.eq('branch_id', scopedBranchId);
    }

    const { data: pawnedRows, error: pawnedError } = await pawnedQuery.limit(1);
    const pawnedData = Array.isArray(pawnedRows) ? pawnedRows[0] : null;

    if (pawnedError) {
      console.error(
        `[InventoryService] Error fetching pawned item ${cleanId}:`,
        pawnedError,
      );
    }

    if (pawnedData) {
      assertResourceBranch(user, pawnedData.branch_id);

      let customerData: {
        full_name: string;
        address: string;
        barangay?: string | null;
        city?: string | null;
        region?: string | null;
        contact_number?: string | null;
        id_presented?: string | null;
      } | null = null;

      if (pawnedData.customer_id) {
        const { data: customer, error: customerError } = await client
          .from('customers')
          .select(
            'full_name, address, barangay, city, region, contact_number, id_presented',
          )
          .eq('id', pawnedData.customer_id)
          .maybeSingle();

        if (customerError) {
          console.error(
            `[InventoryService] Error fetching customer for pawned item ${cleanId}:`,
            customerError,
          );
        } else {
          customerData = customer;
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

    // 2. Try Sale Items
    let saleQuery = client
      .from('sale_items')
      .select('*')
      .ilike('item_id', cleanId);

    if (scopedBranchId) {
      saleQuery = saleQuery.eq('branch_id', scopedBranchId);
    }

    const { data: saleRows, error: saleError } = await saleQuery.limit(1);
    const saleData = Array.isArray(saleRows) ? saleRows[0] : null;

    if (saleError) {
      console.error(
        `[InventoryService] Error fetching sale item ${cleanId}:`,
        saleError,
      );
    }

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
    const { error } = await client.from('pawned_items').delete().eq('id', id);
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
      .insert([{ pawned_item_id: itemId, ...dto }])
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
        .maybeSingle();

    if (existingSaleItemError) {
      throw new InternalServerErrorException(existingSaleItemError.message);
    }

    if (existingSaleItem) {
      if (pawnedItem.status !== 'Expired') {
        const { error: syncStatusError } = await client
          .from('pawned_items')
          .update({ status: 'Expired' })
          .eq('id', itemId);

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
      .eq('id', itemId);
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
      .eq('id', requestId);

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
  ) {
    const branchId = String(branchIdParam);
    assertResourceBranch(user, branchId);

    const client = this.supabase.getClient();

    const { data: systemItems, error } = await client
      .from('pawned_items')
      .select('item_id, item_name, category')
      .eq('branch_id', branchId)
      .eq('status', 'Active');
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const normalizeId = (value: string) => value.trim().toUpperCase();

    const systemItemList = Array.from(
      (systemItems || [])
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

  async findAllForSale(user: UserWithBranch, filters: QueryFilters) {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(
      user,
      filters.branch,
    );

    let query = client
      .from('sale_items')
      .select('*', { count: 'exact' })
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
      query = query.gte('available_date', filters.date).lt('available_date', this.nextDay(filters.date));
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

  async findForSaleStats(user: UserWithBranch, branch?: string): Promise<{
    totalAvailable: number;
    totalSold: number;
    unpricedCount: number;
    soldThisMonth: number;
    revenueThisMonth: number;
  }> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client.from('sale_items').select('status, price, available_date');
    if (branchId) query = query.eq('branch_id', branchId);
    else if (branchNameIlike) query = query.ilike('branch', `%${branchNameIlike}%`);

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let totalAvailable = 0, totalSold = 0, unpricedCount = 0, soldThisMonth = 0, revenueThisMonth = 0;
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
    return { totalAvailable, totalSold, unpricedCount, soldThisMonth, revenueThisMonth };
  }

  async findForSaleCategories(user: UserWithBranch, branch?: string): Promise<{ category: string; count: number }[]> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client.from('sale_items').select('category');
    if (branchId) query = query.eq('branch_id', branchId);
    else if (branchNameIlike) query = query.ilike('branch', `%${branchNameIlike}%`);

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    const counts: Record<string, number> = {};
    for (const row of data || []) {
      const cat = (row.category || 'Uncategorized').trim();
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return Object.entries(counts).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
  }

  async findForSaleCalendar(user: UserWithBranch, branch?: string, month?: string): Promise<Record<string, { available: number; sold: number }>> {
    const client = this.supabase.getClient();
    const { branchId, branchNameIlike } = inventoryBranchFilters(user, branch);

    let query = client.from('sale_items').select('available_date, status');
    if (branchId) query = query.eq('branch_id', branchId);
    else if (branchNameIlike) query = query.ilike('branch', `%${branchNameIlike}%`);

    if (month) {
      const [y, m] = month.split('-').map(Number);
      const firstDay = `${month}-01`;
      const lastDay = new Date(y, m, 0).toISOString().split('T')[0];
      query = query.gte('available_date', firstDay).lte('available_date', lastDay);
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
      .update({ status: 'Sold', price: soldPrice })
      .eq('id', itemId);
    if (updateErr) {
      throw new InternalServerErrorException(updateErr.message);
    }

    // Create a transactions row so ledger, reports, and dashboard all see this sale.
    const today = new Date().toISOString().split('T')[0];
    const { error: txErr } = await client.from('transactions').insert([{
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
    }]);
    if (txErr) {
      console.error('[InventoryService] Failed to create sale transaction', txErr);
    }

    await adjustDailyBalance(client, branchId, soldPrice);

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
      .select()
      .single();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
  }

  async deleteForSale(user: UserWithBranch, id: string) {
    await this.findOneForSale(user, id);
    const client = this.supabase.getClient();
    const { error } = await client.from('sale_items').delete().eq('id', id);
    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return { message: 'Item deleted' };
  }
}
