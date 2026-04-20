import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import {
  assertResourceBranch,
  effectiveBranchIdForQuery,
  requireUserBranchId,
} from '../../../common/utils/branch-scope.util';
import { adjustDailyBalance } from '../../../common/utils/daily-balance.util';
import { Role } from '../../../common/enums';

@Injectable()
export class TransactionsService {
  constructor(private supabase: SupabaseService) {}

  async create(user: UserWithBranch, dto: any) {
    // 1. Resolve Branch Info
    const branchId = dto.branch_id || (user.role !== Role.SUPER_ADMIN ? requireUserBranchId(user) : null);
    if (!branchId) {
      throw new InternalServerErrorException("Missing branch_id for transaction.");
    }

    const branchName = dto.branch || 'Unknown Branch';
    
    // Generate transaction number if not provided
    const transactionNo = dto.transaction_no || 
      `${dto.purpose?.substring(0, 2).toUpperCase() || 'TX'}-${Date.now()}`;

    const payload = {
      ...dto,
      transaction_no: transactionNo,
      branch_id: branchId,
      branch: branchName,
    };
    
    const { cash_in, cash_out } = payload;
    const client = this.supabase.getClient();

    // 1. Insert Transaction
    const { data, error } = await client
      .from('transactions')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("[Transactions DB Error]", error);
      throw new InternalServerErrorException(error.message);
    }

    if (branchId && (cash_in || cash_out)) {
      const netChange = parseFloat(cash_in || 0) - parseFloat(cash_out || 0);
      await adjustDailyBalance(client, branchId, netChange);
    }

    return data;
  }

  async findAll(user: UserWithBranch, branchQuery?: string, date?: string, range?: string) {
    const client = this.supabase.getClient();
    let query = client
      .from('transactions')
      .select(`
        *,
        pawned_item:pawned_items (
          *,
          customer:customers (
            full_name,
            address,
            contact_number
          )
        )
      `)
      .order('transaction_date', { ascending: false })
      .order('transaction_time', { ascending: false });

    const scoped = effectiveBranchIdForQuery(user, branchQuery);
    if (scoped) {
      query = query.eq('branch_id', scoped);
    }

    if (range && range !== 'daily') {
      if (range === 'weekly') {
        const lastWeek = new Date();
        lastWeek.setDate(lastWeek.getDate() - 7);
        query = query.gte('transaction_date', lastWeek.toISOString().split('T')[0]);
      } else if (range === 'monthly') {
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);
        query = query.gte('transaction_date', lastMonth.toISOString().split('T')[0]);
      }
      // If range is 'all', we don't apply any date filter
    } else {
      // Default to daily if no range or range is 'daily'
      const filterDate = date || new Date().toISOString().split('T')[0];
      query = query.eq('transaction_date', filterDate);
    }

    const { data: transactions, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    // Compute stats for the requested date
    const stats = {
      pawnedToday: transactions.filter((t: any) => t.purpose === 'Pawn').length,
      buyBack: transactions.filter((t: any) => t.purpose === 'Buy Back').length,
      renewed: transactions.filter((t: any) => t.purpose === 'Renew').length,
      soldItem: transactions.filter((t: any) => t.purpose === 'Sold Item').length,
    };

    return { transactions, stats };
  }

  async findOne(user: UserWithBranch, id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    assertResourceBranch(user, data?.branch_id);
    return data;
  }
}
