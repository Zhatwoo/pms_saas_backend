-- Branch contact numbers are validated by the API before being encrypted at rest.
-- The previous database regex only allowed plaintext +639XXXXXXXXX values, so
-- encrypted inserts failed with branches_contact_number_check.
alter table public.branches
drop constraint if exists branches_contact_number_check;

alter table public.branches
alter column contact_number set not null;
