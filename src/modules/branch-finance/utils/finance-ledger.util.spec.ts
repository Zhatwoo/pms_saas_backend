import {
  mergeExpectedOpeningCashAmounts,
  operationalNetFromRows,
} from './finance-ledger.util';

describe('mergeExpectedOpeningCashAmounts', () => {
  it('uses prior close + today net when basis is zero (fund transfer before Start Day)', () => {
    expect(mergeExpectedOpeningCashAmounts(0, 0, 20000, 0)).toBe(20000);
  });

  it('carries forward normal prior close with no today activity', () => {
    expect(mergeExpectedOpeningCashAmounts(16000, 16000, 0, 16000)).toBe(
      16000,
    );
  });

  it('uses last End Day closing when basis is zero (next-day Start)', () => {
    expect(mergeExpectedOpeningCashAmounts(0, 16000, 0, 0)).toBe(16000);
  });

  it('prefers todayDb ending when it is highest', () => {
    expect(mergeExpectedOpeningCashAmounts(0, 0, 1200, 20000)).toBe(20000);
  });

  it('detects genuine mismatch inputs (expected 16000 vs entered 15000 scenario)', () => {
    const expected = mergeExpectedOpeningCashAmounts(16000, 16000, 0, 16000);
    expect(expected).toBe(16000);
    expect(Math.abs(expected - 15000)).toBeGreaterThan(0.009);
  });
});

describe('operationalNetFromRows fund transfer', () => {
  it('includes confirmed inbound fund transfer rows', () => {
    const net = operationalNetFromRows([
      {
        purpose: 'fund transfer',
        unit: 'fund_transfer',
        cash_in: 20000,
        cash_out: 0,
      },
    ]);
    expect(net).toBe(20000);
  });
});
