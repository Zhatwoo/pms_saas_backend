-- Create categories table
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert default categories
INSERT INTO public.categories (name, description) VALUES
  ('Smartphone', 'Mobile smartphones and handheld devices'),
  ('Laptop & PC', 'Laptops, desktop computers, and computing parts'),
  ('Gaming Console', 'PlayStation, Xbox, Nintendo, and other gaming hardware'),
  ('Appliances', 'Household electrical appliances'),
  ('Cameras', 'Digital cameras, lenses, and photography equipment'),
  ('Smartwatches', 'Smartwatches and wearable fitness trackers'),
  ('Audio & Earphones', 'Headphones, earphones, and speakers'),
  ('Other Items', 'General items that do not fit standard categories'),
  ('Miscellaneous', 'Fallback category for miscellaneous pawned items')
ON CONFLICT (name) DO NOTHING;
