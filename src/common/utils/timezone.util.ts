/**
 * PostgreSQL accepts IANA zones (e.g. Asia/Manila) or named abbreviations — not JS-style offsets like "GMT+0800".
 * DATABASE_URL / libpq sometimes carries browser-style strings; normalize before connecting.
 */
export const DISPLAY_TIMEZONE_IANA = 'Asia/Manila' as const;

const OFFSET_LIKE = /^(?:gmt|utc)\s*\+?\s*0?8(?::00)?$/i;

/** True if the value is a known-invalid PG zone string we remap to Manila operations. */
export function isInvalidJsStyleOffsetTimezone(raw: string): boolean {
  const compact = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!compact) return false;
  if (compact === 'gmt+0800' || compact === 'gmt+08:00') return true;
  if (compact === 'utc+0800' || compact === 'utc+08:00' || compact === 'utc+8')
    return true;
  return OFFSET_LIKE.test(raw.trim());
}

/**
 * Maps invalid offset-style labels to Asia/Manila; passes through IANA and other literals unchanged.
 */
export function normalizePostgresSessionTimezone(raw: string): string {
  const t = raw.trim();
  if (!t) return 'UTC';
  if (isInvalidJsStyleOffsetTimezone(t)) return DISPLAY_TIMEZONE_IANA;
  return t;
}

/**
 * Normalizes a timezone name for Intl.DateTimeFormat (same mapping as Postgres session fixes for PH ops).
 */
export function normalizeIntlTimeZone(raw: string): string {
  const t = raw.trim();
  if (!t) return DISPLAY_TIMEZONE_IANA;
  if (isInvalidJsStyleOffsetTimezone(t)) return DISPLAY_TIMEZONE_IANA;
  return t;
}

/**
 * Fixes timezone-related query params on postgres URLs so libpq does not send invalid zone names to the server.
 */
export function sanitizePostgresConnectionStringTimezone(urlStr: string): {
  url: string;
  changed: boolean;
} {
  let changed = false;

  const patchTimezoneValue = (value: string): string => {
    const normalized = normalizePostgresSessionTimezone(value);
    if (normalized !== value) changed = true;
    return normalized;
  };

  try {
    const url = new URL(urlStr);
    for (const key of ['timezone', 'TimeZone'] as const) {
      if (!url.searchParams.has(key)) continue;
      const next = patchTimezoneValue(url.searchParams.get(key)!);
      url.searchParams.set(key, next);
    }

    const opts = url.searchParams.get('options');
    if (opts) {
      const decoded = decodeURIComponent(opts.replace(/\+/g, ' '));
      const fixed = decoded.replace(
        /\btimezone\s*=\s*([^\s&]+)/gi,
        (_m, tzVal: string) => {
          const normalized = normalizePostgresSessionTimezone(tzVal.trim());
          if (normalized !== tzVal.trim()) changed = true;
          return `timezone=${normalized}`;
        },
      );
      if (fixed !== decoded) {
        changed = true;
        url.searchParams.set('options', fixed);
      }
    }

    return { url: url.toString(), changed };
  } catch {
    let result = urlStr;
    if (/timezone\s*=\s*GMT\+0800/gi.test(result)) {
      result = result.replace(
        /timezone\s*=\s*GMT\+0800/gi,
        `timezone=${DISPLAY_TIMEZONE_IANA}`,
      );
      changed = true;
    }
    return { url: result, changed };
  }
}
