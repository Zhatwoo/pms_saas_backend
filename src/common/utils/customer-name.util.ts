export function normalizeCustomerFullName(
  fullName: string | null | undefined,
): string {
  return (fullName ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
