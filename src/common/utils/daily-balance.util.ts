import { InternalServerErrorException } from '@nestjs/common';
import { getPhCalendarDateString } from './branch-calendar-date.util';

/**
 * Adjusts the daily balance for a branch by a given delta.
 *
 * If today's row exists, updates ending_balance.
 * If not, creates a new row carrying forward the previous day's ending
 * balance as today's starting_balance.
 *
 * Uses Asia/Manila calendar date so this matches branch-finance / daily_opening.
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
  const today = getPhCalendarDateString();

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

  // Carry forward the previous day's ending balance as today's starting balance.
  let startingBalance = 0;
  const { data: priorRow } = await client
    .from('daily_balances')
    .select('ending_balance')
    .eq('branch_id', branchId)
    .lt('record_date', today)
    .order('record_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (priorRow) {
    startingBalance = Number(Number(priorRow.ending_balance ?? 0).toFixed(2));
  }

  const { error: insertError } = await client.from('daily_balances').insert({
    branch_id: branchId,
    record_date: today,
    starting_balance: startingBalance,
    ending_balance: Number((startingBalance + amount).toFixed(2)),
  });

  if (insertError) {
    throw new InternalServerErrorException(insertError.message);
  }
}
