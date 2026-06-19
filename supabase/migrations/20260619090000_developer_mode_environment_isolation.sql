-- Global Developer Mode data isolation.
-- Existing rows remain production; developer-created rows are marked development
-- by the API and protected here for accidental direct Supabase access.

alter table public.users
  add column if not exists is_developer boolean not null default false;

update public.users
set is_developer = true
where lower(email) like '%@dev.com'
  and coalesce(is_developer, false) = false;

update public.users u
set is_developer = true
from auth.users au
where u.auth_id = au.id
  and lower(coalesce(au.email, '')) like '%@dev.com';

alter table public.authorized_devices
  drop constraint if exists authorized_devices_device_fingerprint_key;

drop index if exists public.authorized_devices_device_fingerprint_key;

create unique index if not exists uq_authorized_devices_employee_fingerprint
  on public.authorized_devices(employee_id, device_fingerprint);

do $$
declare
  table_record record;
begin
  for table_record in
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
      and table_name <> 'schema_migrations'
  loop
    execute format(
      'alter table public.%I add column if not exists environment varchar(20) not null default %L',
      table_record.table_name,
      'production'
    );

    execute format(
      'alter table public.%I add column if not exists created_by uuid',
      table_record.table_name
    );

    execute format(
      'alter table public.%I drop constraint if exists %I',
      table_record.table_name,
      table_record.table_name || '_environment_check'
    );

    execute format(
      'alter table public.%I add constraint %I check (environment in (%L, %L))',
      table_record.table_name,
      table_record.table_name || '_environment_check',
      'production',
      'development'
    );

    execute format(
      'create index if not exists %I on public.%I(environment)',
      'idx_' || table_record.table_name || '_environment',
      table_record.table_name
    );

    execute format(
      'create index if not exists %I on public.%I(created_by)',
      'idx_' || table_record.table_name || '_created_by',
      table_record.table_name
    );
end loop;
end $$;

alter table public.shop_settings
  drop constraint if exists shop_settings_setting_key_key;

drop index if exists public.shop_settings_setting_key_key;

delete from public.shop_settings a
using public.shop_settings b
where a.setting_key = b.setting_key
  and a.environment = b.environment
  and a.id < b.id;

create unique index if not exists shop_settings_setting_key_environment_key
  on public.shop_settings(setting_key, environment);

update public.users
set environment = 'development'
where coalesce(is_developer, false) = true
  or lower(email) like '%@dev.com';

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

create or replace function public.current_user_is_developer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select u.is_developer or lower(u.email) like '%@dev.com'
      from public.users u
      where u.auth_id = auth.uid()
      limit 1
    ),
    false
  )
$$;

create or replace function public.current_app_environment()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_user_is_developer() then 'development'
    else 'production'
  end
$$;

create or replace function public.environment_visible(row_environment text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(row_environment, 'production') = public.current_app_environment()
$$;

create or replace function public.environment_insert_allowed(
  row_environment text,
  row_created_by uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(row_environment, 'production') = public.current_app_environment()
    and (
      public.current_app_environment() = 'production'
      or row_created_by = auth.uid()
  )
$$;

update public.authorized_devices d
set
  environment = case
    when coalesce(u.is_developer, false) or lower(u.email) like '%@dev.com'
      then 'development'
    else 'production'
  end,
  created_by = coalesce(d.created_by, u.auth_id)
from public.users u
where d.employee_id = u.id;

update public.login_logs l
set
  environment = case
    when coalesce(u.is_developer, false) or lower(u.email) like '%@dev.com'
      then 'development'
    else 'production'
  end,
  created_by = coalesce(l.created_by, u.auth_id)
from public.users u
where l.employee_id = u.id;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'branches',
    'users',
    'shop_settings',
    'customers',
    'transactions',
    'pawned_items',
    'sale_items',
    'layaway_reservations',
    'item_renewals',
    'incident_tickets',
    'incident_ticket_events',
    'activity_logs',
    'notifications',
    'authorized_devices',
    'login_logs',
    'daily_balances',
    'daily_opening',
    'branch_day_sessions',
    'branch_business_sessions',
    'finance_audit_events',
    'fund_requests',
    'customer_rewards'
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
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or auth.uid() = auth_id
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  );

create policy users_insert_self_or_admin_scoped
  on public.users
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (
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
    )
  );

create policy users_update_self_profile_or_admin_scoped
  on public.users
  for update
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or auth.uid() = auth_id
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  )
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (
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
    )
  );

create policy users_delete_super_admin_only
  on public.users
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists branches_select_scoped on public.branches;
drop policy if exists branches_insert_super_admin_scoped on public.branches;
drop policy if exists branches_update_admin_scoped on public.branches;
drop policy if exists branches_delete_super_admin_only on public.branches;

create policy branches_select_scoped
  on public.branches
  for select
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or id = public.current_user_branch_id()
    )
  );

create policy branches_insert_super_admin_scoped
  on public.branches
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and public.is_super_admin()
  );

