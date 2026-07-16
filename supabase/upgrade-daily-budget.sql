-- Upgrade for databases created before the cross-device daily unlock budget
-- (userscript v2.7.0). Fresh installs from schema.sql don't need this.
--
-- Adds the 'relocked' event type: logged when the user taps the re-lock bar
-- before an unlock expires, carrying the unused minutes in session_mins so
-- every device can compute today's spent budget as
--   sum(proceeded.session_mins) - sum(relocked.session_mins).

alter table events drop constraint if exists events_event_type_check;
alter table events add constraint events_event_type_check
  check (event_type in ('attempt', 'proceeded', 'abandoned', 'breathing', 'relocked'));
