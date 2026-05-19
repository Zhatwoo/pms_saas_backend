-- Add operational_cutoff_at and sealed_transaction_ids to branch_day_sessions
-- Required for multi-shift same-day session isolation (per-shift balance & transaction list)

ALTER TABLE "branch_day_sessions"
  ADD COLUMN IF NOT EXISTS "operational_cutoff_at" TIMESTAMPTZ(6);

ALTER TABLE "branch_day_sessions"
  ADD COLUMN IF NOT EXISTS "sealed_transaction_ids" UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN "branch_day_sessions"."operational_cutoff_at" IS
  'Cash in/out before this instant belongs to a prior shift (same Manila date). Set on each Start Day.';

COMMENT ON COLUMN "branch_day_sessions"."sealed_transaction_ids" IS
  'Operational transaction ids already booked before this shift (excluded from net). Set on each Start Day.';