create policy branches_update_admin_scoped
  on public.branches
  for update
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and id = public.current_user_branch_id()
      )
    )
  )
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and id = public.current_user_branch_id()
      )
    )
  );

create policy branches_delete_super_admin_only
  on public.branches
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists shop_settings_select_scoped on public.shop_settings;
drop policy if exists shop_settings_insert_admin_scoped on public.shop_settings;
drop policy if exists shop_settings_update_admin_scoped on public.shop_settings;
drop policy if exists shop_settings_delete_super_admin_only on public.shop_settings;

create policy shop_settings_select_scoped
  on public.shop_settings
  for select
  using (public.environment_visible(environment));

create policy shop_settings_insert_admin_scoped
  on public.shop_settings
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (public.is_super_admin() or public.is_branch_admin())
  );

create policy shop_settings_update_admin_scoped
  on public.shop_settings
  for update
  using (
    public.environment_visible(environment)
    and (public.is_super_admin() or public.is_branch_admin())
  )
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (public.is_super_admin() or public.is_branch_admin())
  );

create policy shop_settings_delete_super_admin_only
  on public.shop_settings
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists customers_select_scoped on public.customers;
drop policy if exists customers_insert_branch_scoped on public.customers;
drop policy if exists customers_update_branch_scoped on public.customers;
drop policy if exists customers_delete_admin_scoped on public.customers;

create policy customers_select_scoped
  on public.customers
  for select
  using (public.environment_visible(environment) and public.can_access_branch(branch_id));

create policy customers_insert_branch_scoped
  on public.customers
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and public.can_access_branch(branch_id)
  );

create policy customers_update_branch_scoped
  on public.customers
  for update
  using (public.environment_visible(environment) and public.can_access_branch(branch_id))
  with check (
    public.environment_insert_allowed(environment, created_by)
    and public.can_access_branch(branch_id)
  );

create policy customers_delete_admin_scoped
  on public.customers
  for delete
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  );

drop policy if exists pawned_items_select_scoped on public.pawned_items;
drop policy if exists pawned_items_insert_branch_scoped on public.pawned_items;
drop policy if exists pawned_items_update_branch_scoped on public.pawned_items;
drop policy if exists pawned_items_delete_admin_scoped on public.pawned_items;

create policy pawned_items_select_scoped
  on public.pawned_items
  for select
  using (public.environment_visible(environment) and public.can_access_branch(branch_id));

create policy pawned_items_insert_branch_scoped
  on public.pawned_items
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and public.can_access_branch(branch_id)
  );

create policy pawned_items_update_branch_scoped
  on public.pawned_items
  for update
  using (public.environment_visible(environment) and public.can_access_branch(branch_id))
  with check (
    public.environment_insert_allowed(environment, created_by)
    and public.can_access_branch(branch_id)
  );

create policy pawned_items_delete_admin_scoped
  on public.pawned_items
  for delete
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  );

drop policy if exists transactions_select_scoped on public.transactions;
drop policy if exists transactions_insert_branch_scoped on public.transactions;
drop policy if exists transactions_update_admin_scoped on public.transactions;
drop policy if exists transactions_delete_super_admin_only on public.transactions;

create policy transactions_select_scoped
  on public.transactions
  for select
  using (public.environment_visible(environment) and public.can_access_branch(branch_id));

create policy transactions_insert_branch_scoped
  on public.transactions
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and public.can_access_branch(branch_id)
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
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  )
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  );

create policy transactions_delete_super_admin_only
  on public.transactions
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists incident_tickets_select_scoped on public.incident_tickets;
drop policy if exists incident_tickets_insert_branch_scoped on public.incident_tickets;
drop policy if exists incident_tickets_update_admin_scoped on public.incident_tickets;
drop policy if exists incident_tickets_delete_super_admin_only on public.incident_tickets;

create policy incident_tickets_select_scoped
  on public.incident_tickets
  for select
  using (
    public.environment_visible(environment)
    and (
      public.can_access_branch(branch_id)
      or user_id = public.current_app_user_id()
      or reported_by_user_id = public.current_app_user_id()
    )
  );

create policy incident_tickets_insert_branch_scoped
  on public.incident_tickets
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and public.can_access_branch(branch_id)
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
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  )
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  );

create policy incident_tickets_delete_super_admin_only
  on public.incident_tickets
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists incident_ticket_events_select_scoped on public.incident_ticket_events;
drop policy if exists incident_ticket_events_insert_branch_scoped on public.incident_ticket_events;
drop policy if exists incident_ticket_events_update_super_admin_only on public.incident_ticket_events;
drop policy if exists incident_ticket_events_delete_super_admin_only on public.incident_ticket_events;

create policy incident_ticket_events_select_scoped
  on public.incident_ticket_events
  for select
  using (public.environment_visible(environment) and public.can_access_branch(branch_id));

