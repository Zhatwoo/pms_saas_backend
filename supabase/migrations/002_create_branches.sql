create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  branch_code text not null unique,
  name text not null,
  location text not null,
  status text not null default 'Active' check (status in ('Active', 'Inactive', 'Process', 'Terminated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_branches_updated_at on public.branches;
create trigger set_branches_updated_at
before update on public.branches
for each row
execute function public.set_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'branches'
  ) then
    alter publication supabase_realtime add table public.branches;
  end if;
end
$$;
