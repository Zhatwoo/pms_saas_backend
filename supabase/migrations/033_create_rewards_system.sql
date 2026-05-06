-- =============================================================
-- 033: Customer Rewards System
-- =============================================================

-- Reward rules configured by Super Admin
CREATE TABLE IF NOT EXISTS public.rewards (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  description              TEXT DEFAULT '',
  reward_type              TEXT NOT NULL DEFAULT 'discount',          -- discount, cashback, freebie
  reward_value             NUMERIC(12,2) NOT NULL DEFAULT 0,         -- e.g. 500 for ₱500 cashback, 10 for 10% discount
  required_transaction_count INT NOT NULL DEFAULT 1,
  required_total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  transaction_type         TEXT DEFAULT NULL,                         -- NULL = any, or 'Pawn','Buy Back', etc.
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customer rewards (earned & claimed tracking)
CREATE TABLE IF NOT EXISTS public.customer_rewards (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  reward_id         UUID NOT NULL REFERENCES public.rewards(id) ON DELETE CASCADE,
  branch_id         UUID NOT NULL REFERENCES public.branches(id) ON UPDATE NO ACTION,
  status            TEXT NOT NULL DEFAULT 'earned',                   -- earned, claimed, expired
  earned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at        TIMESTAMPTZ,
  claimed_by_user_id UUID REFERENCES public.users(id) ON UPDATE NO ACTION,
  notes             TEXT DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- prevent same reward being granted twice to the same customer in the same branch
  CONSTRAINT uq_customer_reward_branch UNIQUE (customer_id, reward_id, branch_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rewards_is_active ON public.rewards (is_active);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_customer_id ON public.customer_rewards (customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_branch_id ON public.customer_rewards (branch_id);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_status ON public.customer_rewards (status);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_reward_id ON public.customer_rewards (reward_id);
