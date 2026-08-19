drop policy if exists "Creators can update their incident tickets" on public.incident_tickets;

create policy "Creators can update their incident tickets"
  on public.incident_tickets
  for update
  using (
    auth.uid() in (select auth_id from public.users)
    and reported_by_user_id in (select id from public.users where auth_id = auth.uid())
    and status <> 'resolved'
  )
  with check (
    auth.uid() in (select auth_id from public.users)
    and reported_by_user_id in (select id from public.users where auth_id = auth.uid())
    and status <> 'resolved'
  );
