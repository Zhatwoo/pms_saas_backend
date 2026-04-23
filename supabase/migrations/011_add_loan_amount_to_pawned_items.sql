-- Add amount to pawned_items table
ALTER TABLE public.pawned_items ADD COLUMN IF NOT EXISTS amount numeric(15, 2) DEFAULT 0;

-- Backfill existing data from the transactions table
UPDATE public.pawned_items pi
SET amount = t.pawn_amount
FROM public.transactions t
WHERE t.related_pawned_item_id = pi.id
  AND t.purpose = 'Pawn'
  AND pi.amount = 0;
