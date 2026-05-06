/**
 * Canonical transaction purpose values stored in the `transactions.purpose` column.
 *
 * Every money-moving action MUST use one of these values so that reports,
 * ledger classification, and balance adjustments all agree on semantics.
 */
export enum TransactionPurpose {
  PAWN = 'Pawn',
  REDEEM = 'Redeem',
  RENEW = 'Renew',
  REAPPRAISE = 'Reappraise',
  BUY_BACK = 'Buy Back',
  SOLD_ITEM = 'Sold Item',
  RESERVE_LAYAWAY = 'Reserve / Layaway',
  FUND_TRANSFER = 'Fund Transfer',
  CASH_TRANSFER = 'Cash Transfer',
  START = 'Start',
  END = 'End',
}

/** Purposes that represent actual business revenue (cash inflows from operations). */
export const REVENUE_PURPOSES: ReadonlySet<string> = new Set([
  TransactionPurpose.REDEEM,
  TransactionPurpose.RENEW,
  TransactionPurpose.REAPPRAISE,
  TransactionPurpose.BUY_BACK,
  TransactionPurpose.SOLD_ITEM,
  TransactionPurpose.RESERVE_LAYAWAY,
]);

/** Purposes that are journal entries, not real cash movement. */
export const JOURNAL_PURPOSES: ReadonlySet<string> = new Set([
  TransactionPurpose.START,
  TransactionPurpose.END,
]);

/** Purposes that move funds between branches (not revenue). */
export const TRANSFER_PURPOSES: ReadonlySet<string> = new Set([
  TransactionPurpose.FUND_TRANSFER,
  TransactionPurpose.CASH_TRANSFER,
]);

/**
 * Check if a purpose string (case-insensitive) is a journal entry
 * that should be excluded from sales/revenue calculations.
 */
export function isNonRevenuePurpose(purpose: string | null | undefined): boolean {
  const p = (purpose ?? '').trim();
  return JOURNAL_PURPOSES.has(p) || TRANSFER_PURPOSES.has(p) || p === TransactionPurpose.PAWN;
}
