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
