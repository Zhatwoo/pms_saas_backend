-- Repairs public.users sync from auth.users for role/branch assignment.
-- Run this migration against the live Supabase project.

delete from public.users a
using public.users b
where a.ctid < b.ctid
  and a.auth_id = b.auth_id;

delete from public.users u
where u.auth_id is not null
  and not exists (
    select 1
    from auth.users au
    where au.id = u.auth_id
  );

alter table public.users enable row level security;

drop policy if exists "Users can read own profile" on public.users;
drop policy if exists "Users can read own user row" on public.users;
drop policy if exists "Users can insert own user row" on public.users;
drop policy if exists "Users can update own user row" on public.users;
drop policy if exists "Allow insert via trigger" on public.users;
drop policy if exists "Allow insert" on public.users;

create policy "Users can read own user row"
  on public.users
  for select
  using (auth.uid() = auth_id);

create policy "Allow insert"
  on public.users
  for insert
  with check (true);

create policy "Users can update own user row"
  on public.users
  for update
  using (auth.uid() = auth_id);

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_synced on auth.users;
drop function if exists public.handle_new_user();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_branch_id uuid;
begin
  v_role := lower(coalesce(new.raw_app_meta_data->>'role', 'employee'));

  if v_role = 'superadmin' then
    v_role := 'super_admin';
  elsif v_role = 'branch' then
    v_role := 'employee';
  elsif v_role not in ('super_admin', 'admin', 'employee') then
    v_role := 'employee';
  end if;

  v_branch_id := nullif(new.raw_app_meta_data->>'branch_id', '')::uuid;

  insert into public.users (auth_id, email, full_name, role, branch_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    v_role,
    v_branch_id
  )
  on conflict (auth_id) do update
  set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    branch_id = excluded.branch_id,
    updated_at = now();

  return new;
end;
$$;

create trigger on_auth_user_synced
  after insert or update of email, raw_user_meta_data, raw_app_meta_data on auth.users
  for each row execute function public.handle_new_user();

insert into public.users (auth_id, email, full_name, role, branch_id)
select
  au.id,
  au.email,
  coalesce(au.raw_user_meta_data->>'full_name', ''),
  case
    when lower(coalesce(au.raw_app_meta_data->>'role', '')) = 'superadmin' then 'super_admin'
    when lower(coalesce(au.raw_app_meta_data->>'role', '')) = 'branch' then 'employee'
    when lower(coalesce(au.raw_app_meta_data->>'role', '')) in ('super_admin', 'admin', 'employee')
      then lower(au.raw_app_meta_data->>'role')
    else 'employee'
  end,
  nullif(au.raw_app_meta_data->>'branch_id', '')::uuid
from auth.users au
left join public.users u on u.auth_id = au.id
where u.auth_id is null;

update public.users as u
set
  full_name = coalesce(nullif(u.full_name, ''), coalesce(au.raw_user_meta_data->>'full_name', '')),
  role = case
    when lower(coalesce(au.raw_app_meta_data->>'role', '')) = 'superadmin' then 'super_admin'
    when lower(coalesce(au.raw_app_meta_data->>'role', '')) = 'branch' then 'employee'
    when lower(coalesce(au.raw_app_meta_data->>'role', '')) in ('super_admin', 'admin', 'employee')
      then lower(au.raw_app_meta_data->>'role')
    else coalesce(u.role, 'employee')
  end,
  branch_id = coalesce(
    nullif(au.raw_app_meta_data->>'branch_id', '')::uuid,
    u.branch_id
  ),
  updated_at = now()
from auth.users as au
where u.auth_id = au.id;
