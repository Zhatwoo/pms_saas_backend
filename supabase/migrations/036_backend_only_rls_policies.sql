-- Backend-only application flow:
-- Browser -> NestJS -> Prisma/Supabase service role -> Postgres.
-- These policies are defense-in-depth for any accidental direct Supabase client.

create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.users
  where auth_id = auth.uid()
  limit 1
$$;

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.users
  where auth_id = auth.uid()
  limit 1
$$;

create or replace function public.current_user_branch_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select branch_id
  from public.users
  where auth_id = auth.uid()
  limit 1
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'super_admin', false)
$$;

create or replace function public.is_branch_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'admin', false)
$$;

create or replace function public.can_access_branch(target_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_super_admin()
    or (
      target_branch_id is not null
      and public.current_user_branch_id() = target_branch_id
    )
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'users',
    'customers',
    'transactions',
    'pawned_items',
    'incident_tickets',
    'incident_ticket_events',
    'activity_logs'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('alter table public.%I force row level security', table_name);
    end if;
  end loop;
end $$;

drop policy if exists users_select_scoped on public.users;
drop policy if exists users_insert_self_or_admin_scoped on public.users;
drop policy if exists users_update_self_profile_or_admin_scoped on public.users;
drop policy if exists users_delete_super_admin_only on public.users;

create policy users_select_scoped
  on public.users
  for select
  using (
    public.is_super_admin()
    or auth.uid() = auth_id
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  );

create policy users_insert_self_or_admin_scoped
  on public.users
  for insert
  with check (
    public.is_super_admin()
    or (
      auth.uid() = auth_id
      and role = 'employee'
      and account_status in ('pending', 'active')
    )
    or (
      public.is_branch_admin()
      and role = 'employee'
      and branch_id = public.current_user_branch_id()
      and account_status in ('pending', 'active')
    )
  );

create policy users_update_self_profile_or_admin_scoped
  on public.users
  for update
  using (
    public.is_super_admin()
    or auth.uid() = auth_id
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  )
  with check (
    public.is_super_admin()
    or (
      auth.uid() = auth_id
      and role in ('employee', 'admin', 'super_admin')
      and account_status in ('pending', 'active', 'rejected')
    )
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
      and role = 'employee'
      and account_status in ('pending', 'active', 'rejected')
    )
  );

create policy users_delete_super_admin_only
  on public.users
  for delete
  using (public.is_super_admin());

drop policy if exists customers_select_scoped on public.customers;
drop policy if exists customers_insert_branch_scoped on public.customers;
drop policy if exists customers_update_branch_scoped on public.customers;
drop policy if exists customers_delete_admin_scoped on public.customers;

create policy customers_select_scoped
  on public.customers
  for select
  using (public.can_access_branch(branch_id));

create policy customers_insert_branch_scoped
  on public.customers
  for insert
  with check (public.can_access_branch(branch_id));

create policy customers_update_branch_scoped
  on public.customers
  for update
  using (public.can_access_branch(branch_id))
  with check (public.can_access_branch(branch_id));

create policy customers_delete_admin_scoped
  on public.customers
  for delete
  using (
    public.is_super_admin()
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  );

drop policy if exists pawned_items_select_scoped on public.pawned_items;
drop policy if exists pawned_items_insert_branch_scoped on public.pawned_items;
drop policy if exists pawned_items_update_branch_scoped on public.pawned_items;
drop policy if exists pawned_items_delete_admin_scoped on public.pawned_items;

create policy pawned_items_select_scoped
  on public.pawned_items
  for select
  using (public.can_access_branch(branch_id));

create policy pawned_items_insert_branch_scoped
  on public.pawned_items
  for insert
  with check (public.can_access_branch(branch_id));

create policy pawned_items_update_branch_scoped
  on public.pawned_items
  for update
  using (public.can_access_branch(branch_id))
  with check (public.can_access_branch(branch_id));

create policy pawned_items_delete_admin_scoped
  on public.pawned_items
  for delete
  using (
    public.is_super_admin()
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  );

