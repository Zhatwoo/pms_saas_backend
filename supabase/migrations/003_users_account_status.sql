-- public.users: required by Nest (auth profile + signup approval).
-- Runs after 002_create_branches (branch_id FK).

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid not null unique references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  role text,
  branch_id uuid references public.branches (id) on delete set null,
  avatar_url text,
  account_status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_auth_id_idx on public.users (auth_id);

alter table public.users
  add column if not exists account_status text not null default 'active';

alter table public.users
  drop constraint if exists users_account_status_check;

alter table public.users
  add constraint users_account_status_check
  check (account_status in ('pending', 'active', 'rejected'));
