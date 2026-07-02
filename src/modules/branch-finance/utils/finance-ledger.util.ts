/**
 * Start/End rows are journal markers only (zero cash); they must not move operational cash totals.
 */
export function isJournalPurposeStartEnd(
  purpose: string | null | undefined,
): boolean {
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
  return (
    unit === 'fund_transfer' ||
    purpose === 'cash transfer' ||
    purpose === 'fund transfer'
  );
}

/** Any posted fund-transfer journal row (inbound or outbound branch cash). */
export function isFundTransferBookRow(row: {
  purpose?: string | null;
  unit?: string | null;
  cash_in?: unknown;
  cash_out?: unknown;
  voided_at?: unknown;
}): boolean {
  if (row.voided_at != null && row.voided_at !== '') {
    return false;
  }
  const unit = (row.unit ?? '').toLowerCase().trim();
  const purpose = (row.purpose ?? '').toLowerCase().trim();
  return (
    unit === 'fund_transfer' ||
    unit === 'fund_transfer_out' ||
    purpose === 'cash transfer' ||
    purpose === 'fund transfer'
  );
}

/**
 * Net cash from posted transactions: cash_in minus cash_out for non-void, non-journal rows.
 * Used for daily reconciliation and opening confirmation (same-day ops before/after confirm).
 */
export function operationalNetFromRows(
  rows: Array<{
    purpose?: string | null | undefined;
    cash_in?: unknown;
    cash_out?: unknown;
    voided_at?: Date | string | null | undefined;
  }>,
): number {
  let net = 0;
  for (const r of rows) {
    if (r.voided_at != null) {
      continue;
    }
    if (isJournalPurposeStartEnd(r.purpose)) {
      continue;
    }
    const ci = Number(r.cash_in ?? 0);
    const co = Number(r.cash_out ?? 0);
    net += (Number.isFinite(ci) ? ci : 0) - (Number.isFinite(co) ? co : 0);
  }
  return Number(net.toFixed(2));
}

/** Max of basis chain, prior close + today's net, and stored daily_balances ending (pre–Start Day). */
export function mergeExpectedOpeningCashAmounts(
  basisAmount: number,
  priorClose: number,
  todayNet: number,
  todayDbEnding: number,
): number {
  const priorPlusToday = Number((priorClose + todayNet).toFixed(2));
  return Number(
    Math.max(basisAmount, priorPlusToday, todayDbEnding).toFixed(2),
  );
}
