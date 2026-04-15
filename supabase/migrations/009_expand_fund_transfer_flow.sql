alter table public.fund_requests
  add column if not exists flow_type text not null default 'request_based'
    check (flow_type in ('request_based', 'direct_push')),
  add column if not exists receiver_user_id uuid references public.users(id) on delete set null,
  add column if not exists source_branch_id uuid references public.branches(id) on delete set null,
  add column if not exists receiver_role text
    check (receiver_role in ('admin', 'employee')),
  add column if not exists confirmed_received_amount numeric(12, 2)
    check (confirmed_received_amount is null or confirmed_received_amount > 0),
  add column if not exists confirmation_note text,
  add column if not exists transfer_reference_no text;

create index if not exists idx_fund_requests_flow_type
  on public.fund_requests (flow_type);

create index if not exists idx_fund_requests_receiver_user_id
  on public.fund_requests (receiver_user_id);

create index if not exists idx_fund_requests_receiver_role
  on public.fund_requests (receiver_role);

create index if not exists idx_fund_requests_source_branch_id
  on public.fund_requests (source_branch_id);

create index if not exists idx_fund_requests_branch_status_created
  on public.fund_requests (branch_id, status, created_at desc);
