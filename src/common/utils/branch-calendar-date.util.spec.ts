import {
  addManilaCalendarDays,
  getPhCalendarDateString,
  normalizeWallClockTimeString,
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

describe('addManilaCalendarDays', () => {
  it('adds days across month boundaries', () => {
    expect(addManilaCalendarDays('2026-05-30', 3)).toBe('2026-06-02');
  });

  it('subtracts days', () => {
    expect(addManilaCalendarDays('2026-05-11', -1)).toBe('2026-05-10');
  });
});