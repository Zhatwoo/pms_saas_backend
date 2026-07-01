-- Allow sale items to enter transfer-pending state while inter-branch transfer is open.
alter table public.sale_items
  drop constraint if exists sale_items_status_check;

alter table public.sale_items
  add constraint sale_items_status_check
  check (
    status in (
      'Available',
      'available',
      'Sold',
      'Reserved',
      'Transfer Pending'
    )
  );

do $$
begin
  if exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'sale_status'
  ) then
    alter type public.sale_status add value if not exists 'Transfer Pending';
  end if;
end $$;
