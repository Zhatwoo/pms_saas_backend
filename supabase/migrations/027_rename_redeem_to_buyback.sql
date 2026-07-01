-- Migration: Rename all "Redeem" transactions to "Buy Back"
-- This consolidates the terminology for transaction purpose only
-- Pawned item status remains "Redeemed"

-- Update all existing "Redeem" transactions to "Buy Back"
UPDATE transactions
SET purpose = 'Buy Back'
WHERE purpose = 'Redeem';

-- Note: This migration is safe to run multiple times (idempotent)
-- If a transaction is already "Buy Back", it will remain unchanged
-- Pawned items status remains "Redeemed" and is not changed
