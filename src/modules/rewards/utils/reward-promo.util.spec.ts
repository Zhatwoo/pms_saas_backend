import {
  assertValidPromoWindow,
  isRewardWithinPromoPeriod,
  parsePromoDateInput,
  parsePromoEndDateInput,
} from './reward-promo.util';

describe('reward promo utils', () => {
  it('parses promo date inputs', () => {
    expect(parsePromoDateInput('2026-08-18')?.toISOString()).toBe(
      '2026-08-18T00:00:00.000Z',
    );
    expect(parsePromoEndDateInput('2026-08-31')?.toISOString()).toBe(
      '2026-08-31T23:59:59.999Z',
    );
  });

  it('checks whether a reward is within its promo window', () => {
    const start = parsePromoDateInput('2026-08-01');
    const end = parsePromoEndDateInput('2026-08-31');

    expect(
      isRewardWithinPromoPeriod(
        new Date('2026-08-15T12:00:00.000Z'),
        start,
        end,
      ),
    ).toBe(true);
    expect(
      isRewardWithinPromoPeriod(
        new Date('2026-07-31T23:59:59.999Z'),
        start,
        end,
      ),
    ).toBe(false);
    expect(
      isRewardWithinPromoPeriod(
        new Date('2026-09-01T00:00:00.000Z'),
        start,
        end,
      ),
    ).toBe(false);
    expect(isRewardWithinPromoPeriod(new Date(), null, null)).toBe(true);
  });

  it('rejects invalid promo windows', () => {
    expect(() =>
      assertValidPromoWindow(
        parsePromoDateInput('2026-09-01'),
        parsePromoEndDateInput('2026-08-01'),
      ),
    ).toThrow('Promo start date must be on or before the end date.');
  });
});
