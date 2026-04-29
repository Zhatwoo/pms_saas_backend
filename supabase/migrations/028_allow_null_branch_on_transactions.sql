-- Allow system-level transactions (e.g. Super Admin expenses) that don't belong to any branch
ALTER TABLE public.transactions
  ALTER COLUMN branch_id DROP NOT NULL;
