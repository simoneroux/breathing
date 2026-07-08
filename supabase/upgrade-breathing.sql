-- Upgrade for databases created from the original schema.sql:
-- adds breathing tracking ('breathing' event type + cycle count) and the
-- unlock duration picked on "Continue". Run once in the Supabase SQL editor.
-- Fresh databases don't need this — schema.sql already includes it all.

alter table events add column if not exists cycles int;
alter table events add column if not exists session_mins int;

alter table events drop constraint events_event_type_check;
alter table events add constraint events_event_type_check
  check (event_type in ('attempt', 'proceeded', 'abandoned', 'breathing'));
