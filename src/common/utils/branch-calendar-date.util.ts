import { DISPLAY_TIMEZONE_IANA, normalizeIntlTimeZone } from './timezone.util';

/**
 * Branch business calendar date (YYYY-MM-DD) in Asia/Manila.
 * Used for daily_balances / daily_opening so "today" matches PH operations regardless of server TZ.
 */
export function getPhCalendarDateString(
  date: Date = new Date(),
  timeZone: string = DISPLAY_TIMEZONE_IANA,
): string {
  const tz = normalizeIntlTimeZone(timeZone);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Wall-clock time (HH:mm:ss) in Asia/Manila for `transactions.transaction_time`.
 * Avoids `Date#toTimeString()` which follows the Node server TZ (e.g. UTC → 4:00 PM at PH midnight).
 */
export function getPhWallClockTimeString(
  date: Date = new Date(),
  timeZone: string = DISPLAY_TIMEZONE_IANA,
): string {
  const tz = normalizeIntlTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${pick('hour').padStart(2, '0')}:${pick('minute').padStart(2, '0')}:${pick('second').padStart(2, '0')}`;
}

const WALL_CLOCK_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function padWallClockTime(h: string, m: string, s: string): string {
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${(s || '00').padStart(2, '0')}`;
}

/**
 * Normalize DB/API time values to HH:mm:ss for display and stable sorting.
 * Accepts Prisma Date (epoch + TIME), Postgres TIME strings, and accidental ISO fragments.
 */
export function normalizeWallClockTimeString(
  value: Date | string | null | undefined,
): string | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString().slice(11, 19);
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  const isoTail = raw.match(/T(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)/);
  if (isoTail) {
    const match = isoTail[1].match(WALL_CLOCK_TIME_RE);
    if (match) {
      return padWallClockTime(match[1], match[2], match[3] ?? '00');
    }
  }

  const direct = raw.match(WALL_CLOCK_TIME_RE);
  if (direct) {
    return padWallClockTime(direct[1], direct[2], direct[3] ?? '00');
  }

  return null;
}

export function resolveTransactionWallClockTime(
  clientValue?: string | null,
  fallbackDate: Date = new Date(),
): string {
  const normalized = normalizeWallClockTimeString(clientValue);
  if (normalized) {
    return normalized;
  }
  return getPhWallClockTimeString(fallbackDate);
}

/** YYYY-MM-DD for `transactions.transaction_date`; prefers validated client value. */
export function resolveTransactionCalendarDate(
  clientValue?: string | null,
  fallbackDate: Date = new Date(),
): string {
  const raw = String(clientValue ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  return getPhCalendarDateString(fallbackDate);
}

/** Add whole calendar days to a YYYY-MM-DD string (civil date arithmetic in UTC components). */
export function addManilaCalendarDays(dateStr: string, deltaDays: number): string {
  const [y, mo, d] = dateStr.split('-').map((x) => parseInt(x, 10));
  const js = new Date(Date.UTC(y, mo - 1, d + deltaDays));
  const yy = js.getUTCFullYear();
  const mm = String(js.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(js.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
