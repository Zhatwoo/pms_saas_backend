ALTER TABLE public.login_logs
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS login_logs_branch_id_idx
  ON public.login_logs(branch_id);
