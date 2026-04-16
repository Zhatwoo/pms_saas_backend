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

  async findAll(user: UserWithBranch, branchQuery?: string, date?: string) {
    const client = this.supabase.getClient();
    let query = client
      .from('transactions')
      .select('*')
      .order('created_at', { ascending: false });

    const scoped = effectiveBranchIdForQuery(user, branchQuery);
    if (scoped) {
      query = query.eq('branch_id', scoped);
    }

    // Default to today if no date provided, to satisfy "ngayon araw" request
    const filterDate = date || new Date().toISOString().split('T')[0];
    query = query.eq('transaction_date', filterDate);

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
