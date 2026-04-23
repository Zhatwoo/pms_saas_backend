-- Add gadget specific columns to pawned_items table
ALTER TABLE public.pawned_items 
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS items_included text,
  ADD COLUMN IF NOT EXISTS condition text,
  ADD COLUMN IF NOT EXISTS memory_storage text;
