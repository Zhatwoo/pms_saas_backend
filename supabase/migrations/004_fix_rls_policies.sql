-- Ensure RLS is enabled
alter table public.users enable row level security;

-- Drop existing policies
drop policy if exists "Users can read own user row" on public.users;
drop policy if exists "Users can insert own user row" on public.users;
drop policy if exists "Users can update own user row" on public.users;

-- Only allow users to READ their own row
create policy "Users can read own user row"
  on public.users
  for select
  using (auth.uid() = auth_id);

-- Allow AUTHENTICATED users to insert (the trigger will handle it)
create policy "Allow insert via trigger"
  on public.users
  for insert
  with check (true);

-- Allow users to update their own row
create policy "Users can update own user row"
  on public.users
  for update
  using (auth.uid() = auth_id);

-- Fix trigger function (ensure it's secure definer)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- Recreate trigger
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
