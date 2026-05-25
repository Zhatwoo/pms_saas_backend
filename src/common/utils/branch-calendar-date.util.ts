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

/** Add whole calendar days to a YYYY-MM-DD string (civil date arithmetic in UTC components). */
export function addManilaCalendarDays(dateStr: string, deltaDays: number): string {
  const [y, mo, d] = dateStr.split('-').map((x) => parseInt(x, 10));
  const js = new Date(Date.UTC(y, mo - 1, d + deltaDays));
  const yy = js.getUTCFullYear();
  const mm = String(js.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(js.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
