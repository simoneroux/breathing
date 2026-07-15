-- Distraction tracker schema.
-- Run this once in the Supabase SQL editor for your project.
-- Single-tenant (one personal user), append-only event log + light config.

-- ── events ────────────────────────────────────────────────────────────────
-- One row per interception outcome. `id` is client-generated (crypto.randomUUID())
-- so the userscript's offline retry queue can safely re-POST without double-counting
-- (see `on conflict do nothing` in the upsert the client sends).
create table events (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id),
  host text not null,
  url text,
  event_type text not null check (event_type in ('attempt', 'proceeded', 'abandoned', 'breathing', 'relocked')),
  device text,
  cycles int,        -- 'breathing' events: number of box-breathing cycles completed
  session_mins int,  -- 'proceeded': unlock duration picked; 'relocked': unused minutes refunded by an early re-lock
  client_created_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index events_user_host_idx on events (user_id, host, client_created_at desc);
create index events_user_created_idx on events (user_id, client_created_at desc);

alter table events enable row level security;

create policy "select own events" on events
  for select using (auth.uid() = user_id);
create policy "insert own events" on events
  for insert with check (auth.uid() = user_id);
-- No update/delete policy: the log is append-only by design.

-- ── sites ─────────────────────────────────────────────────────────────────
-- Display name + a tunable "time saved per prevented visit" heuristic, editable
-- straight from the Supabase table editor without touching/redeploying the script.
create table sites (
  host text primary key,
  display_name text not null,
  avg_minutes_saved numeric not null default 5
);

alter table sites enable row level security;
create policy "read sites" on sites for select using (true);
-- The tracked-site list is edited from the userscript's stats panel
-- (single-tenant: any signed-in user is the owner).
create policy "insert sites" on sites for insert to authenticated with check (true);
create policy "delete sites" on sites for delete to authenticated using (true);

insert into sites (host, display_name, avg_minutes_saved) values
  ('youtube.com', 'YouTube', 15),
  ('facebook.com', 'Facebook', 8),
  ('instagram.com', 'Instagram', 8),
  ('twitter.com', 'Twitter', 6),
  ('x.com', 'X', 6),
  ('tiktok.com', 'TikTok', 12),
  ('reddit.com', 'Reddit', 10),
  ('lapresse.ca', 'Lapresse', 5),
  ('theverge.com', 'The Verge', 5),
  ('polygon.com', 'Polygon', 5),
  ('theguardian.com', 'The Guardian', 5),
  ('news.ycombinator.com', 'Hacker News', 8),
  ('aeon.co', 'Aeon', 6),
  ('rottentomatoes.com', 'Rotten Tomatoes', 4),
  ('news.google.com', 'Google News', 5),
  ('cnn.com', 'CNN', 5),
  ('bbc.com', 'BBC', 5),
  ('nytimes.com', 'NY Times', 6),
  ('washingtonpost.com', 'Washington Post', 6),
  ('netflix.com', 'Netflix', 20),
  ('hulu.com', 'Hulu', 20),
  ('disneyplus.com', 'Disney+', 20),
  ('primevideo.com', 'Prime Video', 20),
  ('buzzfeed.com', 'BuzzFeed', 6),
  ('amazon.com', 'Amazon', 8),
  ('ebay.com', 'eBay', 8),
  ('bestbuy.com', 'Best Buy', 6)
on conflict (host) do nothing;

-- Stats aggregation lives client-side in distraction-tracker.user.js (the
-- gear panel): "prevented" is derived from attempt/proceeded episodes rather
-- than stored — an attempt episode with no proceeded event counts as
-- prevented, whether the user tapped "I don't want to open this" or just
-- closed the tab. No views/RPCs needed.
