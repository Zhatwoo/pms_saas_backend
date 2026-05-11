-- Branch finance audit: opening capital, inventory valuation fields, void tracking, finance audit log, index.
-- Apply manually if Prisma Migrate history is not synced with production (baseline drift).

ALTER TABLE "public"."branches"
  ADD COLUMN IF NOT EXISTS "opening_cash_balance" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "public"."branches"
  ADD COLUMN IF NOT EXISTS "inventory_valuation_mode" TEXT NOT NULL DEFAULT 'LOAN_AMOUNT';

ALTER TABLE "public"."pawned_items"
  ADD COLUMN IF NOT EXISTS "appraised_value" DECIMAL(15,2);
ALTER TABLE "public"."pawned_items"
  ADD COLUMN IF NOT EXISTS "estimated_resale_value" DECIMAL(15,2);

ALTER TABLE "public"."transactions"
  ADD COLUMN IF NOT EXISTS "voided_at" TIMESTAMPTZ(6);
ALTER TABLE "public"."transactions"
  ADD COLUMN IF NOT EXISTS "voided_by_user_id" UUID;

CREATE INDEX IF NOT EXISTS "idx_transactions_branch_transaction_date"
  ON "public"."transactions" ("branch_id", "transaction_date" DESC);

CREATE TABLE IF NOT EXISTS "public"."finance_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "branch_id" UUID,
  "user_id" UUID,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "ip_address" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transaction_id" UUID,
  CONSTRAINT "finance_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_finance_audit_branch_created"
  ON "public"."finance_audit_events" ("branch_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_finance_audit_event_type"
  ON "public"."finance_audit_events" ("event_type");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'finance_audit_events_branch_id_fkey'
  ) THEN
    ALTER TABLE "public"."finance_audit_events"
      ADD CONSTRAINT "finance_audit_events_branch_id_fkey"
      FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'finance_audit_events_user_id_fkey'
  ) THEN
    ALTER TABLE "public"."finance_audit_events"
      ADD CONSTRAINT "finance_audit_events_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'finance_audit_events_transaction_id_fkey'
  ) THEN
    ALTER TABLE "public"."finance_audit_events"
      ADD CONSTRAINT "finance_audit_events_transaction_id_fkey"
      FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_voided_by_user_id_fkey'
  ) THEN
    ALTER TABLE "public"."transactions"
      ADD CONSTRAINT "transactions_voided_by_user_id_fkey"
      FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
