import { Prisma } from '@prisma/client';

/** Pawn collateral counted toward branch inventory value (loan book / vault stock). */
export const INVENTORY_VALUATION_STATUSES = [
  'Active',
  'Expired',
  'Inventory',
] as const;

export type InventoryValuationMode = 'LOAN_AMOUNT' | 'APPRAISED_VALUE';

/**
 * Whether a pawned_items.status should contribute to inventory valuation totals.
 */
export function isStatusIncludedInInventoryValuation(status: string | null | undefined): boolean {
  const s = (status ?? '').trim();
  return (INVENTORY_VALUATION_STATUSES as readonly string[]).includes(s);
}

/**
 * Per-item value for dashboards: loan amount vs appraisal-style columns with safe fallbacks.
 */
export function inventoryLineValue(
  row: {
    amount: unknown;
    appraised_value?: unknown | null;
    estimated_resale_value?: unknown | null;
  },
  mode: InventoryValuationMode,
): Prisma.Decimal {
  const loan = new Prisma.Decimal(String(row.amount ?? 0));
  if (mode === 'LOAN_AMOUNT') {
    return loan;
  }
  const appr = row.appraised_value != null ? new Prisma.Decimal(String(row.appraised_value)) : null;
  const resale =
    row.estimated_resale_value != null
      ? new Prisma.Decimal(String(row.estimated_resale_value))
      : null;
  if (appr != null && !appr.equals(0)) {
    return appr;
  }
  if (resale != null && !resale.equals(0)) {
    return resale;
  }
  return loan;
}

export function categoryNamesMatch(cat1: string, cat2: string): boolean {
  const c1 = cat1.trim().toLowerCase();
  const c2 = cat2.trim().toLowerCase();
  if (c1 === c2) return true;

  const getVariations = (s: string) => {
    const vars = [s];
    if (s.endsWith('s')) {
      vars.push(s.slice(0, -1)); // cameras -> camera
    } else {
      vars.push(s + 's'); // camera -> cameras
    }
    if (s.endsWith('es')) {
      vars.push(s.slice(0, -2)); // watches -> watch
    } else {
      vars.push(s + 'es'); // watch -> watches
    }
    if (s.endsWith('ies')) {
      vars.push(s.slice(0, -3) + 'y'); // categories -> category
    }
    return vars;
  };

  const vars1 = getVariations(c1);
  const vars2 = getVariations(c2);

  return vars1.some(v => vars2.includes(v));
}

export function findInterestRateGroup(interestRates: any[], category?: string): any | null {
  if (!category) return null;
  return interestRates.find((group) =>
    group.categories?.some((cat: string) => categoryNamesMatch(cat, category))
  ) ?? null;
}
