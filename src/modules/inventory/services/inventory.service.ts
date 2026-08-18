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
import {
  getPhCalendarDateString,
  getPhWallClockTimeString,
} from '../../../common/utils/branch-calendar-date.util';
import * as fs from 'fs';
import { EncryptionService } from '../../../common/encryption/encryption.service';
import { FinanceDailyBalanceService } from '../../branch-finance/services/finance-daily-balance.service';
import {
  INVENTORY_VALUATION_STATUSES,
  isStatusIncludedInInventoryValuation,
  findInterestRateGroup,
  normalizeInterestRates,
  isPawnItemWithinOpeningAuditWindow,
  getPawnMaturityDaysRemaining,
  OPENING_AUDIT_PAWN_WINDOW_DAYS,
} from '../../../common/utils/inventory-valuation.util';
import type { InterestRateGroup } from '../../../common/utils/inventory-valuation.util';
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

/**
 * Row shapes below mirror the Postgres tables as returned over the
 * Supabase/PostgREST client (numbers/strings/plain JSON — NOT Prisma.Decimal),
 * which is why they are declared locally instead of importing the Prisma
 * model types (those model numeric columns as Prisma.Decimal).
 */

export interface ItemRenewalRow {
  id: string;
  pawned_item_id: string;
  renewal_date: string;
  amount_paid: number;
  created_at?: string;
  updated_at?: string;
}

export interface PawnedItemRow {
  id: string;
  item_id: string;
  item_name: string;
  category: string;
  branch_id: string;
  branch: string;
  pawn_date: string | null;
  status: string;
  remarks?: string | null;
  qr_code?: string | null;
  condition_report?: string | null;
  created_at?: string;
  updated_at?: string;
  customer_id?: string | null;
  profile_photo?: string | null;
  id_photo?: string | null;
  id_back_photo?: string | null;
  amount?: number | null;
  serial_number?: string | null;
  items_included?: string | null;
  condition?: string | null;
  memory_storage?: string | null;
  item_photos?: Array<string | null> | string | null;
  interest_rate_snapshot?: unknown;
  customers?: Record<string, unknown> | null;
  item_renewals?: ItemRenewalRow[] | null;
  transactions?: TransactionWithUserRow[] | null;
}

export interface SaleItemRow {
  id: string;
  item_id: string;
  item_name: string;
  category: string;
  branch_id: string;
  branch: string;
  available_date?: string | null;
  price?: number | null;
  stock_level?: number | null;
  status: string;
  original_pawn_id?: string | null;
  image_url?: string | null;
  customer_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface TransferItemRow {
  id: string;
  sale_item_id: string;
  item_id: string;
  item_name: string;
  source_branch_id: string;
  target_branch_id: string;
  status: string;
  item_included?: string | null;
  notes?: string | null;
  requested_at?: string | null;
  received_at?: string | null;
}

interface BranchNameRow {
  id: string;
  name: string;
}

interface CustomerContactRow {
  full_name: string;
  address: string;
  barangay?: string | null;
  city?: string | null;
  region?: string | null;
  contact_number?: string | null;
  id_presented?: string | null;
  [key: string]: unknown;
}

export interface TransactionWithUserRow {
  id?: string;
  purpose?: string | null;
  users?: {
    id?: string;
    full_name?: string | null;
    email?: string | null;
  } | null;
}

interface ActivityLogRow {
  id: string;
  action: string;
  details: string | null;
}

/** Client-submitted payload for creating/updating a pawned item (loosely validated at the edge). */
interface PawnedItemWriteDto {
  branch_id?: string;
  [key: string]: unknown;
}

/** Client-submitted payload for creating/updating a sale item (loosely validated at the edge). */
interface SaleItemWriteDto {
  branch_id?: string;
  branch?: string;
  item_id?: string;
  item_name?: string;
  category?: string;
  price?: number;
  status?: string;
  image_url?: string;
  [key: string]: unknown;
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
    if (!storedUrl || typeof storedUrl !== 'string' || !storedUrl.trim()) {
      return '';
    }

    const trimmed = storedUrl.trim();

    if (!trimmed.startsWith('http')) {
      const parts = trimmed.split('/');
      let bucket = 'items_for_sale';
      let path = trimmed;

      if (parts.length >= 2) {
        bucket = parts[0];
        path = parts.slice(1).join('/');
      }

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

        if (pubData?.publicUrl) return pubData.publicUrl;
      } catch {
        // fallback
      }

      if (bucket === 'items_for_sale' || parts.length < 2) {
        try {
          const { data: fallbackData } = await this.supabase
            .getClient()
            .storage.from('pawned_items')
            .createSignedUrl(path, 60 * 60 * 24 * 7);
          if (fallbackData?.signedUrl) return fallbackData.signedUrl;

          const { data: pubFallback } = this.supabase
            .getClient()
            .storage.from('pawned_items')
            .getPublicUrl(path);
          if (pubFallback?.publicUrl) return pubFallback.publicUrl;
        } catch {
          // ignore
        }
      }

      return trimmed;
    }

