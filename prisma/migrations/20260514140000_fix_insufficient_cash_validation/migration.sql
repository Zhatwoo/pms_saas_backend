-- fix-insufficient-cash-validation: remove legacy purpose CHECK that can reject journal "End"
-- (default name transactions_check) when transactions_purpose_check was added separately.
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_check;
