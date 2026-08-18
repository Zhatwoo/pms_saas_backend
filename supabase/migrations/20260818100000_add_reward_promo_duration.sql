-- Add optional promo duration window for reward rules
ALTER TABLE public.rewards
  ADD COLUMN IF NOT EXISTS promo_start_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS promo_end_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_rewards_promo_window
  ON public.rewards (promo_start_at, promo_end_at);
