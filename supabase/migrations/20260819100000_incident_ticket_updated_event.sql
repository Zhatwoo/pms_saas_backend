alter table public.incident_ticket_events
  drop constraint if exists incident_ticket_events_action_check;

alter table public.incident_ticket_events
  add constraint incident_ticket_events_action_check
  check (
    action in (
      'reported',
      'assigned',
      'unassigned',
      'escalated',
      'resolved',
      'reopened',
      'updated'
    )
  );
