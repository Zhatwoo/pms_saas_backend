-- Create bucket for photos if it doesn't exist
-- Note: Supabase buckets are usually managed via UI or API, but we can assume its existence or use this as a reminder.

-- Alter transactions table to include photo columns
ALTER TABLE public.transactions 
ADD COLUMN IF NOT EXISTS profile_photo text,
ADD COLUMN IF NOT EXISTS id_photo text;

-- Alter pawned_items table to include photo columns and remove old ones
ALTER TABLE public.pawned_items
ADD COLUMN IF NOT EXISTS profile_photo text,
ADD COLUMN IF NOT EXISTS id_photo text,
DROP COLUMN IF EXISTS original_photo;
