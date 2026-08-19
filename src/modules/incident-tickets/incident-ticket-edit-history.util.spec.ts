import { buildIncidentEditHistory } from './incident-ticket-edit-history.util';

describe('buildIncidentEditHistory', () => {
  const before = {
    title: 'Missing watch',
    summary: 'Original summary',
    category: 'missing_inventory',
    priority: 'medium',
    amount_impact: 4500,
    transaction_ref: 'TX-100',
  };

  it('returns null when patch does not change content', () => {
    expect(
      buildIncidentEditHistory(before, {
        title: 'Missing watch',
        summary: 'Original summary',
      }),
    ).toBeNull();
  });

  it('builds readable notes for changed fields', () => {
    const result = buildIncidentEditHistory(before, {
      title: 'Missing luxury watch',
      summary: 'Updated summary text',
      priority: 'high',
      amount_impact: 5000,
    });

    expect(result).toEqual({
      changedFields: ['title', 'summary', 'priority', 'amount_impact'],
      notes: [
        'Updated ticket details:',
        '• Title: "Missing watch" → "Missing luxury watch"',
        '• Summary updated',
        '• Priority: "medium" → "high"',
        '• Money Impact: "PHP 4,500.00" → "PHP 5,000.00"',
      ].join('\n'),
    });
  });
});
