alter table public.fund_requests
  drop constraint if exists fund_requests_status_check;

alter table public.fund_requests
  add constraint fund_requests_status_check
  check (
    status in (
      'pending',
      'approved',
      'pending_confirmation',
      'rejected',
      'transferred',
      'cancelled'
    )
  );