drop policy if exists transactions_select_scoped on public.transactions;
drop policy if exists transactions_insert_branch_scoped on public.transactions;
drop policy if exists transactions_update_admin_scoped on public.transactions;
drop policy if exists transactions_delete_super_admin_only on public.transactions;

create policy transactions_select_scoped
  on public.transactions
  for select
  using (public.can_access_branch(branch_id));

create policy transactions_insert_branch_scoped
  on public.transactions
  for insert
  with check (
    public.can_access_branch(branch_id)
    and (
      created_by_user_id is null
      or created_by_user_id = public.current_app_user_id()
      or public.is_branch_admin()
      or public.is_super_admin()
    )
  );

create policy transactions_update_admin_scoped
  on public.transactions
  for update
  using (
    public.is_super_admin()
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  )
  with check (
    public.is_super_admin()
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  );

create policy transactions_delete_super_admin_only
  on public.transactions
  for delete
  using (public.is_super_admin());

drop policy if exists incident_tickets_select_scoped on public.incident_tickets;
drop policy if exists incident_tickets_insert_branch_scoped on public.incident_tickets;
drop policy if exists incident_tickets_update_admin_scoped on public.incident_tickets;
drop policy if exists incident_tickets_delete_super_admin_only on public.incident_tickets;

create policy incident_tickets_select_scoped
  on public.incident_tickets
  for select
  using (
    public.can_access_branch(branch_id)
    or user_id = public.current_app_user_id()
    or reported_by_user_id = public.current_app_user_id()
  );

create policy incident_tickets_insert_branch_scoped
  on public.incident_tickets
  for insert
  with check (
    public.can_access_branch(branch_id)
    and (
      reported_by_user_id is null
      or reported_by_user_id = public.current_app_user_id()
      or public.is_branch_admin()
      or public.is_super_admin()
    )
  );

create policy incident_tickets_update_admin_scoped
  on public.incident_tickets
  for update
  using (
    public.is_super_admin()
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  )
  with check (
    public.is_super_admin()
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  );

create policy incident_tickets_delete_super_admin_only
  on public.incident_tickets
  for delete
  using (public.is_super_admin());

drop policy if exists incident_ticket_events_select_scoped on public.incident_ticket_events;
drop policy if exists incident_ticket_events_insert_branch_scoped on public.incident_ticket_events;
drop policy if exists incident_ticket_events_update_super_admin_only on public.incident_ticket_events;
drop policy if exists incident_ticket_events_delete_super_admin_only on public.incident_ticket_events;

create policy incident_ticket_events_select_scoped
  on public.incident_ticket_events
  for select
  using (public.can_access_branch(branch_id));

create policy incident_ticket_events_insert_branch_scoped
  on public.incident_ticket_events
  for insert
  with check (
    public.can_access_branch(branch_id)
    and (
      actor_user_id is null
      or actor_user_id = public.current_app_user_id()
      or public.is_branch_admin()
      or public.is_super_admin()
    )
  );

create policy incident_ticket_events_update_super_admin_only
  on public.incident_ticket_events
  for update
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy incident_ticket_events_delete_super_admin_only
  on public.incident_ticket_events
  for delete
  using (public.is_super_admin());

drop policy if exists activity_logs_select_scoped on public.activity_logs;
drop policy if exists activity_logs_insert_self_or_admin_scoped on public.activity_logs;
drop policy if exists activity_logs_update_super_admin_only on public.activity_logs;
drop policy if exists activity_logs_delete_super_admin_only on public.activity_logs;

create policy activity_logs_select_scoped
  on public.activity_logs
  for select
  using (
    public.is_super_admin()
    or user_id = public.current_app_user_id()
    or (
      public.is_branch_admin()
      and branch_id = public.current_user_branch_id()
    )
  );

create policy activity_logs_insert_self_or_admin_scoped
  on public.activity_logs
  for insert
  with check (
    public.is_super_admin()
    or (
      branch_id = public.current_user_branch_id()
      and (
        user_id is null
        or user_id = public.current_app_user_id()
        or public.is_branch_admin()
      )
    )
  );

create policy activity_logs_update_super_admin_only
  on public.activity_logs
  for update
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy activity_logs_delete_super_admin_only
  on public.activity_logs
  for delete
  using (public.is_super_admin());
