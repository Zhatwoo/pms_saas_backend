import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

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

  // ═══════════════════════════════════════════════════════════
  // PAWNED ITEMS
  // ═══════════════════════════════════════════════════════════

  async findAllPawned(filters: QueryFilters) {
    const client = this.supabase.getClient();
    let query = client
      .from('pawned_items')
      .select('*, item_renewals(*)', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (filters.branch) query = query.ilike('branch', `%${filters.branch}%`);
    if (filters.category) query = query.ilike('category', `%${filters.category}%`);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.search) query = query.ilike('item_name', `%${filters.search}%`);

    const from = (filters.page - 1) * filters.limit;
    query = query.range(from, from + filters.limit - 1);

    const { data, error, count } = await query;
    if (error) throw new InternalServerErrorException(error.message);

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

  async createPawned(dto: any) {
    const client = this.supabase.getClient();
    const { data, error } = await client.from('pawned_items').insert([dto]).select().single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async findOnePawned(id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('pawned_items')
      .select('*, item_renewals(*)')
      .eq('id', id)
      .single();
    if (error) throw new NotFoundException('Item not found');
    return data;
  }

  async updatePawned(id: string, dto: any) {
    const client = this.supabase.getClient();
    const { data, error } = await client.from('pawned_items').update(dto).eq('id', id).select().single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async deletePawned(id: string) {
    const client = this.supabase.getClient();
    const { error } = await client.from('pawned_items').delete().eq('id', id);
    if (error) throw new InternalServerErrorException(error.message);
    return { message: 'Item deleted' };
  }

  // Renewal tracking
  async addRenewal(itemId: string, dto: { renewal_date: string; amount_paid: number }) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('item_renewals')
      .insert([{ pawned_item_id: itemId, ...dto }])
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  // Remarks
  async addRemark(itemId: string, remark: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('pawned_items')
      .update({ remarks: remark })
      .eq('id', itemId)
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  // ─── EXPIRE & AUTO-TRANSFER TO ITEMS FOR SALE ─────────────
  async expireAndTransfer(itemId: string) {
    const client = this.supabase.getClient();

    // 1. Get the pawned item
    const { data: pawnedItem, error: fetchErr } = await client
      .from('pawned_items')
      .select('*')
      .eq('id', itemId)
      .single();
    if (fetchErr || !pawnedItem) throw new NotFoundException('Pawned item not found');

    // 2. Mark as Expired
    const { error: updateErr } = await client
      .from('pawned_items')
      .update({ status: 'Expired' })
      .eq('id', itemId);
    if (updateErr) throw new InternalServerErrorException(updateErr.message);

    // 3. Auto-create entry in sale_items
    const { data: saleItem, error: insertErr } = await client
      .from('sale_items')
      .insert([{
        item_name: pawnedItem.item_name,
        category: pawnedItem.category,
        branch: pawnedItem.branch,
        branch_id: pawnedItem.branch_id,
        available_date: new Date().toISOString().split('T')[0],
        price: 0, // Admin will set the selling price later
        status: 'Available',
        original_pawn_id: pawnedItem.id,
      }])
      .select()
      .single();
    if (insertErr) throw new InternalServerErrorException(insertErr.message);

    return { message: 'Item expired and transferred to Items for Sale', saleItem };
  }

  // ─── QR TALLY (Physical vs System check) ──────────────────
  async qrTally(branchId: number, scannedItemIds: string[]) {
    const client = this.supabase.getClient();

    // Get all Active items in the branch
    const { data: systemItems, error } = await client
      .from('pawned_items')
      .select('item_id')
      .eq('branch_id', branchId)
      .eq('status', 'Active');
    if (error) throw new InternalServerErrorException(error.message);

    const systemIds = (systemItems || []).map((i: any) => i.item_id);
    const missingInVault = systemIds.filter((id: string) => !scannedItemIds.includes(id));
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

  async findAllForSale(filters: QueryFilters) {
    const client = this.supabase.getClient();
    let query = client
      .from('sale_items')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (filters.branch) query = query.ilike('branch', `%${filters.branch}%`);
    if (filters.category) query = query.ilike('category', `%${filters.category}%`);
    if (filters.search) query = query.ilike('item_name', `%${filters.search}%`);

    // Current month vs History
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
    if (error) throw new InternalServerErrorException(error.message);

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

  // ─── MARK SOLD → ADD TO BRANCH BALANCE ────────────────────
  async markSoldAndAddToBalance(itemId: string, soldPrice: number, branchId: number) {
    const client = this.supabase.getClient();

    // 1. Mark as Sold
    const { error: updateErr } = await client
      .from('sale_items')
      .update({ status: 'Sold', price: soldPrice })
      .eq('id', itemId);
    if (updateErr) throw new InternalServerErrorException(updateErr.message);

    // 2. Add sold amount to branch daily balance (cash in)
    const today = new Date().toISOString().split('T')[0];
    const { data: balanceData } = await client
      .from('daily_balances')
      .select('ending_balance')
      .eq('branch_id', branchId)
      .eq('record_date', today)
      .single();

    if (balanceData) {
      await client
        .from('daily_balances')
        .update({ ending_balance: parseFloat(balanceData.ending_balance) + soldPrice })
        .eq('branch_id', branchId)
        .eq('record_date', today);
    }

    return { message: 'Item marked as sold, amount added to branch balance' };
  }

  async createForSale(dto: any) {
    const client = this.supabase.getClient();
    const { data, error } = await client.from('sale_items').insert([dto]).select().single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async findOneForSale(id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client.from('sale_items').select('*').eq('id', id).single();
    if (error) throw new NotFoundException('Item not found');
    return data;
  }

  async updateForSale(id: string, dto: any) {
    const client = this.supabase.getClient();
    const { data, error } = await client.from('sale_items').update(dto).eq('id', id).select().single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async deleteForSale(id: string) {
    const client = this.supabase.getClient();
    const { error } = await client.from('sale_items').delete().eq('id', id);
    if (error) throw new InternalServerErrorException(error.message);
    return { message: 'Item deleted' };
  }
}
