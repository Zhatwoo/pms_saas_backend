export interface IncidentTicketContentSnapshot {
  title: string;
  summary: string;
  category: string;
  priority: string;
  amount_impact: number | null;
  transaction_ref: string | null;
}

const CONTENT_FIELD_LABELS: Record<keyof IncidentTicketContentSnapshot, string> =
  {
    title: 'Title',
    summary: 'Summary',
    category: 'Category',
    priority: 'Priority',
    amount_impact: 'Money Impact',
    transaction_ref: 'Transaction Reference',
  };

function formatImpact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `PHP ${value.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatValue(
  field: keyof IncidentTicketContentSnapshot,
  value: unknown,
): string {
  if (field === 'amount_impact') {
    return formatImpact(typeof value === 'number' ? value : null);
  }

  if (value == null || value === '') return '-';
  return String(value);
}

function describeChange(
  field: keyof IncidentTicketContentSnapshot,
  before: IncidentTicketContentSnapshot,
  patch: Record<string, unknown>,
): string | null {
  if (!(field in patch)) return null;

  const label = CONTENT_FIELD_LABELS[field];
  const previous = before[field];
  const next = patch[field];

  if (formatValue(field, previous) === formatValue(field, next)) {
    return null;
  }

  if (field === 'summary') {
    return `${label} updated`;
  }

  return `${label}: "${formatValue(field, previous)}" → "${formatValue(field, next)}"`;
}

export function buildIncidentEditHistory(
  before: IncidentTicketContentSnapshot,
  patch: Record<string, unknown>,
): { notes: string; changedFields: string[] } | null {
  const changedFields: string[] = [];
  const lines: string[] = [];

  for (const field of Object.keys(
    CONTENT_FIELD_LABELS,
  ) as Array<keyof IncidentTicketContentSnapshot>) {
    const change = describeChange(field, before, patch);
    if (!change) continue;
    changedFields.push(field);
    lines.push(`• ${change}`);
  }

  if (lines.length === 0) return null;

  return {
    notes: ['Updated ticket details:', ...lines].join('\n'),
    changedFields,
  };
}
