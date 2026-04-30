-- Add customer_id to transactions and sale_items to track buyers and sale history
ALTER TABLE IF EXISTS public.transactions 
ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id);

ALTER TABLE IF EXISTS public.sale_items 
ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id);

-- Create indexes for better performance when fetching history
CREATE INDEX IF NOT EXISTS idx_transactions_customer_id ON public.transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_customer_id ON public.sale_items(customer_id);
