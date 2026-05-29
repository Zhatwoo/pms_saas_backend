ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS notification_sound TEXT DEFAULT 'sound8.mp3';

UPDATE public.users
SET notification_sound = COALESCE(notification_sound, 'sound8.mp3');
