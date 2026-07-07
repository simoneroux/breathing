# Breathe + Distraction Tracker

- `index.html` — the standalone box-breathing tool.
- `distraction-tracker.user.js` — a Safari userscript that intercepts a fixed list
  of distracting sites with a breathing pause, then a One Sec-style choice
  ("Continue" / "I don't want to open this"), logs everything to Supabase, and
  includes the stats dashboard (gear icon, top-right of any tracked site).
- `supabase/schema.sql` — the database schema (source of truth for the backend).
- `supabase/upgrade-*.sql` — one-off migrations for databases created from an
  older schema.sql (run in chronological order: breathing, then prevented-math).

## One-time Supabase setup

1. In your Supabase project's SQL editor, run `supabase/schema.sql`.
   (If your database was created from an older schema.sql without breathing
   tracking, run `supabase/upgrade-breathing.sql` instead of re-running it.)
2. Under Authentication → Users, create one user (email/password) for yourself —
   this is a single-user personal tool, no signup flow.
3. Grab your project URL and `anon` key from Settings → API.

## Installing the userscript (per device)

1. Install the [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887)
   Safari extension (free, works on both macOS and iOS/iPadOS) and enable it for
   Safari in System Settings / Settings → Apps → Safari → Extensions.
2. Open the raw URL of `distraction-tracker.user.js` from this repo in Safari —
   Userscripts will offer to install it directly.
3. Edit the installed script (via the extension's editor on Mac, or a file
   editor with iCloud Drive access on iOS) and fill in the `CONFIG` block at
   the top:
   ```js
   SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
   SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
   DEVICE_NAME: 'iPhone', // or 'MacBook', etc — just a label for your own debugging
   ```
4. Visit any of the tracked sites. The first interception will prompt for your
   Supabase email/password once — this signs the device in and stores a
   refreshable session locally; you won't be asked again unless you sign out
   at the Supabase project level.

## Dashboard

Tap the gear icon in the upper-right corner of any tracked site. Stats follow
the selected range (Today / 7 days / 30 days / All): attempts, prevented,
time saved, and breathing done, overall and per site.

"Prevented" counts every attempt that never led to entry — tapping
"I don't want to open this" and simply closing the tab both count, and every
attempt is unique (looping on a site twice in 5 minutes is 2 attempts, and
2 prevented if both were resisted).

Time saved is stricter, because one skipped session can't be credited twice:
a prevented attempt earns the site's `avg_minutes_saved` (from the `sites`
table) and opens a credit window of that same length. Resisted retries inside
the window add to the prevented count but not to time saved, and continuing
inside the window cancels that credit (the session happened after all).

## Editing the tracked site list or time-saved estimates

- The site list lives in two places in `distraction-tracker.user.js`: the
  `@match` header (controls where the script is allowed to run) and the
  `SITES` object (controls display names) — update both together.
- Per-site "average minutes saved per prevented visit" is stored in the
  `sites` table in Supabase, editable directly from the Supabase table editor
  without touching or redeploying the script.
