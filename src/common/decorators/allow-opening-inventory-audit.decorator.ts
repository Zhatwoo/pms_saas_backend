import { SetMetadata } from '@nestjs/common';

export const ALLOW_OPENING_INVENTORY_AUDIT_KEY = 'allowOpeningInventoryAudit';

/** Inventory read/tally routes needed while the branch opening checklist is on INVENTORY_AUDIT. */
export const AllowOpeningInventoryAudit = () =>
  SetMetadata(ALLOW_OPENING_INVENTORY_AUDIT_KEY, true);
