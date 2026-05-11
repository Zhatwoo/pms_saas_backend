-- Branch-scoped daily opening: one row per (branch_id, opening_date). Employee ids are audit-only.

ALTER TABLE public.daily_opening ADD COLUMN IF NOT EXISTS last_updated_by_user_id UUID;

-- Keep a single row per branch per Manila calendar day (prefer completed > pending > other).
DELETE FROM public.daily_opening d
WHERE d.id NOT IN (
  SELECT id FROM (
    SELECT DISTINCT ON (branch_id, opening_date) id
    FROM public.daily_opening
    ORDER BY branch_id, opening_date,
      CASE status WHEN 'completed' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
      updated_at DESC NULLS LAST
  ) keepers
);

ALTER TABLE public.daily_opening DROP CONSTRAINT IF EXISTS daily_opening_employee_branch_date;

DROP INDEX IF EXISTS public.daily_opening_branch_date_unique;

CREATE UNIQUE INDEX IF NOT EXISTS daily_opening_branch_date_unique
  ON public.daily_opening (branch_id, opening_date);

ALTER TABLE public.daily_opening ALTER COLUMN employee_id DROP NOT NULL;

ALTER TABLE public.daily_opening DROP CONSTRAINT IF EXISTS daily_opening_employee_id_fkey;
ALTER TABLE public.daily_opening
  ADD CONSTRAINT daily_opening_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES public.users(id)
  ON DELETE SET NULL ON UPDATE NO ACTION;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'daily_opening_last_updated_by_user_id_fkey'
  ) THEN
    ALTER TABLE public.daily_opening
      ADD CONSTRAINT daily_opening_last_updated_by_user_id_fkey
      FOREIGN KEY (last_updated_by_user_id) REFERENCES public.users(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