    try {
      const parsedUrl = new URL(trimmed);
      const publicPrefix = '/storage/v1/object/public/';
      const signedPrefix = '/storage/v1/object/sign/';

      const storagePrefix = parsedUrl.pathname.includes(publicPrefix)
        ? publicPrefix
        : parsedUrl.pathname.includes(signedPrefix)
          ? signedPrefix
          : null;

      if (!storagePrefix) {
        return trimmed;
      }

      const storagePath = parsedUrl.pathname.split(storagePrefix)[1];
      if (!storagePath) {
        return trimmed;
      }

      const [bucketName, ...objectPathParts] = storagePath.split('/');
      const objectPath = objectPathParts.join('/');

      if (!bucketName || !objectPath) {
        return trimmed;
      }

      const { data, error } = await this.supabase
        .getClient()
        .storage.from(bucketName)
        .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

      if (error || !data?.signedUrl) {
        const { data: pubData } = this.supabase
          .getClient()
          .storage.from(bucketName)
          .getPublicUrl(objectPath);
        return pubData?.publicUrl || trimmed;
      }

      return data.signedUrl;
    } catch {
      return trimmed;
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

  private async loadInterestRates(
    user: UserWithBranch,
  ): Promise<InterestRateGroup[]> {
    const { data } = await this.supabase
      .getClient()
      .from('shop_settings')
      .select('setting_value')
      .eq('setting_key', 'interest_rates')
      .eq('environment', getEnvironment(user))
      .maybeSingle();

    return normalizeInterestRates(data?.setting_value);
  }

  private async buildOpeningAuditSystemItems(
    user: UserWithBranch,
    branchId: string,
  ): Promise<
    Array<{
      item_id: string;
      item_name: string;
      category: string;
      source: 'pawned' | 'sale';
      status: string;
      daysLeft?: number | null;
    }>
  > {
    const client = this.supabase.getClient();
    const interestRates = await this.loadInterestRates(user);

    const [pawnedResult, saleResult, pendingTransfersResult] =
      await Promise.all([
        client
          .from('pawned_items')
          .select('id, item_id, item_name, category, status, pawn_date')
          .eq('branch_id', branchId)
          .eq('environment', getEnvironment(user))
          .eq('status', 'Active'),
        client
          .from('sale_items')
          .select('id, item_id, item_name, category, status')
          .eq('branch_id', branchId)
          .eq('environment', getEnvironment(user))
          .in('status', ['Available', 'available']),
        client
          .from('transfer_items')
          .select('sale_item_id')
          .eq('source_branch_id', branchId)
          .eq('status', 'pending')
          .eq('environment', getEnvironment(user)),
      ]);

    if (pawnedResult.error) {
      throw new InternalServerErrorException(pawnedResult.error.message);
    }
    if (saleResult.error) {
      throw new InternalServerErrorException(saleResult.error.message);
    }
    if (pendingTransfersResult.error) {
      throw new InternalServerErrorException(
        pendingTransfersResult.error.message,
      );
    }

    const pendingTransferSaleIds = new Set(
      (Array.isArray(pendingTransfersResult.data)
        ? pendingTransfersResult.data
        : []
      ).map((row: { sale_item_id?: string | null }) => row.sale_item_id),
    );

    const pawnedItems = (
      Array.isArray(pawnedResult.data) ? pawnedResult.data : []
    ).filter(
      (item: {
        item_id?: string | null;
        pawn_date?: string | null;
        category?: string | null;
      }) =>
        typeof item.item_id === 'string' &&
        item.item_id.trim().length > 0 &&
        isPawnItemWithinOpeningAuditWindow(
          item.pawn_date,
          item.category,
          interestRates,
        ),
    );

    const saleItems = (Array.isArray(saleResult.data) ? saleResult.data : [])
      .filter(
        (item: { id?: string | null; item_id?: string | null }) =>
          typeof item.item_id === 'string' &&
          item.item_id.trim().length > 0 &&
          !pendingTransferSaleIds.has(item.id ?? ''),
      )
      .map(
        (item: {
          item_id: string;
          item_name: string;
          category: string;
          status?: string | null;
        }) => ({
          item_id: item.item_id,
          item_name: item.item_name,
          category: item.category,
          source: 'sale' as const,
          status: item.status || 'Available',
        }),
      );

    return [
      ...pawnedItems.map(
        (item: {
          item_id: string;
          item_name: string;
          category: string;
          status?: string | null;
          pawn_date?: string | null;
        }) => ({
          item_id: item.item_id,
          item_name: item.item_name,
          category: item.category,
          source: 'pawned' as const,
          status: item.status || 'Active',
          daysLeft: getPawnMaturityDaysRemaining(
            item.pawn_date,
            item.category,
            interestRates,
          ),
        }),
      ),
      ...saleItems,
    ];
  }

  async findOpeningAuditChecklist(user: UserWithBranch, branch?: string) {
    const { branchId } = inventoryBranchFilters(user, branch);
    if (!branchId) {
      throw new BadRequestException(
        'A single branch is required for opening audit',
      );
    }

    assertResourceBranch(user, branchId);
    const items = await this.buildOpeningAuditSystemItems(user, branchId);

    const uniqueItems = Array.from(
      items
        .reduce(
          (map, item) => {
            const normalizedId = item.item_id.trim().toUpperCase();
            if (!map.has(normalizedId)) {
              map.set(normalizedId, {
                itemId: normalizedId,
                itemName: item.item_name,
                category: item.category,
                status: item.status,
                source: item.source,
                daysLeft: item.daysLeft,
              });
            }
            return map;
          },
          new Map<
            string,
            {
              itemId: string;
              itemName: string;
              category: string;
              status: string;
              source: 'pawned' | 'sale';
              daysLeft?: number | null;
            }
          >(),
        )
        .values(),
    );

    return { items: uniqueItems };
  }

  private isItemEligibleForOpeningAudit(
    item: {
      type?: string;
      status?: string | null;
      pawnDate?: string | null;
      category?: string | null;
    },
    interestRates: InterestRateGroup[],
  ): boolean {
    const normalizedStatus = String(item.status || '')
      .trim()
      .toLowerCase();

    if (item.type === 'SALE' || normalizedStatus === 'available') {
      return normalizedStatus === 'available';
    }

    if (item.type === 'PAWNED' || normalizedStatus === 'active') {
      return (
        normalizedStatus === 'active' &&
        isPawnItemWithinOpeningAuditWindow(
          item.pawnDate,
          item.category,
          interestRates,
        )
      );
    }

    return false;
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

    const { data, error } = await query.returns<PawnedItemRow[]>();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const { data: interestRatesData } = await client
      .from('shop_settings')
      .select('setting_value')
      .eq('setting_key', 'interest_rates')
      .eq('environment', getEnvironment(user))
      .maybeSingle();
    const interestRates = normalizeInterestRates(
      interestRatesData?.setting_value,
    );
    const today = new Date();

    const filteredItems = (data || []).filter((item: PawnedItemRow) => {
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
    filteredItems.sort((a: PawnedItemRow, b: PawnedItemRow) => {
      const dateA = new Date(a.created_at || 0).getTime();
      const dateB = new Date(b.created_at || 0).getTime();
      return dateB - dateA;
    });

    const totalCount = filteredItems.length;
    const from = (filters.page - 1) * filters.limit;
    const paginatedItems = filteredItems.slice(from, from + filters.limit);

    return {
      items: await Promise.all(
        paginatedItems.map(async (item: PawnedItemRow) => {
          const category = item.category;
          const group = findInterestRateGroup(interestRates, category);
          const defaultDuration = group ? (group.defaultDuration ?? 30) : 30;
          const graceDuration = group
            ? Number(
                (group as { gracePeriodDuration?: number })
                  .gracePeriodDuration ?? 4,
              )
            : 4;

          const renewals = (item.item_renewals || []).map(
            (r: ItemRenewalRow) => ({
              date: r.renewal_date,
              amount: r.amount_paid,
            }),
          );
          const lastRenewalDate = renewals
            .map((r) => r.date)
            .filter(Boolean)
            .sort()
            .at(-1);

          const baseDateRaw = lastRenewalDate || item.pawn_date;
          let maturityDate: string | null = null;
          let expirationDate: string | null = null;
          if (baseDateRaw) {
            const maturity = new Date(baseDateRaw);
            if (!Number.isNaN(maturity.getTime())) {
              maturity.setDate(maturity.getDate() + defaultDuration);
              maturityDate = maturity.toISOString().slice(0, 10);
              const expiry = new Date(maturity);
              expiry.setDate(expiry.getDate() + graceDuration);
              expirationDate = expiry.toISOString().slice(0, 10);
            }
          }

          return {
            id: item.id,
            itemId: item.item_id,
            itemName: item.item_name,
            category: item.category,
            branch: item.branch,
            pawnDate: item.pawn_date,
            maturityDate,
            expirationDate,
            status: item.status,
            renewalCount: renewals.length,
            renewals,
            remarks: item.remarks || '',
            qrCode: item.qr_code || '',
            originalPhoto: await this.resolveStorageUrl(item.profile_photo),
            itemPhotos: await this.resolveStorageUrls(item.item_photos),
            conditionReport: item.condition_report || '',
            amount: item.amount || 0,
            customers: item.customers
              ? this.encryption.decryptCustomerEmbed(item.customers)
              : item.customers,
            serialNumber: item.serial_number,
            itemsIncluded: item.items_included,
            condition: item.condition,
            memoryStorage: item.memory_storage,
            interestRateSnapshot: item.interest_rate_snapshot ?? null,
          };
        }),
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

    const { data, error } =
      await query.returns<Array<Pick<PawnedItemRow, 'category'>>>();
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

  async createPawned(user: UserWithBranch, dto: PawnedItemWriteDto) {
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
      .returns<PawnedItemRow[]>()
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
      .select(
        '*, item_renewals(*), customer:customers(*), transactions(*, users!transactions_created_by_user_id_fkey(id, full_name))',
      )
      .eq('id', id)
      .eq('environment', getEnvironment(user))
      .returns<
        Array<
          PawnedItemRow & {
            customer?: Record<string, unknown> | null;
          }
        >
      >()
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

    const pawnTx = (data.transactions || []).find(
      (t: TransactionWithUserRow) => t.purpose === 'Pawn',
    );
    const createdByUser = pawnTx?.users
      ? this.encryption.decryptUsersJoin(pawnTx.users)
      : null;
    const processorName = createdByUser
      ? this.decryptUserDisplayName(createdByUser.full_name)
      : null;

    return {
      ...data,
      customer: data.customer
        ? this.encryption.decryptCustomerEmbed(data.customer)
        : data.customer,
      profile_photo: profilePhoto,
      item_photos: itemPhotos,
      id_photo: idPhoto,
      id_back_photo: idBackPhoto,
      renewalCount: (data.item_renewals || []).length,
      renewals: (data.item_renewals || []).map((r: ItemRenewalRow) => ({
        date: r.renewal_date,
        amount: r.amount_paid,
      })),
      created_by_user: processorName ? { full_name: processorName } : null,
    };
  }

  async findByItemId(
    user: UserWithBranch,
    itemId: string,
    openingAudit = false,
  ) {
    const client = this.supabase.getClient();
    const cleanId = itemId.trim().toUpperCase();

    const scopedBranchId =
      user.role === Role.SUPER_ADMIN ? null : requireUserBranchId(user);

    // Resolve the live inventory row first. A stale pawned row can remain in the
    // table after a buy-back flow, so prefer the current Available sale row
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

    let transferQuery = client
      .from('transfer_items')
      .select('*')
      .ilike('item_id', cleanId)
      .eq('status', 'pending')
      .eq('environment', getEnvironment(user))
      .order('requested_at', { ascending: false });

    if (scopedBranchId) {
      transferQuery = transferQuery.eq('target_branch_id', scopedBranchId);
    }

    const [pawnedResult, saleResult, transferResult] = await Promise.all([
      pawnedQuery.limit(1).returns<PawnedItemRow[]>(),
      saleQuery.limit(1).returns<SaleItemRow[]>(),
      transferQuery.limit(1).returns<TransferItemRow[]>(),
    ]);

    const { data: pawnedRows, error: pawnedError } = pawnedResult;
    const pawnedData = Array.isArray(pawnedRows) ? pawnedRows[0] : null;
    const { data: saleRows, error: saleError } = saleResult;
    const saleData = Array.isArray(saleRows) ? saleRows[0] : null;
    const { data: transferRows, error: transferError } = transferResult;
    const transferData = Array.isArray(transferRows) ? transferRows[0] : null;

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

    if (transferError) {
      console.error(
        `[InventoryService] Error fetching transfer item ${cleanId}:`,
        transferError,
      );
    }

    const pawnedStatus = String(pawnedData?.status || '').trim();
    const pawnedIsCurrentInventory =
      isStatusIncludedInInventoryValuation(pawnedStatus);
    const interestRates = openingAudit
      ? await this.loadInterestRates(user)
      : [];

    const assertOpeningAuditItem = async (item: {
      type?: string;
      status?: string | null;
      pawnDate?: string | null;
      category?: string | null;
      saleItemId?: string | null;
    }) => {
      if (!openingAudit) {
        return;
      }

      if (item.type === 'TRANSFER') {
        throw new BadRequestException(
          'Transfer items are not part of the opening inventory scan.',
        );
      }

      if (item.saleItemId) {
        const { data: pendingTransfer } = await client
          .from('transfer_items')
          .select('id')
          .eq('sale_item_id', item.saleItemId)
          .eq('status', 'pending')
          .eq('environment', getEnvironment(user))
          .returns<Array<Pick<TransferItemRow, 'id'>>>()
          .maybeSingle();

        if (pendingTransfer) {
          throw new BadRequestException(
            'Items with a pending transfer cannot be scanned during opening audit.',
          );
        }
      }

      if (
        !this.isItemEligibleForOpeningAudit(
          {
            type: item.type,
            status: item.status,
            pawnDate: item.pawnDate,
            category: item.category,
          },
          interestRates,
        )
      ) {
        throw new BadRequestException(
          `Only available sale items and active pawn items within ${OPENING_AUDIT_PAWN_WINDOW_DAYS} days of maturity can be scanned during opening audit.`,
        );
      }
    };

    if (saleData) {
      assertResourceBranch(user, saleData.branch_id);
      const originalPhoto = await this.resolveStorageUrl(saleData.image_url);

      await assertOpeningAuditItem({
        type: 'SALE',
        status: saleData.status,
        pawnDate: saleData.available_date,
        category: saleData.category,
        saleItemId: saleData.id,
      });

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

    if (transferData && !openingAudit) {
      assertResourceBranch(user, transferData.target_branch_id);

      const { data: targetBranch } = await client
        .from('branches')
        .select('name')
        .eq('id', transferData.target_branch_id)
        .eq('environment', getEnvironment(user))
        .returns<Array<{ name: string }>>()
        .maybeSingle();

      return {
        id: transferData.id,
        itemId: transferData.item_id,
        itemName: transferData.item_name,
        category: 'Transfer Item',
        branch: targetBranch?.name || 'Target Branch',
        pawnDate: transferData.requested_at,
        status: 'Transfer Pending',
        itemPhotos: [],
        originalPhoto: '',
        itemIncluded: transferData.item_included || '',
        type: 'TRANSFER',
      };
    }

    if (pawnedData && pawnedIsCurrentInventory) {
      assertResourceBranch(user, pawnedData.branch_id);

      let customerData: CustomerContactRow | null = null;

      if (pawnedData.customer_id) {
        const { data: customer, error: customerError } = await client
          .from('customers')
          .select(
            'full_name, address, barangay, city, region, contact_number, id_presented',
          )
          .eq('id', pawnedData.customer_id)
          .eq('environment', getEnvironment(user))
          .returns<CustomerContactRow[]>()
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

      await assertOpeningAuditItem({
        type: 'PAWNED',
        status: pawnedData.status,
        pawnDate: pawnedData.pawn_date,
        category: pawnedData.category,
      });

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

  async updatePawned(
    user: UserWithBranch,
    id: string,
    dto: PawnedItemWriteDto,
  ) {
    await this.findOnePawned(user, id);
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('pawned_items')
      .update(dto)
      .eq('id', id)
      .eq('environment', getEnvironment(user))
      .select()
      .returns<PawnedItemRow[]>()
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
      .insert([
        { pawned_item_id: itemId, ...dto, ...environmentCreateFields(user) },
      ])
      .select()
      .returns<ItemRenewalRow[]>()
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
      .returns<PawnedItemRow[]>()
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
      .returns<PawnedItemRow[]>()
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
        .returns<SaleItemRow[]>()
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

    let firstPawnPhoto: string | null = null;
    if (Array.isArray(pawnedItem.item_photos) && pawnedItem.item_photos.length > 0) {
      firstPawnPhoto = pawnedItem.item_photos[0];
    } else if (typeof pawnedItem.item_photos === 'string' && pawnedItem.item_photos.trim()) {
      try {
        const parsed = JSON.parse(pawnedItem.item_photos);
        if (Array.isArray(parsed) && parsed.length > 0) {
          firstPawnPhoto = parsed[0];
        } else {
          firstPawnPhoto = pawnedItem.item_photos.split(',')[0].trim();
        }
      } catch {
        firstPawnPhoto = pawnedItem.item_photos.split(',')[0].trim();
      }
    }
    if (!firstPawnPhoto && pawnedItem.profile_photo) {
      firstPawnPhoto = pawnedItem.profile_photo;
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
          image_url: firstPawnPhoto || null,
          ...environmentCreateFields(user),
        },
      ])
      .select()
      .returns<SaleItemRow[]>()
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
      .returns<
        Array<
          Pick<
            PawnedItemRow,
            'id' | 'item_id' | 'item_name' | 'branch' | 'branch_id' | 'status'
          >
        >
      >()
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
      .returns<ActivityLogRow[]>()
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

    let systemItemListSource: Array<{
      item_id?: string | null;
      item_name?: string | null;
      category?: string | null;
      status?: string | null;
      source?: string | null;
      daysLeft?: number | null;
    }> = [];

    if (checklistSource === 'sale') {
      const { data: saleItems, error: saleError } = await client
        .from('sale_items')
        .select('item_id, item_name, category')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .in('status', ['Available', 'available'])
        .returns<Pick<SaleItemRow, 'item_id' | 'item_name' | 'category'>[]>();
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
        .in('status', INVENTORY_VALUATION_STATUSES)
        .returns<
          Pick<PawnedItemRow, 'item_id' | 'item_name' | 'category' | 'status'>[]
        >();
      if (pawnedError) {
        throw new InternalServerErrorException(pawnedError.message);
      }

      const { data: boughtBackRows, error: boughtBackError } = await client
        .from('transactions')
        .select('related_pawned_item_id')
        .eq('branch_id', branchId)
        .eq('environment', getEnvironment(user))
        .in('purpose', ['Buy Back'])
        .returns<Array<{ related_pawned_item_id: string | null }>>();
      if (boughtBackError) {
        throw new InternalServerErrorException(boughtBackError.message);
      }

      const boughtBackPawnedIds = new Set(
        (Array.isArray(boughtBackRows) ? boughtBackRows : [])
          .map(
            (row: { related_pawned_item_id?: string | null }) =>
              row.related_pawned_item_id,
          )
          .filter(
            (value): value is string =>
              typeof value === 'string' && value.trim().length > 0,
          ),
      );

      systemItemListSource = (
        Array.isArray(pawnedItems) ? pawnedItems : []
      ).filter(
        (item: { item_id?: string | null; status?: string | null }) =>
          isStatusIncludedInInventoryValuation(item.status) &&
          typeof item.item_id === 'string' &&
          item.item_id.trim().length > 0 &&
          !boughtBackPawnedIds.has(item.item_id),
      );
    } else {
      const openingAuditItems = await this.buildOpeningAuditSystemItems(
        user,
        branchId,
      );
      systemItemListSource = openingAuditItems;
    }

    const normalizeId = (value: string) => value.trim().toUpperCase();

    const systemItemList = Array.from(
      (systemItemListSource || [])
        .filter(
          (item): item is typeof item & { item_id: string } =>
            typeof item?.item_id === 'string' && item.item_id.trim().length > 0,
        )
        .reduce((map, item) => {
          const normalizedId = normalizeId(item.item_id);
          if (!map.has(normalizedId)) {
            map.set(normalizedId, {
              itemId: normalizedId,
              itemName: item.item_name || item.item_id,
              category: item.category || 'Uncategorized',
              source: item.source || 'sale',
              daysLeft: item.daysLeft,
            });
          }
          return map;
        }, new Map<string, { itemId: string; itemName: string; category: string; source: string; daysLeft?: number | null }>())
        .values(),
    );

    console.log('DEBUG systemItemList in qrTally:', systemItemList);

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

    const { error } = await client.storage.from(bucket).upload(path, buf, {
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

  async createForSale(user: UserWithBranch, dto: SaleItemWriteDto) {
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
        .returns<Array<{ name: string }>>()
        .single();
      branchName = branchData?.name || 'Unknown';
    }

    let imageUrl = dto.image_url;
    if (imageUrl && imageUrl.startsWith('data:image')) {
      const path = `sales_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
      imageUrl = await this.uploadPhoto(imageUrl, path, 'items_for_sale');
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
      .returns<SaleItemRow[]>()
      .single();

    if (error) {
      console.error('SUPABASE INSERT ERROR:', error);
      fs.appendFileSync('supabase-error.log', JSON.stringify(error) + '\n');
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

    const { data, error, count } = await query.returns<SaleItemRow[]>();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    let rows = Array.isArray(data) ? data : [];
    const statusFilter = String(filters.status || '')
      .trim()
      .toLowerCase();
    if (statusFilter === 'available' && rows.length > 0) {
      const saleItemIds = rows.map((item) => item.id);
      const { data: pendingTransfers, error: pendingError } = await client
        .from('transfer_items')
        .select('sale_item_id')
        .in('sale_item_id', saleItemIds)
        .eq('status', 'pending')
        .eq('environment', getEnvironment(user))
        .returns<Array<Pick<TransferItemRow, 'sale_item_id'>>>();

      if (pendingError) {
        throw new InternalServerErrorException(pendingError.message);
      }

      const pendingSaleItemIds = new Set(
        (Array.isArray(pendingTransfers) ? pendingTransfers : []).map(
          (row) => row.sale_item_id,
        ),
      );
      rows = rows.filter((item) => !pendingSaleItemIds.has(item.id));
    }

    // Look up pawn photos for any items that have original_pawn_id but missing image_url
    const missingPhotoPawnIds = rows
      .filter((item) => !item.image_url && item.original_pawn_id)
      .map((item) => item.original_pawn_id as string);

    const pawnPhotoMap = new Map<string, string>();
    if (missingPhotoPawnIds.length > 0) {
      const { data: pawnItems } = await client
        .from('pawned_items')
        .select('id, item_photos, profile_photo')
        .in('id', missingPhotoPawnIds)
        .eq('environment', getEnvironment(user))
        .returns<
          Array<{
            id: string;
            item_photos?: string[] | string | null;
            profile_photo?: string | null;
          }>
        >();

      for (const p of pawnItems || []) {
        let photo: string | null = null;
        if (Array.isArray(p.item_photos) && p.item_photos.length > 0) {
          photo = p.item_photos[0];
        } else if (typeof p.item_photos === 'string' && p.item_photos.trim()) {
          try {
            const parsed = JSON.parse(p.item_photos);
            if (Array.isArray(parsed) && parsed.length > 0) {
              photo = parsed[0];
            } else {
              photo = p.item_photos.split(',')[0].trim();
            }
          } catch {
            photo = p.item_photos.split(',')[0].trim();
          }
        }
        if (!photo && p.profile_photo) {
          photo = p.profile_photo;
        }
        if (photo) {
          pawnPhotoMap.set(p.id, photo);
        }
      }
    }

    const items = await Promise.all(
      rows.map(async (item) => {
        const rawPhoto =
          item.image_url ||
          (item.original_pawn_id ? pawnPhotoMap.get(item.original_pawn_id) : null);
        const imageUrl = rawPhoto
          ? await this.resolveStorageUrl(rawPhoto)
          : null;

        return {
          id: item.id,
          itemId: item.item_id,
          itemName: item.item_name,
          category: item.category,
          branch: item.branch,
          branchId: item.branch_id,
          availableDate: item.available_date,
          price: item.price,
          stockLevel: item.stock_level || 1,
          status: item.status || 'Available',
          originalPawnId: item.original_pawn_id || null,
          imageUrl: imageUrl || null,
        };
      }),
    );

    return {
      items: await Promise.all(
        rows.map(async (item) => ({
          id: item.id,
          itemId: item.item_id,
          itemName: item.item_name,
          category: item.category,
          branch: item.branch,
          branchId: item.branch_id,
          availableDate: item.available_date,
          price: item.price,
          stockLevel: item.stock_level || 1,
          status: item.status || 'Available',
          originalPawnId: item.original_pawn_id || null,
          imageUrl: await this.resolveStorageUrl(item.image_url),
        })),
      ),
      total: count || 0,
    };
  }

  private mapTransferRow(
    row: {
      id: string;
      sale_item_id: string;
      item_id: string;
      item_name: string;
      source_branch_id: string;
      target_branch_id: string;
      status: string;
      item_included?: string | null;
      notes?: string | null;
      requested_at?: string | null;
    },
    branchNames: Map<string, string>,
  ) {
    return {
      id: row.id,
      saleItemId: row.sale_item_id,
      itemId: row.item_id,
      itemName: row.item_name,
      sourceBranchId: row.source_branch_id,
      sourceBranchName:
        branchNames.get(row.source_branch_id) || 'Source Branch',
      targetBranchId: row.target_branch_id,
      targetBranchName:
        branchNames.get(row.target_branch_id) || 'Target Branch',
      status: row.status,
      itemIncluded: row.item_included || undefined,
      notes: row.notes || undefined,
      requestedAt: row.requested_at || undefined,
    };
  }

  async findAllTransfers(user: UserWithBranch, branch?: string) {
    const client = this.supabase.getClient();
    const { branchId } = inventoryBranchFilters(user, branch);

    let query = client
      .from('transfer_items')
      .select('*')
      .eq('environment', getEnvironment(user))
      .order('requested_at', { ascending: false });

    if (branchId) {
      query = query.or(
        `source_branch_id.eq.${branchId},target_branch_id.eq.${branchId}`,
      );
    }

    const { data, error } = await query.returns<TransferItemRow[]>();
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const rows = Array.isArray(data) ? data : [];
    const branchIds = [
      ...new Set(
        rows.flatMap((row) => [row.source_branch_id, row.target_branch_id]),
      ),
    ];

    const branchNames = new Map<string, string>();
    if (branchIds.length > 0) {
      const { data: branches, error: branchError } = await client
        .from('branches')
        .select('id, name')
        .in('id', branchIds)
        .eq('environment', getEnvironment(user))
        .returns<BranchNameRow[]>();

      if (branchError) {
        throw new InternalServerErrorException(branchError.message);
      }

      for (const branchRow of branches || []) {
        branchNames.set(branchRow.id, branchRow.name);
      }
    }

    return {
      transfers: rows.map((row) => this.mapTransferRow(row, branchNames)),
    };
  }

  async getPendingTransferSummary(user: UserWithBranch, branch?: string) {
    const client = this.supabase.getClient();
    const { branchId } = inventoryBranchFilters(user, branch);

    let incomingQuery = client
      .from('transfer_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .eq('environment', getEnvironment(user));

    let outgoingQuery = client
      .from('transfer_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .eq('environment', getEnvironment(user));

    if (branchId) {
      incomingQuery = incomingQuery.eq('target_branch_id', branchId);
      outgoingQuery = outgoingQuery.eq('source_branch_id', branchId);
    }

    const [incomingResult, outgoingResult] = await Promise.all([
      incomingQuery,
      outgoingQuery,
    ]);

    if (incomingResult.error) {
      throw new InternalServerErrorException(incomingResult.error.message);
    }
    if (outgoingResult.error) {
      throw new InternalServerErrorException(outgoingResult.error.message);
    }

    const incomingCount = incomingResult.count ?? 0;
    const outgoingCount = outgoingResult.count ?? 0;

    return {
      incomingCount,
      outgoingCount,
      totalPending: incomingCount + outgoingCount,
      needsReceipt: incomingCount > 0,
    };
  }

  async createTransferRequest(
    user: UserWithBranch & { id: string; authId?: string | null },
    saleItemId: string,
    dto: {
      target_branch_id: string;
      item_included?: string;
      notes?: string;
    },
  ) {
    const targetBranchId = dto.target_branch_id?.trim();
    if (!targetBranchId) {
      throw new BadRequestException('Destination branch is required');
    }

    const item = await this.findOneForSale(user, saleItemId);
    const normalizedStatus = String(item.status || '')
      .trim()
      .toLowerCase();
    if (normalizedStatus !== 'available') {
      throw new BadRequestException('Only available items can be transferred');
    }

    const sourceBranchId = String(item.branch_id);
    if (sourceBranchId === targetBranchId) {
      throw new BadRequestException(
        'Destination branch must differ from source branch',
      );
    }

    const client = this.supabase.getClient();

    const { data: pendingTransfer, error: pendingError } = await client
      .from('transfer_items')
      .select('id')
      .eq('sale_item_id', saleItemId)
      .eq('status', 'pending')
      .eq('environment', getEnvironment(user))
      .returns<Array<Pick<TransferItemRow, 'id'>>>()
      .maybeSingle();

    if (pendingError) {
      throw new InternalServerErrorException(pendingError.message);
    }
    if (pendingTransfer) {
      throw new ConflictException('This item already has a pending transfer');
    }

    const { data: targetBranch, error: targetBranchError } = await client
      .from('branches')
      .select('id, name')
      .eq('id', targetBranchId)
      .eq('environment', getEnvironment(user))
      .returns<BranchNameRow[]>()
      .maybeSingle();

    if (targetBranchError) {
      throw new InternalServerErrorException(targetBranchError.message);
    }
    if (!targetBranch) {
      throw new NotFoundException('Destination branch not found');
    }

    const { error: updateError } = await client
      .from('sale_items')
      .update({ status: 'Transfer Pending' })
      .eq('id', saleItemId)
      .eq('environment', getEnvironment(user));

    if (updateError) {
      throw new InternalServerErrorException(updateError.message);
    }

    const { data: transfer, error: insertError } = await client
      .from('transfer_items')
      .insert([
        {
          sale_item_id: saleItemId,
          item_id: item.item_id,
          item_name: item.item_name,
          source_branch_id: sourceBranchId,
          target_branch_id: targetBranchId,
          requested_by_user_id: user.id,
          status: 'pending',
          item_included: dto.item_included?.trim() || null,
          notes: dto.notes?.trim() || null,
          ...environmentCreateFields(user),
        },
      ])
      .select()
      .returns<TransferItemRow[]>()
      .single();

    if (insertError) {
      await client
        .from('sale_items')
        .update({ status: 'Available' })
        .eq('id', saleItemId)
        .eq('environment', getEnvironment(user));
      throw new InternalServerErrorException(insertError.message);
    }

    const today = getPhCalendarDateString();
    const transferDetails = [
      `Item transfer to ${targetBranch.name}`,
      dto.item_included?.trim()
        ? `Included: ${dto.item_included.trim()}`
        : null,
      dto.notes?.trim() ? `Notes: ${dto.notes.trim()}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    const { error: txError } = await client.from('transactions').insert([
      {
        transaction_no: `XFER-${Date.now()}`,
        branch_id: sourceBranchId,
        branch: item.branch ?? 'Unknown',
        purpose: 'Transfer Item',
        transaction_date: today,
        transaction_time: getPhWallClockTimeString(),
        cash_in: 0,
        cash_out: 0,
        unit: item.item_name ?? null,
        unit_code: item.item_id ?? null,
        details: transferDetails,
        related_sale_item_id: saleItemId,
        created_by_user_id: user.id,
        ...environmentCreateFields(user),
      },
    ]);
    if (txError) {
      console.error(
        '[InventoryService] Failed to create transfer transaction',
        txError,
      );
    }

    try {
      await this.notificationsService.create({
        title: `${item.item_name} incoming transfer`,
        subtitle: `Transfer request from ${item.branch} [${item.item_id}]`,
        message: `${item.item_name} is waiting to be received at ${targetBranch.name}. Open Transfer Items to confirm receipt.`,
        category: 'Alerts',
        branch_id: targetBranchId,
        event_key: `inventory-transfer:${transfer.id}`,
        notification_type: 'INVENTORY_ITEM_TRANSFER',
        entity_type: 'inventory_transfer',
        entity_id: transfer.id,
        target_url: '/admin/pawn-transactions?itemTransfer=receive',
        environment: getEnvironment(user),
        created_by: user.authId ?? null,
      });
    } catch (error) {
      console.warn(
        '[InventoryService] Failed to create transfer notification',
        error,
      );
    }

    return {
      message: 'Transfer request created',
      transfer: this.mapTransferRow(
        transfer,
        new Map([[targetBranchId, targetBranch.name]]),
      ),
    };
  }

  async receiveTransfer(
    user: UserWithBranch & { id: string },
    transferId: string,
  ) {
    const client = this.supabase.getClient();

    const { data: transfer, error } = await client
      .from('transfer_items')
      .select('*')
      .eq('id', transferId)
      .eq('environment', getEnvironment(user))
      .returns<TransferItemRow[]>()
      .single();

    if (error || !transfer) {
      throw new NotFoundException('Transfer not found');
    }

    if (transfer.status !== 'pending') {
      throw new ConflictException('Transfer is no longer pending');
    }

    assertResourceBranch(user, transfer.target_branch_id);

    const { data: targetBranch, error: targetBranchError } = await client
      .from('branches')
      .select('name')
      .eq('id', transfer.target_branch_id)
      .eq('environment', getEnvironment(user))
      .returns<Array<{ name: string }>>()
      .maybeSingle();

    if (targetBranchError) {
      throw new InternalServerErrorException(targetBranchError.message);
    }
    if (!targetBranch) {
      throw new NotFoundException('Destination branch not found');
    }

    const { data: sourceBranch, error: sourceBranchError } = await client
      .from('branches')
      .select('name')
      .eq('id', transfer.source_branch_id)
      .eq('environment', getEnvironment(user))
      .returns<Array<{ name: string }>>()
      .maybeSingle();

    if (sourceBranchError) {
      throw new InternalServerErrorException(sourceBranchError.message);
    }

    const now = new Date().toISOString();

    const { error: transferUpdateError } = await client
      .from('transfer_items')
      .update({
        status: 'received',
        received_by_user_id: user.id,
        received_at: now,
        updated_at: now,
      })
      .eq('id', transferId)
      .eq('environment', getEnvironment(user));

    if (transferUpdateError) {
      throw new InternalServerErrorException(transferUpdateError.message);
    }

    const { error: saleUpdateError } = await client
      .from('sale_items')
      .update({
        branch_id: transfer.target_branch_id,
        branch: targetBranch.name,
        status: 'Available',
        updated_at: now,
      })
      .eq('id', transfer.sale_item_id)
      .eq('environment', getEnvironment(user));

    if (saleUpdateError) {
      throw new InternalServerErrorException(saleUpdateError.message);
    }

    const today = getPhCalendarDateString();
    const receiveDetails = [
      `Item received from ${sourceBranch?.name || 'source branch'}`,
      transfer.item_included ? `Included: ${transfer.item_included}` : null,
      transfer.notes ? `Notes: ${transfer.notes}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    const { error: txError } = await client.from('transactions').insert([
      {
        transaction_no: `RCV-${Date.now()}`,
        branch_id: transfer.target_branch_id,
        branch: targetBranch.name,
        purpose: 'Transfer Item',
        transaction_date: today,
        transaction_time: getPhWallClockTimeString(),
        cash_in: 0,
        cash_out: 0,
        unit: transfer.item_name ?? null,
        unit_code: transfer.item_id ?? null,
        details: receiveDetails,
        related_sale_item_id: transfer.sale_item_id,
        created_by_user_id: user.id,
        ...environmentCreateFields(user),
      },
    ]);
    if (txError) {
      console.error(
        '[InventoryService] Failed to create receive transaction',
        txError,
      );
    }

    return { message: 'Transfer received successfully' };
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

    const { data, error } =
      await query.returns<
        Array<Pick<SaleItemRow, 'status' | 'price' | 'available_date'>>
      >();
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
        .order('created_at', { ascending: false })
        .returns<
          Array<
            Pick<
              SaleItemRow,
              | 'id'
              | 'item_id'
              | 'item_name'
              | 'category'
              | 'branch'
              | 'branch_id'
              | 'available_date'
              | 'price'
              | 'status'
              | 'image_url'
            >
          >
        >(),
      client
        .from('branches')
        .select('id, name, location')
        .eq('environment', 'production')
        .returns<Array<{ id: string; name: string; location: string }>>(),
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
      (saleResult.data || []).map(async (item) => {
        const branchInfo = branchLookup.get(String(item.branch_id));
        const imageUrl = await this.resolveStorageUrl(item.image_url);

        return {
          id: item.id,
          itemId: item.item_id,
          itemName: item.item_name,
          category: item.category,
          branch: branchInfo?.name || item.branch || 'Branch',
          branchLocation: branchInfo?.location || '',
          availableDate: item.available_date || '',
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

    const { data, error } =
      await query.returns<Array<Pick<SaleItemRow, 'category'>>>();
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
        transaction_time: getPhWallClockTimeString(),
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
      .returns<SaleItemRow[]>()
      .single();
    if (error || !data) {
      throw new NotFoundException('Item not found');
    }
    assertResourceBranch(user, data?.branch_id);

    let rawPhoto = data.image_url;
    if (!rawPhoto && data.original_pawn_id) {
      const { data: pawnItem } = await client
        .from('pawned_items')
        .select('item_photos, profile_photo')
        .eq('id', data.original_pawn_id)
        .eq('environment', getEnvironment(user))
        .returns<Array<{ item_photos?: string[] | string | null; profile_photo?: string | null }>>()
        .maybeSingle();

      if (pawnItem) {
        if (Array.isArray(pawnItem.item_photos) && pawnItem.item_photos.length > 0) {
          rawPhoto = pawnItem.item_photos[0];
        } else if (typeof pawnItem.item_photos === 'string' && pawnItem.item_photos.trim()) {
          try {
            const parsed = JSON.parse(pawnItem.item_photos);
            if (Array.isArray(parsed) && parsed.length > 0) {
              rawPhoto = parsed[0];
            } else {
              rawPhoto = pawnItem.item_photos.split(',')[0].trim();
            }
          } catch {
            rawPhoto = pawnItem.item_photos.split(',')[0].trim();
          }
        }
        if (!rawPhoto && pawnItem.profile_photo) {
          rawPhoto = pawnItem.profile_photo;
        }
      }
    }

    const imageUrl = rawPhoto ? await this.resolveStorageUrl(rawPhoto) : null;

    return {
      ...data,
      imageUrl: imageUrl || null,
    };
  }

  async updateForSale(user: UserWithBranch, id: string, dto: SaleItemWriteDto) {
    await this.findOneForSale(user, id);
    const client = this.supabase.getClient();

    let imageUrl = dto.image_url;
    if (imageUrl && imageUrl.startsWith('data:image')) {
      const path = `sales_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
      imageUrl = await this.uploadPhoto(imageUrl, path, 'items_for_sale');
      dto.image_url = imageUrl;
    }

    const { data, error } = await client
      .from('sale_items')
      .update(dto)
      .eq('id', id)
      .eq('environment', getEnvironment(user))
      .select()
      .returns<SaleItemRow[]>()
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
      .returns<
        Array<
          Pick<
            PawnedItemRow,
            'id' | 'item_id' | 'item_name' | 'branch' | 'branch_id'
          >
        >
      >()
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
      .returns<
        Array<{
          id: string;
          action: string;
          details: string | null;
          branch_id?: string | null;
        }>
      >()
      .single();

    if (requestLogError || !requestLog) {
      throw new NotFoundException('Replacement request not found');
    }

    const parsedDetails = JSON.parse(requestLog.details || '{}') as Record<
      string,
      unknown
    >;
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
