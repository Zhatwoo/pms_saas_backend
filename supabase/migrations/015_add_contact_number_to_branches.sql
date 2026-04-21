alter table public.branches
add column if not exists contact_number text;

update public.branches
set contact_number = '+639' || lpad(coalesce(branch_code, '0'), 9, '0')
where contact_number is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'branches_contact_number_check'
  ) then
    alter table public.branches
    add constraint branches_contact_number_check
    check (contact_number is null or contact_number ~ '^\+639\d{9}$');
  end if;
end
$$;

alter table public.branches
alter column contact_number set not null;
