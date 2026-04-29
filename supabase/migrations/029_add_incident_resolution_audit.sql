alter table public.incident_tickets
  add column if not exists resolved_by uuid references public.users(id) on delete set null,
  add column if not exists resolution_notes text,
  add column if not exists reopened_at timestamptz;

alter table public.incident_tickets
  drop constraint if exists incident_tickets_status_check;

alter table public.incident_tickets
  add constraint incident_tickets_status_check
  check (status in ('open', 'pending_review', 'escalated', 'resolved', 'reopened'));

create index if not exists idx_incident_tickets_resolved_by
  on public.incident_tickets (resolved_by);

create index if not exists idx_incident_tickets_reopened_at
  on public.incident_tickets (reopened_at desc);
