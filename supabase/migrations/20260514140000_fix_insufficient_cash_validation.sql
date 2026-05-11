-- fix-insufficient-cash-validation (see prisma migration of same intent)
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_check;
