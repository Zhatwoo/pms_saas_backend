-- Add multi-photo support for pawned items
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pawned_items'
      AND column_name = 'item_photos'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pawned_items'
        AND column_name = 'item_photos'
        AND data_type = 'text'
    ) THEN
      EXECUTE '
        ALTER TABLE public.pawned_items
        ALTER COLUMN item_photos TYPE jsonb
        USING CASE
          WHEN item_photos IS NULL OR btrim(item_photos) = '''' THEN ''[]''::jsonb
          WHEN left(btrim(item_photos), 1) = ''['' THEN item_photos::jsonb
          ELSE jsonb_build_array(item_photos)
        END
      ';
    END IF;
  ELSE
    ALTER TABLE public.pawned_items
    ADD COLUMN item_photos jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;

  ALTER TABLE public.pawned_items
  ALTER COLUMN item_photos SET DEFAULT '[]'::jsonb;

  UPDATE public.pawned_items
  SET item_photos = jsonb_build_array(item_photo)
  WHERE (item_photos IS NULL OR item_photos = '[]'::jsonb)
    AND item_photo IS NOT NULL
    AND item_photo <> '';

  UPDATE public.pawned_items
  SET item_photos = '[]'::jsonb
  WHERE item_photos IS NULL;

  ALTER TABLE public.pawned_items
  ALTER COLUMN item_photos SET NOT NULL;
END $$;

NOTIFY pgrst, 'reload schema';
