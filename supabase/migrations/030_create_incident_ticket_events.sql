create table if not exists public.incident_ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.incident_tickets(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  action text not null check (
    action in (
      'reported',
      'assigned',
      'unassigned',
      'escalated',
      'resolved',
      'reopened'
    )
  ),
  actor_user_id uuid references public.users(id) on delete set null,
  subject_user_id uuid references public.users(id) on delete set null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_incident_ticket_events_ticket_created
  on public.incident_ticket_events (ticket_id, created_at desc);

create index if not exists idx_incident_ticket_events_branch_created
  on public.incident_ticket_events (branch_id, created_at desc);

alter table public.incident_ticket_events enable row level security;

drop policy if exists "Users can view relevant incident ticket events" on public.incident_ticket_events;
create policy "Users can view relevant incident ticket events"
  on public.incident_ticket_events
  for select
  using (
    auth.uid() in (select auth_id from public.users)
    and (
      branch_id in (select branch_id from public.users where auth_id = auth.uid())
      or (select role from public.users where auth_id = auth.uid()) = 'super_admin'
      or ticket_id in (
        select id
        from public.incident_tickets
        where reported_by_user_id in (select id from public.users where auth_id = auth.uid())
      )
    )
  );

drop policy if exists "Managers can insert incident ticket events" on public.incident_ticket_events;
create policy "Managers can insert incident ticket events"
  on public.incident_ticket_events
  for insert
  with check (
    auth.uid() in (select auth_id from public.users)
    and (
      branch_id in (select branch_id from public.users where auth_id = auth.uid())
      or (select role from public.users where auth_id = auth.uid()) in ('admin', 'super_admin')
    )
  );
