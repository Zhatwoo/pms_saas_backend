import { BadRequestException } from '@nestjs/common';
import { resolveForSaleAvailableDate } from './sale-available-date.util';

describe('resolveForSaleAvailableDate', () => {
  const referenceDate = new Date('2026-08-20T12:00:00.000Z');

  it('defaults to the Manila calendar date when omitted', () => {
    expect(resolveForSaleAvailableDate(undefined, referenceDate)).toBe(
      '2026-08-20',
    );
  });

  it('accepts a valid past date', () => {
    expect(resolveForSaleAvailableDate('2026-07-15', referenceDate)).toBe(
      '2026-07-15',
    );
  });

  it('accepts today', () => {
    expect(resolveForSaleAvailableDate('2026-08-20', referenceDate)).toBe(
      '2026-08-20',
    );
  });

  it('rejects future dates', () => {
    expect(() =>
      resolveForSaleAvailableDate('2026-08-21', referenceDate),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid formats', () => {
    expect(() =>
      resolveForSaleAvailableDate('08/20/2026', referenceDate),
    ).toThrow(BadRequestException);
  });
});
