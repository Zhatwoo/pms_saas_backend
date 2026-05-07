-- Defense-in-depth hardening for direct Supabase client access.
-- The NestJS backend uses the service-role key and remains the trusted write path.

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

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'branches',
    'profiles',
    'users',
    'customers',
    'pawned_items',
    'transactions',
    'daily_balances',
    'activity_logs',
    'notifications',
    'fund_requests',
    'incident_tickets',
    'incident_ticket_events',
    'item_renewals',
    'layaway_reservations',
    'sale_items',
    'rewards',
    'customer_rewards',
    'shop_settings',
    'daily_opening',
    'qr_replacement_requests'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I enable row level security', table_name);
    end if;
  end loop;
end $$;

drop policy if exists "Users can read own user row" on public.users;
drop policy if exists "Users can insert own user row" on public.users;
drop policy if exists "Allow insert via trigger" on public.users;
drop policy if exists "Allow insert" on public.users;
drop policy if exists "Users can update own user row" on public.users;
drop policy if exists "Users read own or super admin reads all" on public.users;
drop policy if exists "Users update own safe profile fields" on public.users;
drop policy if exists "Super admins manage users" on public.users;

create policy "Users read own or super admin reads all"
  on public.users
  for select
  using (auth.uid() = auth_id or public.is_super_admin());

-- No INSERT/UPDATE/DELETE policies are defined for public.users. Browser
-- clients may read scoped rows only; all user creation, approval, role, status,
-- profile, and branch-assignment changes must go through the NestJS API.

create or replace function public.prevent_sensitive_user_self_update()
returns trigger
language plpgsql
as $$
begin
  if
    coalesce(auth.role(), '') = 'service_role'
    or current_user in ('postgres', 'supabase_admin')
    or pg_trigger_depth() > 1
  then
    return new;
  end if;

  if old.role is distinct from new.role then
    if not public.is_super_admin() then
      raise exception 'Only super_admin can change roles';
    end if;
  end if;

  if old.account_status is distinct from new.account_status then
    if not public.is_super_admin() then
      raise exception 'Only super_admin can change account status';
    end if;
  end if;

  if old.branch_id is distinct from new.branch_id then
    if not public.is_super_admin() then
      raise exception 'Only super_admin can change branch assignment';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists restrict_sensitive_user_self_update on public.users;
create trigger restrict_sensitive_user_self_update
before update on public.users
for each row
execute function public.prevent_sensitive_user_self_update();

create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  if
    pg_trigger_depth() > 1
    or coalesce(auth.role(), '') = 'service_role'
    or current_user in ('postgres', 'supabase_admin')
  then
    return new;
  end if;

  if public.is_super_admin() then
    return new;
  end if;

  raise exception 'Only super_admin can change roles';
end;
$$;

drop policy if exists "Users can view own notifications" on public.notifications;
create policy "Users can view own notifications"
  on public.notifications
  for select
  using (
    public.is_super_admin()
    or user_id = (select id from public.users where auth_id = auth.uid())
    or branch_id = public.current_user_branch_id()
  );

drop policy if exists "Service role writes notifications" on public.notifications;
create policy "Service role writes notifications"
  on public.notifications
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- No broad direct-client policies are added for financial tables. The API is
-- the only supported path for transactions, balances, pawned items, fund
-- requests, rewards, and audit logs.
drop policy if exists "Users can insert relevant incident tickets" on public.incident_tickets;
drop policy if exists "Managers can update incident tickets" on public.incident_tickets;
drop policy if exists "Super admins can delete incident tickets" on public.incident_tickets;
drop policy if exists "Managers can insert incident ticket events" on public.incident_ticket_events;

create or replace function public.prevent_direct_financial_mutation()
returns trigger
language plpgsql
as $$
begin
  if
    coalesce(auth.role(), '') = 'service_role'
    or current_user in ('postgres', 'supabase_admin')
  then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception 'Financial tables can only be modified through the backend API';
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'transactions',
    'daily_balances',
    'pawned_items',
    'fund_requests',
    'activity_logs',
    'notifications',
    'incident_tickets',
    'incident_ticket_events',
    'item_renewals',
    'layaway_reservations',
    'sale_items',
    'rewards',
    'customer_rewards',
    'daily_opening',
    'qr_replacement_requests'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format(
        'drop trigger if exists prevent_direct_%I_mutation on public.%I',
        table_name,
        table_name
      );
      execute format(
        'create trigger prevent_direct_%I_mutation before insert or update or delete on public.%I for each row execute function public.prevent_direct_financial_mutation()',
        table_name,
        table_name
      );
    end if;
  end loop;
end $$;
