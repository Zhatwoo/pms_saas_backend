alter table public.sale_items
  add column if not exists image_url text,
  add column if not exists stock_level integer default 1;
