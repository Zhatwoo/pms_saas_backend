import {
  DISPLAY_TIMEZONE_IANA,
  isInvalidJsStyleOffsetTimezone,
  normalizeIntlTimeZone,
  normalizePostgresSessionTimezone,
  sanitizePostgresConnectionStringTimezone,
} from './timezone.util';

describe('timezone.util', () => {
  it('normalizes GMT+0800-style labels to Asia/Manila', () => {
    expect(normalizePostgresSessionTimezone('GMT+0800')).toBe(
      DISPLAY_TIMEZONE_IANA,
    );
    expect(normalizeIntlTimeZone('gmt+0800')).toBe(DISPLAY_TIMEZONE_IANA);
  });

  it('leaves IANA zones unchanged', () => {
    expect(normalizePostgresSessionTimezone('Asia/Singapore')).toBe(
      'Asia/Singapore',
    );
  });

  it('detects JS-style offset strings', () => {
    expect(isInvalidJsStyleOffsetTimezone('GMT+0800')).toBe(true);
    expect(isInvalidJsStyleOffsetTimezone('Asia/Manila')).toBe(false);
  });

  it('sanitizes postgres URL timezone query params', () => {
    const raw =
      'postgresql://u:p@localhost:5432/db?timezone=GMT%2B0800&sslmode=require';
    const { url, changed } = sanitizePostgresConnectionStringTimezone(raw);
    expect(changed).toBe(true);
    expect(url).toContain(`timezone=${encodeURIComponent(DISPLAY_TIMEZONE_IANA)}`);
  });
});
