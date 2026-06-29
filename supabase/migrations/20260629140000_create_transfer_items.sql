create table if not exists public.transfer_items (
  id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.sale_items(id) on delete restrict,
  item_id text not null,
  item_name text not null,
  source_branch_id uuid not null references public.branches(id) on delete restrict,
  target_branch_id uuid not null references public.branches(id) on delete restrict,
  requested_by_user_id uuid references public.users(id) on delete set null,
  received_by_user_id uuid references public.users(id) on delete set null,
  status text not null default 'pending',
  item_included text,
  notes text,
  requested_at timestamptz not null default now(),
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  environment varchar(20) not null default 'production',
  created_by uuid,
  constraint transfer_items_status_check check (status in ('pending', 'received', 'cancelled')),
  constraint transfer_items_distinct_branches_check check (source_branch_id <> target_branch_id)
);

create index if not exists idx_transfer_items_source_branch_status
  on public.transfer_items(source_branch_id, status, requested_at desc);

create index if not exists idx_transfer_items_target_branch_status
  on public.transfer_items(target_branch_id, status, requested_at desc);

create index if not exists idx_transfer_items_sale_item_id
  on public.transfer_items(sale_item_id);

alter table public.transactions
  drop constraint if exists transactions_purpose_check;

alter table public.transactions
  add constraint transactions_purpose_check
  check (
    purpose in (
      'Start',
      'End',
      'Buy Back',
      'Renew',
      'Sold Item',
      'Sale',
      'Pawn',
      'Cash Transfer',
      'Fund Transfer',
      'Redeem',
      'Expense',
      'Reserve / Layaway',
      'Transfer Item'
    )
  );
