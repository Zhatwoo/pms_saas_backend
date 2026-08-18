export function parsePromoDateInput(value?: string | null): Date | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = new Date(`${value.trim()}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parsePromoEndDateInput(value?: string | null): Date | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = new Date(`${value.trim()}T23:59:59.999Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isRewardWithinPromoPeriod(
  referenceDate: Date,
  promoStartAt?: Date | string | null,
  promoEndAt?: Date | string | null,
): boolean {
  const start = promoStartAt ? new Date(promoStartAt) : null;
  const end = promoEndAt ? new Date(promoEndAt) : null;

  if (start && !Number.isNaN(start.getTime()) && referenceDate < start) {
    return false;
  }

  if (end && !Number.isNaN(end.getTime()) && referenceDate > end) {
    return false;
  }

  return true;
}

export function assertValidPromoWindow(
  promoStartAt?: Date | null,
  promoEndAt?: Date | null,
): void {
  if (promoStartAt && promoEndAt && promoStartAt > promoEndAt) {
    throw new Error('Promo start date must be on or before the end date.');
  }
}
