-- Inventory audit status for pawned items (verified, missing, broken, damaged)
DO $$
BEGIN
  CREATE TYPE "public"."inventory_status" AS ENUM ('verified', 'missing', 'broken', 'damaged');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "public"."pawned_items"
  ADD COLUMN IF NOT EXISTS "inventory_status" "public"."inventory_status" NOT NULL DEFAULT 'verified';
