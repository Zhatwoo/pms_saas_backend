import {
  addManilaCalendarDays,
  getPhCalendarDateString,
  normalizeWallClockTimeString,
  resolveTransactionCalendarDate,
  resolveTransactionWallClockTime,
} from './branch-calendar-date.util';

describe('getPhCalendarDateString', () => {
  it('formats fixed UTC instant as Manila calendar date', () => {
    const d = new Date('2026-05-10T15:00:00.000Z');
    expect(getPhCalendarDateString(d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('normalizeWallClockTimeString', () => {
  it('formats Prisma Date TIME as HH:mm:ss', () => {
    expect(normalizeWallClockTimeString(new Date('1970-01-01T14:30:45.000Z'))).toBe(
      '14:30:45',
    );
  });

  it('zero-pads Postgres TIME strings', () => {
    expect(normalizeWallClockTimeString('9:05:00')).toBe('09:05:00');
    expect(normalizeWallClockTimeString('14:30:00.123456')).toBe('14:30:00');
  });

  it('extracts time from ISO datetime strings', () => {
    expect(normalizeWallClockTimeString('1970-01-01T08:15:30.000Z')).toBe(
      '08:15:30',
    );
  });

  it('returns null for empty or invalid input', () => {
    expect(normalizeWallClockTimeString(null)).toBeNull();
    expect(normalizeWallClockTimeString('')).toBeNull();
    expect(normalizeWallClockTimeString('not-a-time')).toBeNull();
  });
});

describe('resolveTransactionWallClockTime', () => {
  it('uses normalized client HH:mm:ss when provided', () => {
    expect(resolveTransactionWallClockTime('10:55:20')).toBe('10:55:20');
    expect(resolveTransactionWallClockTime('9:05')).toBe('09:05:00');
  });

  it('falls back to Manila wall clock when client value is invalid', () => {
    const at = new Date('2026-06-26T02:55:20.000Z');
    expect(resolveTransactionWallClockTime('bad', at)).toBe('10:55:20');
  });
});

describe('resolveTransactionCalendarDate', () => {
  it('uses validated client YYYY-MM-DD when provided', () => {
    expect(resolveTransactionCalendarDate('2026-06-26')).toBe('2026-06-26');
  });

  it('falls back to Manila calendar date when client value is invalid', () => {
    const at = new Date('2026-06-25T16:00:00.000Z');
    expect(resolveTransactionCalendarDate('invalid', at)).toBe('2026-06-26');
  });
});

describe('addManilaCalendarDays', () => {
  it('adds days across month boundaries', () => {
    expect(addManilaCalendarDays('2026-05-30', 3)).toBe('2026-06-02');
  });

  it('subtracts days', () => {
    expect(addManilaCalendarDays('2026-05-11', -1)).toBe('2026-05-10');
  });
});