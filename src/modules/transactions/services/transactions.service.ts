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

  async create(user: UserWithBranch, createTransactionDto: any) {
    const payload =
      user.role === Role.SUPER_ADMIN
        ? { ...createTransactionDto }
        : {
            ...createTransactionDto,
            branch_id: requireUserBranchId(user),
          };
    payload.created_by_user_id = user.id;
    const { branch_id, cash_in, cash_out } = payload;
    const client = this.supabase.getClient();

    // 1. Insert Transaction
    const { data, error } = await client
      .from('transactions')
      .insert([payload])
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    if (branch_id && (cash_in || cash_out)) {
      const netChange = parseFloat(cash_in || 0) - parseFloat(cash_out || 0);
      await adjustDailyBalance(client, branch_id, netChange);
    }

    return data;
  }

  async findAll(
    user: UserWithBranch,
    branchQuery?: string,
    date?: string,
    range?: string,
    customerId?: string,
  ) {
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

    // Skip date filtering if customerId is provided - show all customer's transactions
    if (!customerId) {
      if (date) {
        query = query.eq('transaction_date', date);
      } else if (range && range !== 'daily') {
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
      } else if (range === 'daily' || !range) {
        // Keep daily default for general transaction list calls (when no customerId).
        const filterDate = date || new Date().toISOString().split('T')[0];
        query = query.eq('transaction_date', filterDate);
      }
    }

    const { data: transactions, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    // Filter by customerId after fetching (post-filter)
    let filtered = transactions;
    if (customerId) {
      filtered = transactions.filter((tx: any) => tx.pawned_item?.customer_id === customerId);
    }

    // Compute stats for the requested date
    const stats = {
      pawnedToday: filtered.filter((t: any) => t.purpose === 'Pawn').length,
      buyBack: filtered.filter((t: any) => t.purpose === 'Buy Back').length,
      renewed: filtered.filter((t: any) => t.purpose === 'Renew').length,
      soldItem: filtered.filter((t: any) => t.purpose === 'Sold Item').length,
    };

    return { transactions: filtered, stats };
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
