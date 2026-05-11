import {
  addManilaCalendarDays,
  getPhCalendarDateString,
} from './branch-calendar-date.util';

describe('getPhCalendarDateString', () => {
  it('formats fixed UTC instant as Manila calendar date', () => {
    const d = new Date('2026-05-10T15:00:00.000Z');
    expect(getPhCalendarDateString(d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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