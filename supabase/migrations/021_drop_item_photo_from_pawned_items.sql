-- Drop the legacy single-photo column now that pawned_items uses item_photos only.
ALTER TABLE public.pawned_items
DROP COLUMN IF EXISTS item_photo;

NOTIFY pgrst, 'reload schema';