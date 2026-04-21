import { InternalServerErrorException } from '@nestjs/common';

/**
 * Adjusts the daily balance for a branch by a given delta.
 *
 * If today's row exists, updates ending_balance.
 * If not, creates a new row carrying forward the previous day's ending_balance.
 */
export async function adjustDailyBalance(
  client: {
    from: (table: string) => any;
  },
  branchId: string,
  delta: number,
): Promise<void> {
  if (!branchId || !Number.isFinite(delta) || delta === 0) {
    return;
  }

  const amount = Number(delta.toFixed(2));
  const today = new Date().toISOString().split('T')[0];

  const { data: existing, error: existingError } = await client
    .from('daily_balances')
    .select('id, ending_balance')
    .eq('branch_id', branchId)
    .eq('record_date', today)
    .maybeSingle();

  if (existingError) {
    throw new InternalServerErrorException(existingError.message);
  }

  if (existing) {
    const endingBalance = Number(existing.ending_balance ?? 0);
    const { error: updateError } = await client
      .from('daily_balances')
      .update({
        ending_balance: Number((endingBalance + amount).toFixed(2)),
      })
      .eq('id', existing.id);

    if (updateError) {
      throw new InternalServerErrorException(updateError.message);
    }
    return;
  }

  const { data: lastBalance, error: lastBalanceError } = await client
    .from('daily_balances')
    .select('ending_balance')
    .eq('branch_id', branchId)
    .order('record_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastBalanceError) {
    throw new InternalServerErrorException(lastBalanceError.message);
  }

  const startingBalance = Number(lastBalance?.ending_balance ?? 0);
  const { error: insertError } = await client.from('daily_balances').insert({
    branch_id: branchId,
    record_date: today,
    starting_balance: Number(startingBalance.toFixed(2)),
    ending_balance: Number((startingBalance + amount).toFixed(2)),
  });

  if (insertError) {
    throw new InternalServerErrorException(insertError.message);
  }
}
