import { InternalServerErrorException } from '@nestjs/common';

/**
 * @deprecated Dual-write Supabase helper removed. Inject FinanceDailyBalanceService and call applyNetChange(branchId, getPhCalendarDateString(), delta).
 */
export async function adjustDailyBalance(
  _client: { from: (table: string) => unknown },
  _branchId: string,
  _delta: number,
): Promise<void> {
  throw new InternalServerErrorException(
    'adjustDailyBalance is deprecated; use FinanceDailyBalanceService.applyNetChange',
  );
}
