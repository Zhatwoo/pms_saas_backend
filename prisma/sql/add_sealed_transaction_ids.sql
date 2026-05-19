ALTER TABLE public.branch_day_sessions
  ADD COLUMN IF NOT EXISTS sealed_transaction_ids UUID[] NOT NULL DEFAULT '{}';
