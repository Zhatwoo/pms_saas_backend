create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid references auth.users(id) on delete cascade,
  full_name text default '',
  email text not null,
  role text not null default 'employee' check (role in ('super_admin', 'admin', 'employee')),
  branch_id uuid references public.branches(id) on delete set null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists users_auth_id_key on public.users(auth_id);

alter table public.users enable row level security;

-- RLS Policies
drop policy if exists "Users can read own user row" on public.users;
drop policy if exists "Allow insert via trigger" on public.users;
drop policy if exists "Users can update own user row" on public.users;

-- Policy: Users can read their own profile
create policy "Users can read own user row"
  on public.users
  for select
  using (auth.uid() = auth_id);

-- Policy: Allow insert (service role and trigger bypass this)
create policy "Allow insert"
  on public.users
  for insert
  with check (true);

-- Policy: Users can update their own profile
create policy "Users can update own user row"
  on public.users
  for update
  using (auth.uid() = auth_id);

-- Trigger function to sync auth.users to public.users
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (auth_id, email, full_name, role, branch_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_app_meta_data->>'role', 'employee'),
    nullif(new.raw_app_meta_data->>'branch_id', '')::uuid
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
$$ language plpgsql security definer set search_path = public;

-- Drop and recreate trigger
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Trigger function to update timestamp
create or replace function public.set_users_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at
  before update on public.users
  for each row
  execute function public.set_users_updated_at();

-- Sync existing auth users to public.users (only those not already synced)
insert into public.users (auth_id, email, full_name, role, branch_id)
select
  au.id,
  au.email,
  coalesce(au.raw_user_meta_data->>'full_name', ''),
  case
    when coalesce(au.raw_app_meta_data->>'role', '') in ('super_admin', 'admin', 'employee') then au.raw_app_meta_data->>'role'
    when au.raw_app_meta_data->>'role' = 'superadmin' then 'super_admin'
    when au.raw_app_meta_data->>'role' = 'branch' then 'employee'
    else 'employee'
  end,
  nullif(au.raw_app_meta_data->>'branch_id', '')::uuid
from auth.users au
left join public.users pu on pu.auth_id = au.id
where pu.auth_id is null
on conflict (auth_id) do nothing;
