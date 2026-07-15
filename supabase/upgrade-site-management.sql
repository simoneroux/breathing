-- Upgrade for databases created before in-panel tracked-site management
-- (userscript v2.8.0). Fresh installs from schema.sql don't need this.
--
-- The stats panel now adds/removes rows in `sites` directly, and every
-- device syncs its tracked-site cache from this table. Single-tenant:
-- any signed-in user is the owner, so the policies are unconditional.

create policy "insert sites" on sites for insert to authenticated with check (true);
create policy "delete sites" on sites for delete to authenticated using (true);
