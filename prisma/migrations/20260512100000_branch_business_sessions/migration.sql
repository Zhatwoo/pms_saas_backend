-- Branch-wide business day sessions (Manila calendar dates). Source of truth for OPEN / CLOSED / AUTO_CLOSED / PENDING_START_BALANCE.

CREATE TABLE IF NOT EXISTS public.branch_business_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_START_BALANCE',
  starting_balance DECIMAL(12, 2),
  ending_balance DECIMAL(12, 2),
  started_at TIMESTAMPTZ(6),
  ended_at TIMESTAMPTZ(6),
  started_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ended_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  auto_closed BOOLEAN NOT NULL DEFAULT false,
  locked BOOLEAN NOT NULL DEFAULT false,
  inventory_valuation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT branch_business_sessions_branch_date_key UNIQUE (branch_id, business_date)
);

CREATE INDEX IF NOT EXISTS idx_branch_business_sessions_branch_date
  ON public.branch_business_sessions (branch_id, business_date DESC);

-- Historical calendar days: derive CLOSED sessions from existing daily_balances (read-only legacy days).
WITH manila AS (
  SELECT ((now() AT TIME ZONE 'Asia/Manila'))::date AS d
),
hist AS (
  SELECT db.branch_id,
         db.record_date::date AS business_date,
         db.starting_balance,
         db.ending_balance,
         db.updated_at
  FROM public.daily_balances db
  CROSS JOIN manila m
  WHERE db.record_date::date < m.d
)
INSERT INTO public.branch_business_sessions (
  branch_id, business_date, status,
  starting_balance, ending_balance,
  locked, auto_closed, ended_at,
  created_at, updated_at
)
SELECT h.branch_id,
       h.business_date,
       'CLOSED',
       h.starting_balance,
       h.ending_balance,
       true,
       false,
       h.updated_at,
       now(),
       now()
FROM hist h
ON CONFLICT (branch_id, business_date) DO NOTHING;

-- Today (Asia/Manila): OPEN when a daily_balances row exists for this calendar date.
WITH manila AS (
  SELECT ((now() AT TIME ZONE 'Asia/Manila'))::date AS d
)
INSERT INTO public.branch_business_sessions (
  branch_id, business_date, status,
  starting_balance, ending_balance,
  locked, auto_closed,
  started_at,
  created_at, updated_at
)
SELECT db.branch_id,
       db.record_date::date,
       'OPEN',
       db.starting_balance,
       db.ending_balance,
       false,
       false,
       db.updated_at,
       now(),
       now()
FROM public.daily_balances db
CROSS JOIN manila m
WHERE db.record_date::date = m.d
ON CONFLICT (branch_id, business_date) DO NOTHING;

-- Active branches still missing today's session: OPEN if operational txs exist today, else PENDING_START_BALANCE.
WITH manila AS (
  SELECT ((now() AT TIME ZONE 'Asia/Manila'))::date AS d
)
INSERT INTO public.branch_business_sessions (
  branch_id, business_date, status,
  locked, auto_closed,
  inventory_valuation_snapshot,
  created_at, updated_at
)
SELECT b.id,
       m.d,
       CASE
         WHEN EXISTS (
           SELECT 1
           FROM public.transactions t
           WHERE t.branch_id = b.id
             AND t.transaction_date::date = m.d
             AND t.voided_at IS NULL
             AND lower(trim(t.purpose)) NOT IN ('start', 'end')
         ) THEN 'OPEN'
         ELSE 'PENDING_START_BALANCE'
       END,
       false,
       false,
       '{}'::jsonb,
       now(),
       now()
FROM public.branches b
CROSS JOIN manila m
WHERE COALESCE(b.status, '') = 'Active'
  AND NOT EXISTS (
    SELECT 1
    FROM public.branch_business_sessions s
    WHERE s.branch_id = b.id
      AND s.business_date = m.d
  );
