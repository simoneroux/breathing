-- Upgrade for databases created before in-panel tracked-site management
-- (userscript v2.8.0) and inline site editing (v2.9.0). Fresh installs from
-- schema.sql don't need this. Idempotent: safe to re-run in full even if an
-- earlier revision of this file already created some of the policies.
--
-- The stats panel adds/removes/renames rows in `sites` directly, and every
-- device syncs its tracked-site cache from this table. Single-tenant:
-- any signed-in user is the owner, so the policies are unconditional.

drop policy if exists "insert sites" on sites;
drop policy if exists "delete sites" on sites;
drop policy if exists "update sites" on sites;
create policy "insert sites" on sites for insert to authenticated with check (true);
create policy "delete sites" on sites for delete to authenticated using (true);
create policy "update sites" on sites for update to authenticated using (true) with check (true);
