ALTER TABLE public.customers
ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_customers_branch_deleted_created
ON public.customers (branch_id, deleted_at, created_at DESC);
