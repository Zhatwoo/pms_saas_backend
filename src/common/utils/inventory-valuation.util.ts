import { Prisma } from '@prisma/client';

/** Pawn collateral counted toward branch inventory value (loan book / vault stock). */
export const INVENTORY_VALUATION_STATUSES = [
  'Active',
  'Expired',
  'Inventory',
] as const;

export type InventoryValuationMode = 'LOAN_AMOUNT' | 'APPRAISED_VALUE';

/** Shape of a single interest-rate group as stored in shop_settings.setting_value. */
export interface InterestRateGroup {
  categories?: string[];
  defaultDuration?: number;
  [key: string]: unknown;
}

/** Stringifies a Prisma.Decimal/number/string DB value for safe Decimal construction. */
function toDecimalInput(value: unknown): string {
  if (value instanceof Prisma.Decimal) return value.toString();
  if (typeof value === 'number' || typeof value === 'string')
    return String(value);
  return '0';
}

/**
 * Whether a pawned_items.status should contribute to inventory valuation totals.
 */
export function isStatusIncludedInInventoryValuation(
  status: string | null | undefined,
): boolean {
  const s = (status ?? '').trim();
  return (INVENTORY_VALUATION_STATUSES as readonly string[]).includes(s);
}

/**
 * Per-item value for dashboards: loan amount vs appraisal-style columns with safe fallbacks.
 */
export function inventoryLineValue(
  row: {
    amount: unknown;
    appraised_value?: unknown;
    estimated_resale_value?: unknown;
  },
  mode: InventoryValuationMode,
): Prisma.Decimal {
  const loan = new Prisma.Decimal(toDecimalInput(row.amount ?? 0));
  if (mode === 'LOAN_AMOUNT') {
    return loan;
  }
  const appr =
    row.appraised_value != null
      ? new Prisma.Decimal(toDecimalInput(row.appraised_value))
      : null;
  const resale =
    row.estimated_resale_value != null
      ? new Prisma.Decimal(toDecimalInput(row.estimated_resale_value))
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

  return vars1.some((v) => vars2.includes(v));
}

export function normalizeInterestRates(value: unknown): InterestRateGroup[] {
  if (Array.isArray(value)) {
    return value as InterestRateGroup[];
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.groups)) {
      return record.groups as InterestRateGroup[];
    }
    if (Array.isArray(record.rates)) {
      return record.rates as InterestRateGroup[];
    }
    // Heal legacy corruption where an array was accidentally stored as an object
    // with numeric keys, e.g. { "0": {...}, "1": {...} }. Without this, callers
    // like pawn creation see an empty list and fail to snapshot the rate group.
    const keys = Object.keys(record);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => record[k]) as InterestRateGroup[];
    }
  }
  return [];
}

export function findInterestRateGroup(
  interestRates: unknown,
  category?: string,
): InterestRateGroup | null {
  const rates = normalizeInterestRates(interestRates);
  if (!category) return null;
  return (
    rates.find((group) =>
      group.categories?.some((cat: string) =>
        categoryNamesMatch(cat, category),
      ),
    ) ?? null
  );
}

/** Pawn items within this many days of maturity are included in opening inventory QR audit. */
export const OPENING_AUDIT_PAWN_WINDOW_DAYS = 7;

export function getPawnMaturityDaysRemaining(
  pawnDate: string | Date | null | undefined,
  category: string | null | undefined,
  interestRates: unknown,
  asOf: Date = new Date(),
): number | null {
  if (!pawnDate) {
    return null;
  }

  const group = findInterestRateGroup(interestRates, category ?? undefined);
  const defaultDuration = group ? (group.defaultDuration ?? 30) : 30;
  const maturityDate = new Date(pawnDate);
  maturityDate.setDate(maturityDate.getDate() + defaultDuration);

  return Math.ceil(
    (maturityDate.getTime() - asOf.getTime()) / (1000 * 60 * 60 * 24),
  );
}

export function isPawnItemWithinOpeningAuditWindow(
  pawnDate: string | Date | null | undefined,
  category: string | null | undefined,
  interestRates: unknown,
  windowDays: number = OPENING_AUDIT_PAWN_WINDOW_DAYS,
  asOf: Date = new Date(),
): boolean {
  const daysRemaining = getPawnMaturityDaysRemaining(
    pawnDate,
    category,
    interestRates,
    asOf,
  );
  if (daysRemaining === null) {
    return false;
  }
  return daysRemaining <= windowDays;
}
