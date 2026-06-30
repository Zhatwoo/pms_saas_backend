import {
  buildBranchDaySnapshotFromFetched,
  netCashFromTransactions,
} from './daily-balance-aggregate.util';

describe('buildBranchDaySnapshotFromFetched', () => {
  it('uses today row when present', () => {
    const snap = buildBranchDaySnapshotFromFetched({
      today: '2026-05-10',
      todayRow: {
        branch_id: 'b1',
        record_date: '2026-05-10',
        starting_balance: 100,
        ending_balance: 150,
        updated_at: '2026-05-10T01:00:00Z',
      },
      priorRow: null,
      openingCashFallback: 999,
    });
    expect(snap.startingBalance).toBe(100);
    expect(snap.endingBalance).toBe(150);
    expect(snap.recordDate).toBe('2026-05-10');
  });

  it('carries prior ending when no today row', () => {
    const snap = buildBranchDaySnapshotFromFetched({
      today: '2026-05-10',
      todayRow: null,
      priorRow: {
        branch_id: 'b1',
        record_date: '2026-05-09',
        starting_balance: 50,
        ending_balance: 200.5,
      },
      openingCashFallback: 0,
    });
    expect(snap.startingBalance).toBe(200.5);
    expect(snap.endingBalance).toBe(200.5);
    expect(snap.recordDate).toBe('2026-05-09');
  });

  it('uses opening fallback when no prior', () => {
    const snap = buildBranchDaySnapshotFromFetched({
      today: '2026-05-10',
      todayRow: null,
      priorRow: null,
      openingCashFallback: 5000,
    });
    expect(snap.startingBalance).toBe(5000);
    expect(snap.endingBalance).toBe(5000);
    expect(snap.recordDate).toBeNull();
  });
});

describe('netCashFromTransactions', () => {
  it('excludes start/end and voided', () => {
    const net = netCashFromTransactions([
      { purpose: 'Pawn', cash_in: 0, cash_out: 100 },
      { purpose: 'Start', cash_in: 0, cash_out: 0 },
      { purpose: 'Buy Back', cash_in: 50, cash_out: 0, voided_at: '2026-01-01' },
      { purpose: 'Renew', cash_in: 25, cash_out: 0 },
    ]);
    expect(net).toBe(-75);
  });
});
