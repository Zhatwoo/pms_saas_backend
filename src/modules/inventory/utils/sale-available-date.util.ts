import { BadRequestException } from '@nestjs/common';
import { getPhCalendarDateString } from '../../../common/utils/branch-calendar-date.util';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveForSaleAvailableDate(
  clientValue?: string | null,
  fallbackDate: Date = new Date(),
): string {
  const today = getPhCalendarDateString(fallbackDate);
  const raw = String(clientValue ?? '').trim();

  if (!raw) {
    return today;
  }

  if (!ISO_DATE_RE.test(raw)) {
    throw new BadRequestException('Available date must use YYYY-MM-DD format.');
  }

  if (raw > today) {
    throw new BadRequestException('Available date cannot be in the future.');
  }

  return raw;
}
