import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { Role } from '../../../common/enums';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import {
  assertResourceBranch,
  inventoryBranchFilters,
  requireUserBranchId,
} from '../../../common/utils/branch-scope.util';

interface QueryFilters {
  branch?: string;
  category?: string;
  status?: string;
  search?: string;
  viewMode?: string;
  page: number;
  limit: number;
}

@Injectable()
export class InventoryService {
  constructor(private supabase: SupabaseService) {}

  private async adjustDailyBalance(
    branchId: string,
    delta: number,
  ): Promise<void> {
    if (!branchId || !Number.isFinite(delta) || delta === 0) {
      return;
    }

    const client = this.supabase.getClient();
    const today = new Date().toISOString().split('T')[0];
    const { data: balanceRow, error: balanceError } = await client
      .from('daily_balances')
      .select('ending_balance')
      .eq('branch_id', branchId)
      .eq('record_date', today)
      .maybeSingle<{ ending_balance: number | string }>();

    if (balanceError) {
      throw new InternalServerErrorException(balanceError.message);
    }

    if (!balanceRow) {
      return;
    }

    const currentBalance = Number(balanceRow.ending_balance ?? 0);
    const { error: updateError } = await client
      .from('daily_balances')
      .update({ ending_balance: currentBalance + delta })
      .eq('branch_id', branchId)
      .eq('record_date', today);

    if (updateError) {
      throw new InternalServerErrorException(updateError.message);
    }
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
      .select('*, item_renewals(*)', { count: 'exact' })
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
      query = query.ilike('item_name', `%${filters.search}%`);
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
        pawnDate: item.pawn_date,
        status: item.status,
        renewalCount: (item.item_renewals || []).length,
        renewals: (item.item_renewals || []).map((r: any) => ({
          date: r.renewal_date,
          amount: r.amount_paid,
        })),
        remarks: item.remarks || '',
        qrCode: item.qr_code || '',
        originalPhoto: item.original_photo || '',
        conditionReport: item.condition_report || '',
      })),
      total: count || 0,
    };
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
      .select('*, item_renewals(*)')
      .eq('id', id)
      .single();
    if (error) {
      throw new NotFoundException('Item not found');
    }
    assertResourceBranch(user, data?.branch_id);
    return data;
  }

  async findByItemId(user: UserWithBranch, itemId: string) {
    const client = this.supabase.getClient();
    const cleanId = itemId.trim().toUpperCase();

    // 1. Try Pawned Items
    const { data: pawnedData, error: pawnedError } = await client
      .from('pawned_items')
      .select('*, item_renewals(*)')
      .ilike('item_id', cleanId)
      .maybeSingle();

    if (pawnedError) {
      console.error(
        `[InventoryService] Error fetching pawned item ${cleanId}:`,
        pawnedError,
      );
    }

    if (pawnedData) {
      assertResourceBranch(user, pawnedData.branch_id);
      return {
        id: pawnedData.id,
        itemId: pawnedData.item_id,
        itemName: pawnedData.item_name,
        category: pawnedData.category,
        branch: pawnedData.branch,
        pawnDate: pawnedData.pawn_date,
        status: pawnedData.status,
        originalPhoto: pawnedData.original_photo || '',
        type: 'PAWNED',
      };
    }

    // 2. Try Sale Items
    const { data: saleData, error: saleError } = await client
      .from('sale_items')
      .select('*')
      .ilike('item_id', cleanId)
      .maybeSingle();

    if (saleError) {
      console.error(
        `[InventoryService] Error fetching sale item ${cleanId}:`,
        saleError,
      );
    }

    if (saleData) {
      assertResourceBranch(user, saleData.branch_id);
      return {
        id: saleData.id,
        itemId: saleData.item_id,
        itemName: saleData.item_name,
        category: saleData.category,
        branch: saleData.branch,
        pawnDate: saleData.available_date,
        status: saleData.status,
        originalPhoto: saleData.image_url || '',
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

    const { data: saleItem, error: insertErr } = await client
      .from('sale_items')
      .insert([
        {
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

    return {
      message: 'Item expired and transferred to Items for Sale',
      saleItem,
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
      .select('item_id')
      .eq('branch_id', branchId)
      .eq('status', 'Active');
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const systemIds = (systemItems || []).map((i: any) => i.item_id);
    const missingInVault = systemIds.filter(
      (id: string) => !scannedItemIds.includes(id),
    );
    const extraInVault = scannedItemIds.filter((id) => !systemIds.includes(id));

    return {
      totalInSystem: systemIds.length,
      totalScanned: scannedItemIds.length,
      matched: scannedItemIds.filter((id) => systemIds.includes(id)).length,
      missingInVault,
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
    } else {
      query = query.eq('status', 'Available');
    }

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
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
      })),
      total: count || 0,
    };
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

    await this.adjustDailyBalance(branchId, soldPrice);

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
