-- Track who created pawn transactions and allow back-of-ID storage

ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS id_back_photo text;

ALTER TABLE public.pawned_items
ADD COLUMN IF NOT EXISTS id_back_photo text;