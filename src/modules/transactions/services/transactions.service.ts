import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

@Injectable()
export class TransactionsService {
  constructor(private supabase: SupabaseService) {}

  async create(createTransactionDto: any) {
    const { branch_id, cash_in, cash_out } = createTransactionDto;
    const client = this.supabase.getClient();
    
    // 1. Insert Transaction
    const { data, error } = await client
      .from('transactions')
      .insert([createTransactionDto])
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    // 2. Adjust daily balance real time
    if (branch_id && (cash_in || cash_out)) {
      const today = new Date().toISOString().split('T')[0];
      
      const { data: balanceData } = await client
        .from('daily_balances')
        .select('ending_balance')
        .eq('branch_id', branch_id)
        .eq('record_date', today)
        .single();
        
      if (balanceData) {
        const netChange = (parseFloat(cash_in || 0) - parseFloat(cash_out || 0));
        await client
          .from('daily_balances')
          .update({ ending_balance: parseFloat(balanceData.ending_balance) + netChange })
          .eq('branch_id', branch_id)
          .eq('record_date', today);
      }
    }

    return data;
  }

  async findAll(branchId?: string) {
    const client = this.supabase.getClient();
    let query = client.from('transactions').select('*').order('created_at', { ascending: false });
    
    if (branchId && branchId !== 'All Branches') {
      query = query.eq('branch_id', branchId);
    }
    
    const { data: transactions, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);
    
    // Compute quick dashboard stats
    return transactions;
  }

  async findOne(id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client.from('transactions').select('*').eq('id', id).single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }
}