create policy incident_ticket_events_insert_branch_scoped
  on public.incident_ticket_events
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and public.can_access_branch(branch_id)
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
  using (public.environment_visible(environment) and public.is_super_admin())
  with check (public.environment_insert_allowed(environment, created_by) and public.is_super_admin());

create policy incident_ticket_events_delete_super_admin_only
  on public.incident_ticket_events
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists notifications_select_scoped on public.notifications;
drop policy if exists notifications_insert_scoped on public.notifications;
drop policy if exists notifications_update_scoped on public.notifications;
drop policy if exists notifications_delete_super_admin_only on public.notifications;

create policy notifications_select_scoped
  on public.notifications
  for select
  using (
    (
      environment = 'development'
      and public.current_user_is_developer()
      and created_by = auth.uid()
    )
    or (
      environment = 'production'
      and not public.current_user_is_developer()
      and (
        user_id = public.current_app_user_id()
        or (
          user_id is null
          and (
            public.is_super_admin()
            or branch_id = public.current_user_branch_id()
            or branch_id is null
          )
        )
      )
    )
  );

create policy notifications_insert_scoped
  on public.notifications
  for insert
  with check (public.environment_insert_allowed(environment, created_by));

create policy notifications_update_scoped
  on public.notifications
  for update
  using (public.environment_visible(environment))
  with check (public.environment_insert_allowed(environment, created_by));

create policy notifications_delete_super_admin_only
  on public.notifications
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists activity_logs_select_scoped on public.activity_logs;
drop policy if exists activity_logs_insert_self_or_admin_scoped on public.activity_logs;
drop policy if exists activity_logs_update_super_admin_only on public.activity_logs;
drop policy if exists activity_logs_delete_super_admin_only on public.activity_logs;

create policy activity_logs_select_scoped
  on public.activity_logs
  for select
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or user_id = public.current_app_user_id()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  );

create policy activity_logs_insert_self_or_admin_scoped
  on public.activity_logs
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (
      public.is_super_admin()
      or (
        branch_id = public.current_user_branch_id()
        and (
          user_id is null
          or user_id = public.current_app_user_id()
          or public.is_branch_admin()
        )
      )
    )
  );

create policy activity_logs_update_super_admin_only
  on public.activity_logs
  for update
  using (public.environment_visible(environment) and public.is_super_admin())
  with check (public.environment_insert_allowed(environment, created_by) and public.is_super_admin());

create policy activity_logs_delete_super_admin_only
  on public.activity_logs
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists authorized_devices_select_scoped on public.authorized_devices;
drop policy if exists authorized_devices_insert_scoped on public.authorized_devices;
drop policy if exists authorized_devices_update_admin_scoped on public.authorized_devices;
drop policy if exists authorized_devices_delete_super_admin_only on public.authorized_devices;

create policy authorized_devices_select_scoped
  on public.authorized_devices
  for select
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or employee_id = public.current_app_user_id()
      or (
        public.is_branch_admin()
        and (
          branch_id = public.current_user_branch_id()
          or exists (
            select 1
            from public.users u
            where u.id = authorized_devices.employee_id
              and u.branch_id = public.current_user_branch_id()
          )
        )
      )
    )
  );

create policy authorized_devices_insert_scoped
  on public.authorized_devices
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (
      public.is_super_admin()
      or employee_id = public.current_app_user_id()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  );

create policy authorized_devices_update_admin_scoped
  on public.authorized_devices
  for update
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  )
  with check (
    public.environment_insert_allowed(environment, created_by)
    and (
      public.is_super_admin()
      or (
        public.is_branch_admin()
        and branch_id = public.current_user_branch_id()
      )
    )
  );

create policy authorized_devices_delete_super_admin_only
  on public.authorized_devices
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());

drop policy if exists login_logs_select_scoped on public.login_logs;
drop policy if exists login_logs_insert_scoped on public.login_logs;
drop policy if exists login_logs_update_super_admin_only on public.login_logs;
drop policy if exists login_logs_delete_super_admin_only on public.login_logs;

create policy login_logs_select_scoped
  on public.login_logs
  for select
  using (
    public.environment_visible(environment)
    and (
      public.is_super_admin()
      or employee_id = public.current_app_user_id()
      or (
        public.is_branch_admin()
        and exists (
          select 1
          from public.users u
          where u.id = login_logs.employee_id
            and u.branch_id = public.current_user_branch_id()
        )
      )
    )
  );

create policy login_logs_insert_scoped
  on public.login_logs
  for insert
  with check (
    public.environment_insert_allowed(environment, created_by)
    or (
      environment = 'production'
      and created_by is null
      and employee_id is null
    )
  );

create policy login_logs_update_super_admin_only
  on public.login_logs
  for update
  using (public.environment_visible(environment) and public.is_super_admin())
  with check (public.environment_insert_allowed(environment, created_by) and public.is_super_admin());

create policy login_logs_delete_super_admin_only
  on public.login_logs
  for delete
  using (public.environment_visible(environment) and public.is_super_admin());
