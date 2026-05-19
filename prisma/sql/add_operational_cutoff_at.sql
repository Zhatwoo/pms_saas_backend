-- Run once on Supabase/Postgres if not using prisma migrate deploy
ALTER TABLE public.branch_day_sessions
  ADD COLUMN IF NOT EXISTS operational_cutoff_at TIMESTAMPTZ;

COMMENT ON COLUMN public.branch_day_sessions.operational_cutoff_at IS
  'Operational cash before this instant belongs to a prior shift (same Manila date).';

UPDATE public.branch_day_sessions
SET operational_cutoff_at = opened_at
WHERE operational_cutoff_at IS NULL;
