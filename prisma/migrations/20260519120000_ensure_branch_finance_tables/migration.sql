-- Idempotent: branch finance tables/columns required for End Day / Start Day (shift isolation).

ALTER TABLE "branch_day_sessions"
  ADD COLUMN IF NOT EXISTS "operational_cutoff_at" TIMESTAMPTZ(6);

ALTER TABLE "branch_day_sessions"
  ADD COLUMN IF NOT EXISTS "sealed_transaction_ids" UUID[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS "daily_opening" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "employee_id" UUID,
  "branch_id" UUID NOT NULL,
  "opening_date" DATE NOT NULL,
  "starting_cash" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_updated_by_user_id" UUID,
  CONSTRAINT "daily_opening_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_opening_branch_date_unique"
  ON "daily_opening" ("branch_id", "opening_date");
