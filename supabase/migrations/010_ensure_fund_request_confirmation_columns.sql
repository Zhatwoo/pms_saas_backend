alter table public.fund_requests
  add column if not exists confirmed_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmation_notes text;

create index if not exists idx_fund_requests_confirmed_by_user_id
  on public.fund_requests (confirmed_by_user_id);
