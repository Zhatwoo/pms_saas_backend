ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS log_id UUID;

CREATE INDEX IF NOT EXISTS idx_notifications_customer_id ON public.notifications(customer_id);
CREATE INDEX IF NOT EXISTS idx_notifications_log_id ON public.notifications(log_id);