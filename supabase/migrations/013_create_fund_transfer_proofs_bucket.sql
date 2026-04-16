do $$
begin
  if not exists (
    select 1
    from storage.buckets
    where id = 'fund-transfer-proofs'
  ) then
    insert into storage.buckets (id, name, public)
    values ('fund-transfer-proofs', 'fund-transfer-proofs', true);
  end if;
end
$$;

drop policy if exists "fund_transfer_proofs_insert" on storage.objects;
create policy "fund_transfer_proofs_insert"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'fund-transfer-proofs');

drop policy if exists "fund_transfer_proofs_update" on storage.objects;
create policy "fund_transfer_proofs_update"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'fund-transfer-proofs')
  with check (bucket_id = 'fund-transfer-proofs');