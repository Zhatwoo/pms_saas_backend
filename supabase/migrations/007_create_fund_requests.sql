create table if not exists public.fund_requests (
  id uuid primary key default gen_random_uuid(),
  request_no text not null unique,
  branch_id uuid not null references public.branches(id) on delete restrict,
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  amount_requested numeric(12, 2) not null check (amount_requested > 0),
  purpose text not null,
  notes text,
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'rejected', 'transferred', 'cancelled')
  ),
  approved_amount numeric(12, 2),
  reviewed_by_user_id uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  amount_transferred numeric(12, 2),
  transferred_by_user_id uuid references public.users(id) on delete set null,
  transferred_at timestamptz,
  transfer_reference text,
  transfer_notes text,
  related_transaction_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'transactions'
  ) and not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'fund_requests'
      and constraint_name = 'fund_requests_related_transaction_id_fkey'
  ) then
    alter table public.fund_requests
      add constraint fund_requests_related_transaction_id_fkey
      foreign key (related_transaction_id)
      references public.transactions(id)
      on delete set null;
  end if;
end
$$;

create index if not exists idx_fund_requests_branch_id
  on public.fund_requests (branch_id);

create index if not exists idx_fund_requests_requested_by_user_id
  on public.fund_requests (requested_by_user_id);

create index if not exists idx_fund_requests_status
  on public.fund_requests (status);

create index if not exists idx_fund_requests_created_at
  on public.fund_requests (created_at desc);

drop trigger if exists set_fund_requests_updated_at on public.fund_requests;
create trigger set_fund_requests_updated_at
before update on public.fund_requests
for each row
execute function public.set_updated_at();
