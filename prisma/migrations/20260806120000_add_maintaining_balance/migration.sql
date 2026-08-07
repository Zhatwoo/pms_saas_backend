-- Add maintaining_balance column to branches for super-admin configured minimum cash threshold
ALTER TABLE "public"."branches"
  ADD COLUMN IF NOT EXISTS "maintaining_balance" DECIMAL(12, 2);