/** Stored in branch_business_sessions.status (Manila business day lifecycle). */
export const BranchSessionStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  AUTO_CLOSED: 'AUTO_CLOSED',
  PENDING_START_BALANCE: 'PENDING_START_BALANCE',
} as const;

export type BranchSessionStatusValue =
  (typeof BranchSessionStatus)[keyof typeof BranchSessionStatus];
