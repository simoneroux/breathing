-- Upgrade: stats aggregation moved fully client-side (gear panel) with
-- episode-based prevented math; the legacy dashboard.html and its SQL
-- view/RPCs are gone. Run once in the Supabase SQL editor.
-- Fresh databases created from the current schema.sql don't need this.

drop view if exists site_stats;
drop function if exists last_24h_overview(uuid);
drop function if exists annualized_prediction(uuid, int);

-- Optional: research-informed per-session estimates (One Sec uses a flat,
-- conservative 3 min per prevented open; sessions actually vary ~4x between
-- platforms, e.g. TikTok ~11 min vs Instagram ~3-4 min). Uncomment to apply —
-- this OVERWRITES any values you've tuned yourself.
-- update sites set avg_minutes_saved = 11 where host = 'tiktok.com';
-- update sites set avg_minutes_saved = 4  where host in ('instagram.com', 'twitter.com', 'x.com', 'facebook.com');
-- update sites set avg_minutes_saved = 15 where host = 'youtube.com';
-- update sites set avg_minutes_saved = 4  where host in ('lapresse.ca', 'theverge.com', 'polygon.com', 'theguardian.com', 'cnn.com', 'bbc.com', 'nytimes.com', 'washingtonpost.com', 'news.google.com', 'buzzfeed.com');
