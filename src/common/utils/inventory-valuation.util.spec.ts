import {
  INVENTORY_VALUATION_STATUSES,
  inventoryLineValue,
  isStatusIncludedInInventoryValuation,
} from './inventory-valuation.util';

describe('inventory valuation', () => {
  it('includes expected statuses', () => {
    expect(INVENTORY_VALUATION_STATUSES).toContain('Active');
    expect(INVENTORY_VALUATION_STATUSES).toContain('Expired');
    expect(isStatusIncludedInInventoryValuation('Redeemed')).toBe(false);
    expect(isStatusIncludedInInventoryValuation('Active')).toBe(true);
  });

  it('LOAN_AMOUNT uses amount', () => {
    const v = inventoryLineValue(
      { amount: 1000, appraised_value: 5000, estimated_resale_value: 3000 },
      'LOAN_AMOUNT',
    );
    expect(Number(v)).toBe(1000);
  });

  it('APPRAISED_VALUE prefers appraised then resale then loan', () => {
    expect(
      Number(
        inventoryLineValue(
          { amount: 100, appraised_value: 400, estimated_resale_value: 300 },
          'APPRAISED_VALUE',
        ),
      ),
    ).toBe(400);
    expect(
      Number(
        inventoryLineValue(
          { amount: 100, appraised_value: null, estimated_resale_value: 300 },
          'APPRAISED_VALUE',
        ),
      ),
    ).toBe(300);
    expect(
      Number(
        inventoryLineValue(
          { amount: 100, appraised_value: 0, estimated_resale_value: 0 },
          'APPRAISED_VALUE',
        ),
      ),
    ).toBe(100);
  });
});
