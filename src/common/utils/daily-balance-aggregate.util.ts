/**
 * Helpers for per-branch daily balance snapshots (starting vs ending, carry-forward).
 */

export type DailyBalanceRowLike = {
  branch_id: string;
  record_date: string;
  starting_balance?: number | string | null;
  ending_balance?: number | string | null;
  updated_at?: string | null;
};

export function toMoneyNumber(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return Number(val.toFixed(2));
  }
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
  }
  return 0;
}

/** For each branch_id, keep the row with the greatest record_date (ISO date string compare). */
export function pickLatestBalanceRowPerBranch<T extends DailyBalanceRowLike>(
  rows: T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (!row.branch_id) continue;
    const cur = map.get(row.branch_id);
    if (!cur || row.record_date > cur.record_date) {
      map.set(row.branch_id, row);
    }
  }
  return map;
}

export interface BranchDaySnapshot {
  startingBalance: number;
  endingBalance: number;
  recordDate: string | null;
  updatedAt: string | null;
}

/**
 * Today's opening/closing for UI and finance summaries.
 * - If a row exists for `today`: use its starting_balance / ending_balance.
 * - Else: carry prior day's ending as both (no activity recorded yet for today).
 */
export function computeBranchDaySnapshot(
  rows: DailyBalanceRowLike[],
  branchId: string,
  today: string,
  options?: { carryForward?: boolean },
): BranchDaySnapshot {
  const carryForward = options?.carryForward ?? true;
  const forBranch = rows.filter((r) => r.branch_id === branchId);
  const todayRow = forBranch.find((r) => r.record_date === today);

  if (todayRow) {
    return {
      startingBalance: toMoneyNumber(todayRow.starting_balance),
      endingBalance: toMoneyNumber(todayRow.ending_balance),
      recordDate: todayRow.record_date,
      updatedAt:
        typeof todayRow.updated_at === 'string' ? todayRow.updated_at : null,
    };
  }

  if (!carryForward) {
    return {
      startingBalance: 0,
      endingBalance: 0,
      recordDate: null,
      updatedAt: null,
    };
  }

  const prior = forBranch
    .filter((r) => r.record_date < today)
    .sort((a, b) => (a.record_date < b.record_date ? 1 : -1))[0];

  const carried = prior ? toMoneyNumber(prior.ending_balance) : 0;

  return {
    startingBalance: carried,
    endingBalance: carried,
    recordDate: prior?.record_date ?? null,
    updatedAt: typeof prior?.updated_at === 'string' ? prior.updated_at : null,
  };
}

/**
 * Build snapshot from explicit today/prior rows (correct per-branch fetch), not a global capped window.
 * When there is no today row and no prior row, uses openingCashFallback (e.g. branches.opening_cash_balance).
 */
export function buildBranchDaySnapshotFromFetched(params: {
  today: string;
  todayRow: DailyBalanceRowLike | null | undefined;
  priorRow: DailyBalanceRowLike | null | undefined;
  openingCashFallback: number;
}): BranchDaySnapshot {
  const { today, todayRow, priorRow, openingCashFallback } = params;
  if (todayRow && todayRow.record_date === today) {
    return {
      startingBalance: toMoneyNumber(todayRow.starting_balance),
      endingBalance: toMoneyNumber(todayRow.ending_balance),
      recordDate: todayRow.record_date,
      updatedAt:
        typeof todayRow.updated_at === 'string' ? todayRow.updated_at : null,
    };
  }
  const carried = priorRow
    ? toMoneyNumber(priorRow.ending_balance)
    : toMoneyNumber(openingCashFallback);
  return {
    startingBalance: carried,
    endingBalance: carried,
    recordDate: priorRow?.record_date ?? null,
    updatedAt:
      typeof priorRow?.updated_at === 'string' ? priorRow.updated_at : null,
  };
}

/** Net cash movement from ledger rows; excludes Start/End confirmations (already in daily_balances). */
export function netCashFromTransactions(
  rows: Array<{
    purpose?: string | null;
    cash_in?: unknown;
    cash_out?: unknown;
    voided_at?: string | null;
  }>,
): number {
  let net = 0;
  for (const tx of rows) {
    if (tx.voided_at != null && tx.voided_at !== '') continue;
    const p = (tx.purpose ?? '').toLowerCase().trim();
    if (p === 'start' || p === 'end') continue;
    net += toMoneyNumber(tx.cash_in) - toMoneyNumber(tx.cash_out);
  }
  return Number(net.toFixed(2));
}
