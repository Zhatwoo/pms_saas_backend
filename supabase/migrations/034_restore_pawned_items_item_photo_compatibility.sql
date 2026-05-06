-- Restore the legacy single-photo column as a nullable compatibility field.
-- Older Prisma clients/processes can still select item_photo after create.
-- The application should continue to write/read item_photos for multi-photo support.
ALTER TABLE public.pawned_items
ADD COLUMN IF NOT EXISTS item_photo text;

UPDATE public.pawned_items
SET item_photo = item_photos ->> 0
WHERE item_photo IS NULL
  AND jsonb_typeof(item_photos) = 'array'
  AND jsonb_array_length(item_photos) > 0;

CREATE OR REPLACE FUNCTION public.sync_pawned_item_photos_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.item_photo IS NULL
    AND jsonb_typeof(NEW.item_photos) = 'array'
    AND jsonb_array_length(NEW.item_photos) > 0
  THEN
    NEW.item_photo := NEW.item_photos ->> 0;
  END IF;

  IF NEW.item_photo IS NOT NULL
    AND (NEW.item_photos IS NULL OR NEW.item_photos = '[]'::jsonb)
  THEN
    NEW.item_photos := jsonb_build_array(NEW.item_photo);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_pawned_item_photos_compatibility ON public.pawned_items;

CREATE TRIGGER sync_pawned_item_photos_compatibility
BEFORE INSERT OR UPDATE ON public.pawned_items
FOR EACH ROW
EXECUTE FUNCTION public.sync_pawned_item_photos_compatibility();

NOTIFY pgrst, 'reload schema';
