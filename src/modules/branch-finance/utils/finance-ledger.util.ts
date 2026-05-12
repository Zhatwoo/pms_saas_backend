import { Prisma } from '@prisma/client';

/**
 * Start/End rows are journal markers only (zero cash); they must not move operational cash totals.
 */
export function isJournalPurposeStartEnd(purpose: string | null | undefined): boolean {
  const p = (purpose ?? '').trim().toLowerCase();
  return p === 'start' || p === 'end';
}

/**
 * Inbound branch cash from a fund transfer journal (matches BranchFinanceService.classifyTransaction).
 * Used to hide ledger/balance impact until the destination branch confirms receipt (fund_requests.status = transferred).
 */
export function isInboundBranchCashFundTransferRow(row: {
  purpose?: string | null;
  unit?: string | null;
  cash_in?: unknown;
  voided_at?: unknown;
}): boolean {
  if (row.voided_at != null && row.voided_at !== '') {
    return false;
  }
  const ci = Number(row.cash_in ?? 0);
  if (!Number.isFinite(ci) || ci <= 0) {
    return false;
  }
  const unit = (row.unit ?? '').toLowerCase().trim();
  const purpose = (row.purpose ?? '').toLowerCase().trim();
  return unit === 'fund_transfer' || purpose === 'cash transfer';
}

/**
 * Net cash from posted transactions: cash_in minus cash_out for non-void, non-journal rows.
 * Used for daily reconciliation and opening confirmation (same-day ops before/after confirm).
 */
export function operationalNetFromRows(
  rows: Array<{
    purpose: string;
    cash_in: unknown;
    cash_out: unknown;
    voided_at?: Date | null;
  }>,
): Prisma.Decimal {
  let net = new Prisma.Decimal(0);
  for (const r of rows) {
    if (r.voided_at != null) {
      continue;
    }
    if (isJournalPurposeStartEnd(r.purpose)) {
      continue;
    }
    const ci = new Prisma.Decimal(String(r.cash_in ?? 0));
    const co = new Prisma.Decimal(String(r.cash_out ?? 0));
    net = net.plus(ci).minus(co);
  }
  return net;
}
