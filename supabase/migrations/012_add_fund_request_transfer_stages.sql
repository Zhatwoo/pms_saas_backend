alter table public.fund_requests
  add column if not exists transfer_mode text
    check (transfer_mode in ('cash', 'bank_transfer', 'ewallet', 'check', 'other')),
  add column if not exists source_confirmed_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists source_confirmed_at timestamptz,
  add column if not exists source_confirmation_notes text,
  add column if not exists source_confirmed_amount numeric(12, 2),
  add column if not exists source_confirmation_proof_url text,
  add column if not exists destination_confirmed_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists destination_confirmed_at timestamptz,
  add column if not exists destination_confirmation_notes text,
  add column if not exists destination_received_amount numeric(12, 2),
  add column if not exists destination_confirmation_proof_url text,
  add column if not exists confirmation_proof_url text;

alter table public.fund_requests
  drop constraint if exists fund_requests_status_check;

alter table public.fund_requests
  add constraint fund_requests_status_check
  check (
    status in (
      'pending',
      'approved',
      'pending_source_confirmation',
      'pending_confirmation',
      'rejected',
      'transferred',
      'cancelled'
    )
  );

create index if not exists idx_fund_requests_source_confirmed_by_user_id
  on public.fund_requests (source_confirmed_by_user_id);

create index if not exists idx_fund_requests_destination_confirmed_by_user_id
  on public.fund_requests (destination_confirmed_by_user_id);

create index if not exists idx_fund_requests_transfer_mode
  on public.fund_requests (transfer_mode);