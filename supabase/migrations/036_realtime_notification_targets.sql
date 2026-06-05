DROP TRIGGER IF EXISTS restrict_notification_update ON public.notifications;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS notification_type TEXT,
  ADD COLUMN IF NOT EXISTS target_url TEXT,
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id TEXT,
  ADD COLUMN IF NOT EXISTS event_key TEXT,
  ADD COLUMN IF NOT EXISTS target_role TEXT,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE public.notifications
SET message = COALESCE(message, subtitle),
    updated_at = COALESCE(updated_at, created_at, now())
WHERE message IS NULL
   OR updated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_key_key
  ON public.notifications(event_key);

CREATE INDEX IF NOT EXISTS idx_notifications_target_role
  ON public.notifications(target_role);

CREATE INDEX IF NOT EXISTS idx_notifications_entity
  ON public.notifications(entity_type, entity_id);

CREATE OR REPLACE FUNCTION public.prevent_notification_edit()
RETURNS trigger AS $$
DECLARE
  old_locked jsonb;
  new_locked jsonb;
BEGIN
  old_locked := to_jsonb(OLD) - 'is_read' - 'read_at' - 'updated_at';
  new_locked := to_jsonb(NEW) - 'is_read' - 'read_at' - 'updated_at';

  IF old_locked IS DISTINCT FROM new_locked THEN
    RAISE EXCEPTION 'Only notification read state can be updated';
  END IF;

  IF NEW.is_read IS TRUE AND OLD.is_read IS DISTINCT FROM TRUE THEN
    NEW.read_at := COALESCE(NEW.read_at, now());
  END IF;

  IF NEW.is_read IS DISTINCT FROM OLD.is_read OR NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER restrict_notification_update
BEFORE UPDATE ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.prevent_notification_edit();
