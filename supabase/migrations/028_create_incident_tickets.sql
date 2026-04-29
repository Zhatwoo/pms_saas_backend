create table if not exists public.incident_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_no text not null unique,
  title text not null,
  summary text not null,
  category text not null check (
    category in (
      'missing_inventory',
      'cash_shortage',
      'opening_cash',
      'manager_escalation',
      'transaction_mismatch',
      'other'
    )
  ),
  priority text not null default 'medium' check (
    priority in ('critical', 'high', 'medium', 'low')
  ),
  status text not null default 'open' check (
    status in ('open', 'pending_review', 'escalated', 'resolved')
  ),
  source text not null default 'manual' check (
    source in ('auto', 'manual')
  ),
  branch_id uuid not null references public.branches(id) on delete restrict,
  user_id uuid references public.users(id) on delete set null,
  reported_by_user_id uuid references public.users(id) on delete set null,
  escalation_owner_user_id uuid references public.users(id) on delete set null,
  related_transaction_id text,
  transaction_ref text,
  inventory_item_ref text,
  amount_impact numeric(12, 2) check (amount_impact is null or amount_impact >= 0),
  requires_manager_escalation boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_incident_tickets_branch_id
  on public.incident_tickets (branch_id);

create index if not exists idx_incident_tickets_user_id
  on public.incident_tickets (user_id);

create index if not exists idx_incident_tickets_reported_by_user_id
  on public.incident_tickets (reported_by_user_id);

create index if not exists idx_incident_tickets_escalation_owner_user_id
  on public.incident_tickets (escalation_owner_user_id);

create index if not exists idx_incident_tickets_status
  on public.incident_tickets (status);

create index if not exists idx_incident_tickets_priority
  on public.incident_tickets (priority);

create index if not exists idx_incident_tickets_source
  on public.incident_tickets (source);

create index if not exists idx_incident_tickets_category
  on public.incident_tickets (category);

create index if not exists idx_incident_tickets_reported_at
  on public.incident_tickets (reported_at desc);

create index if not exists idx_incident_tickets_branch_status_reported_at
  on public.incident_tickets (branch_id, status, reported_at desc);

create index if not exists idx_incident_tickets_metadata_gin
  on public.incident_tickets using gin (metadata);

drop trigger if exists set_incident_tickets_updated_at on public.incident_tickets;
create trigger set_incident_tickets_updated_at
before update on public.incident_tickets
for each row
execute function public.set_updated_at();

alter table public.incident_tickets enable row level security;

drop policy if exists "Users can view relevant incident tickets" on public.incident_tickets;
create policy "Users can view relevant incident tickets"
  on public.incident_tickets
  for select
  using (
    auth.uid() in (select auth_id from public.users)
    and (
      branch_id in (select branch_id from public.users where auth_id = auth.uid())
      or user_id in (select id from public.users where auth_id = auth.uid())
      or reported_by_user_id in (select id from public.users where auth_id = auth.uid())
      or escalation_owner_user_id in (select id from public.users where auth_id = auth.uid())
      or (select role from public.users where auth_id = auth.uid()) = 'super_admin'
    )
  );

drop policy if exists "Users can insert relevant incident tickets" on public.incident_tickets;
create policy "Users can insert relevant incident tickets"
  on public.incident_tickets
  for insert
  with check (
    auth.uid() in (select auth_id from public.users)
    and (
      reported_by_user_id in (select id from public.users where auth_id = auth.uid())
      or (select role from public.users where auth_id = auth.uid()) in ('admin', 'super_admin')
    )
  );

drop policy if exists "Managers can update incident tickets" on public.incident_tickets;
create policy "Managers can update incident tickets"
  on public.incident_tickets
  for update
  using (
    auth.uid() in (select auth_id from public.users)
    and (
      branch_id in (select branch_id from public.users where auth_id = auth.uid())
      or escalation_owner_user_id in (select id from public.users where auth_id = auth.uid())
      or (select role from public.users where auth_id = auth.uid()) in ('admin', 'super_admin')
    )
  )
  with check (
    auth.uid() in (select auth_id from public.users)
    and (
      branch_id in (select branch_id from public.users where auth_id = auth.uid())
      or escalation_owner_user_id in (select id from public.users where auth_id = auth.uid())
      or (select role from public.users where auth_id = auth.uid()) in ('admin', 'super_admin')
    )
  );

drop policy if exists "Super admins can delete incident tickets" on public.incident_tickets;
create policy "Super admins can delete incident tickets"
  on public.incident_tickets
  for delete
  using (
    (select role from public.users where auth_id = auth.uid()) = 'super_admin'
  );

create or replace function public.generate_incident_ticket_no(p_branch_id uuid default null)
returns text
language plpgsql
as $$
declare
  v_branch_code text;
begin
  if p_branch_id is not null then
    select branch_code
      into v_branch_code
    from public.branches
    where id = p_branch_id;
  end if;

  return 'INC-'
    || coalesce(v_branch_code, 'GEN')
    || '-'
    || to_char(now(), 'YYYYMMDD-HH24MISSMS');
end;
$$;

create or replace function public.raise_incident_ticket(
  p_title text,
  p_summary text,
  p_category text,
  p_branch_id uuid,
  p_priority text default 'medium',
  p_source text default 'manual',
  p_user_id uuid default null,
  p_reported_by_user_id uuid default null,
  p_escalation_owner_user_id uuid default null,
  p_related_transaction_id text default null,
  p_transaction_ref text default null,
  p_inventory_item_ref text default null,
  p_amount_impact numeric default null,
  p_requires_manager_escalation boolean default false,
  p_status text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.incident_tickets
language plpgsql
security definer
as $$
declare
  v_ticket public.incident_tickets;
  v_status text;
begin
  v_status := coalesce(
    p_status,
    case
      when p_requires_manager_escalation then 'escalated'
      else 'open'
    end
  );

  insert into public.incident_tickets (
    ticket_no,
    title,
    summary,
    category,
    priority,
    status,
    source,
    branch_id,
    user_id,
    reported_by_user_id,
    escalation_owner_user_id,
    related_transaction_id,
    transaction_ref,
    inventory_item_ref,
    amount_impact,
    requires_manager_escalation,
    metadata,
    reported_at
  )
  values (
    public.generate_incident_ticket_no(p_branch_id),
    p_title,
    p_summary,
    p_category,
    p_priority,
    v_status,
    p_source,
    p_branch_id,
    p_user_id,
    p_reported_by_user_id,
    p_escalation_owner_user_id,
    p_related_transaction_id,
    p_transaction_ref,
    p_inventory_item_ref,
    p_amount_impact,
    p_requires_manager_escalation,
    coalesce(p_metadata, '{}'::jsonb),
    now()
  )
  returning *
  into v_ticket;

  return v_ticket;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'incident_tickets'
  ) then
    alter publication supabase_realtime add table public.incident_tickets;
  end if;
end
$$;
