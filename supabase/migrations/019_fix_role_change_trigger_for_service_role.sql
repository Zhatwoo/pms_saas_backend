-- Allow internal auth sync and backend service-role updates while still
-- blocking normal client sessions from changing roles directly in public.users.

drop trigger if exists restrict_role_update on public.users;
drop function if exists public.prevent_role_change();

create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  -- Updates coming from auth.users sync run through another trigger first.
  -- Those internal sync writes must be allowed so newly created admin users
  -- can be written into public.users correctly.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- Nest also performs privileged writes with the service-role key.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if exists (
    select 1
    from public.users
    where auth_id = auth.uid()
      and role = 'super_admin'
  ) then
    return new;
  end if;

  raise exception 'Only super_admin can change roles';
end;
$$;

create trigger restrict_role_update
before update on public.users
for each row
execute function public.prevent_role_change();
