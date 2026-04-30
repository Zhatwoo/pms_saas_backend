-- Per-employee opening checklist (starting cash + workflow), one row per employee per branch per calendar day.
-- Apply in Supabase SQL editor or via supabase db push.

CREATE TABLE IF NOT EXISTS public.daily_opening (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches (id) ON DELETE CASCADE,
  opening_date DATE NOT NULL,
  starting_cash NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT daily_opening_employee_branch_date UNIQUE (employee_id, branch_id, opening_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_opening_employee_date
  ON public.daily_opening (employee_id, opening_date);

CREATE INDEX IF NOT EXISTS idx_daily_opening_branch_date
  ON public.daily_opening (branch_id, opening_date);
