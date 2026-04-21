-- Add primary item photo for pawned items
ALTER TABLE public.pawned_items
ADD COLUMN IF NOT EXISTS item_photo text;