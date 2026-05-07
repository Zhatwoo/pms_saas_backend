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
      'Reappraise',
      'Redeem',
      'Sold Item',
      'Sale',
      'Sales / Transfer',
      'Pawn',
      'Buy Out',
      'Reserve / Layaway',
      'Reserve',
      'Cash Transfer',
      'Fund Transfer',
      'Expense'
    )
  );

do $$
begin
  if exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'sale_status'
  ) then
    alter type public.sale_status add value if not exists 'Reserved';
  end if;
end $$;

create table if not exists public.layaway_reservations (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references public.transactions(id) on delete set null,
  related_sale_item_id uuid not null references public.sale_items(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  customer_first_name text not null,
  customer_middle_name text,
  customer_last_name text not null,
  customer_full_name text not null,
  customer_contact_number text not null,
  customer_address text not null,
  item_name text not null,
  item_code text,
  item_price numeric(12, 2) not null default 0,
  downpayment numeric(12, 2) not null default 0,
  remaining_balance numeric(12, 2) not null default 0,
  terms text,
  status text not null default 'PARTIALLY_PAID',
  processed_by_user_id uuid references public.users(id) on delete set null,
  processed_by_name text,
  reserved_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint layaway_reservations_status_check
    check (status in ('RESERVED', 'PARTIALLY_PAID', 'COMPLETED', 'CANCELLED')),
  constraint layaway_reservations_amounts_check
    check (item_price >= 0 and downpayment >= 0 and remaining_balance >= 0)
);

create unique index if not exists idx_layaway_reservations_active_sale_item
  on public.layaway_reservations(related_sale_item_id)
  where status in ('RESERVED', 'PARTIALLY_PAID');

create index if not exists idx_layaway_reservations_branch_status
  on public.layaway_reservations(branch_id, status);

create index if not exists idx_layaway_reservations_transaction
  on public.layaway_reservations(transaction_id);

create or replace function public.set_layaway_reservations_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_layaway_reservations_updated_at on public.layaway_reservations;

create trigger trg_layaway_reservations_updated_at
before update on public.layaway_reservations
for each row
execute function public.set_layaway_reservations_updated_at();
