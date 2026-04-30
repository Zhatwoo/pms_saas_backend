/**
 * Branch business calendar date (YYYY-MM-DD) in Asia/Manila.
 * Used for daily_balances / daily_opening so "today" matches PH operations regardless of server TZ.
 */
export function getPhCalendarDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
