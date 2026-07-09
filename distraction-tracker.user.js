// ==UserScript==
// @name         Distraction Tracker
// @namespace    mindful.distraction-tracker
// @version      2.3.0
// @description  Box-breathing friction + Supabase-backed distraction tracking, One Sec style.
// @author       Simon Roux
// @homepageURL  https://github.com/simoneroux/breathing
// @updateURL    https://raw.githubusercontent.com/simoneroux/breathing/main/distraction-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/simoneroux/breathing/main/distraction-tracker.user.js
// @match        *://*.youtube.com/*
// @match        *://youtube.com/*
// @match        *://*.facebook.com/*
// @match        *://facebook.com/*
// @match        *://*.instagram.com/*
// @match        *://instagram.com/*
// @match        *://*.twitter.com/*
// @match        *://twitter.com/*
// @match        *://*.x.com/*
// @match        *://x.com/*
// @match        *://*.tiktok.com/*
// @match        *://tiktok.com/*
// @match        *://*.reddit.com/*
// @match        *://reddit.com/*
// @match        *://*.lapresse.ca/*
// @match        *://*.theverge.com/*
// @match        *://*.polygon.com/*
// @match        *://*.theguardian.com/*
// @match        *://news.ycombinator.com/*
// @match        *://aeon.co/*
// @match        *://*.rottentomatoes.com/*
// @match        *://news.google.com/*
// @match        *://*.cnn.com/*
// @match        *://cnn.com/*
// @match        *://*.bbc.com/*
// @match        *://*.nytimes.com/*
// @match        *://*.washingtonpost.com/*
// @match        *://*.netflix.com/*
// @match        *://netflix.com/*
// @match        *://*.hulu.com/*
// @match        *://hulu.com/*
// @match        *://*.disneyplus.com/*
// @match        *://disneyplus.com/*
// @match        *://*.primevideo.com/*
// @match        *://*.buzzfeed.com/*
// @match        *://*.amazon.com/*
// @match        *://amazon.com/*
// @match        *://*.ebay.com/*
// @match        *://ebay.com/*
// @match        *://*.bestbuy.com/*
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.addStyle
// @connect      wqdktvfwbjumkgvcijux.supabase.co
// @run-at       document-start
// @noframes
// ==/UserScript==

// Companion to index.html's manual breathing tool (canonical visual language:
// colors, box+dot+circle, 5s phases — see that file if the two ever need to
// be kept in sync). This script intercepts a fixed list of distracting sites,
// forces a short box-breathing pause, then offers a One Sec-style choice
// ("Continue" / "I don't want to open this") and logs the outcome to
// Supabase so it can be reviewed across devices in the in-page stats
// panel (gear icon, top right of any tracked site).
//
// Styling is injected exclusively via GM.addStyle (not a manually appended
// <style> tag) and all visual state changes are done via classList toggles,
// never inline style properties — this is deliberate, so the overlay still
// renders correctly on sites with a strict CSP (style-src/script-src) that
// would otherwise block content injected directly into the page.

(async () => {
  'use strict';

  const CONFIG = {
    SUPABASE_URL: 'https://wqdktvfwbjumkgvcijux.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_P9w1-Ounnn1UYy3KXe8udA_qJw3Ng6q',
    // Optional device label for debugging cross-device sync ('' = auto-detect
    // from the platform). Leave as '' — auto-updates from @updateURL overwrite
    // any manual edits to this file, so per-device edits don't survive.
    DEVICE_NAME: '',
    UNLOCK_MAX_MINS: 20,     // dial maximum on "Continue"
    UNLOCK_DEFAULT_MINS: 5,  // dial starting position
    MORE_CYCLES_OPTIONS: [1, 2, 3, 4], // cycle-count choices for "More breathing"
    BREATH_CYCLES: 1,   // box-breathing cycles before the choice screen shows
    PHASE_MS: 5000,
  };

  // Canonical display names for the intercepted sites. The @match list above
  // controls where the script is allowed to run at all (the Safari extension
  // permission surface); this map controls display names shown in the
  // overlay. Keep both lists in sync when adding/removing a site.
  const SITES = {
    'youtube.com': 'YouTube',
    'facebook.com': 'Facebook',
    'instagram.com': 'Instagram',
    'twitter.com': 'Twitter',
    'x.com': 'X',
    'tiktok.com': 'TikTok',
    'reddit.com': 'Reddit',
    'lapresse.ca': 'Lapresse',
    'theverge.com': 'The Verge',
    'polygon.com': 'Polygon',
    'theguardian.com': 'The Guardian',
    'news.ycombinator.com': 'Hacker News',
    'aeon.co': 'Aeon',
    'rottentomatoes.com': 'Rotten Tomatoes',
    'news.google.com': 'Google News',
    'cnn.com': 'CNN',
    'bbc.com': 'BBC',
    'nytimes.com': 'NY Times',
    'washingtonpost.com': 'Washington Post',
    'netflix.com': 'Netflix',
    'hulu.com': 'Hulu',
    'disneyplus.com': 'Disney+',
    'primevideo.com': 'Prime Video',
    'buzzfeed.com': 'BuzzFeed',
    'amazon.com': 'Amazon',
    'ebay.com': 'eBay',
    'bestbuy.com': 'Best Buy',
  };

  function canonicalHost(hostname) {
    const bare = hostname.replace(/^www\./, '');
    const known = Object.keys(SITES).find(h => bare === h || bare.endsWith('.' + h));
    return known || bare;
  }

  const host = canonicalHost(location.hostname);
  const siteName = SITES[host] || host;

  function deviceLabel() {
    if (CONFIG.DEVICE_NAME) return CONFIG.DEVICE_NAME;
    const ua = navigator.userAgent;
    const device =
      /iPhone/.test(ua) ? 'iPhone'
      // iPadOS Safari reports "Macintosh" by default; real Macs have no touch
      : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
      : /Macintosh/.test(ua) ? 'Mac'
      : 'unknown';
    const browser =
      /Edg\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome'   // must come after Edge/Opera (they embed "Chrome/")
      : /Safari\//.test(ua) ? 'Safari'   // must come last (everything embeds "Safari/")
      : 'unknown';
    return `${device} ${browser}`;
  }

  const store = {
    get: (key, fallback) => GM.getValue(key, fallback),
    set: (key, val) => GM.setValue(key, val),
  };

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({ ...opts, onload: resolve, onerror: reject, ontimeout: reject });
    });
  }

  // ── Auth: Supabase email/password session, refreshed via GoTrue ─────────
  // Credentials are entered once per device via a native prompt() and never
  // touch anything but Supabase's own /auth/v1/token endpoint.
  async function getSession() {
    let session = await store.get('auth-session', null);
    if (session && session.expires_at > Date.now() + 60000) return session;
    if (session?.refresh_token) {
      const refreshed = await refreshSession(session.refresh_token);
      if (refreshed) return refreshed;
    }
    return bootstrapSession();
  }

  async function refreshSession(refreshToken) {
    try {
      const res = await gmRequest({
        method: 'POST',
        url: `${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        headers: { apikey: CONFIG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        data: JSON.stringify({ refresh_token: refreshToken }),
      });
      const body = JSON.parse(res.responseText);
      return body.access_token ? persistSession(body) : null;
    } catch {
      return null;
    }
  }

  let bootstrapping = null;
  function bootstrapSession() {
    // Guard against concurrent callers (e.g. flushQueue + main both need a
    // session) triggering two prompt() dialogs at once.
    if (bootstrapping) return bootstrapping;
    bootstrapping = (async () => {
      try {
        const email = prompt('Distraction Tracker: sign in with your Supabase account email');
        const password = email ? prompt('Password:') : null;
        if (!email || !password) return null;
        if (CONFIG.SUPABASE_URL.includes('YOUR-PROJECT') || CONFIG.SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')) {
          alert('Distraction Tracker: fill in SUPABASE_URL and SUPABASE_ANON_KEY in the script CONFIG first.');
          return null;
        }
        let res;
        try {
          res = await gmRequest({
            method: 'POST',
            url: `${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`,
            headers: { apikey: CONFIG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            data: JSON.stringify({ email, password }),
          });
        } catch (err) {
          alert(`Sign in failed: request did not reach Supabase.\n(${err?.message || err?.error || 'no network / blocked request'})\nCheck SUPABASE_URL in the script CONFIG.`);
          return null;
        }
        let body = null;
        try { body = JSON.parse(res.responseText); } catch {}
        if (!body?.access_token) {
          const reason = body?.error_description || body?.msg || body?.error
            || `HTTP ${res.status}: ${String(res.responseText).slice(0, 200)}`;
          alert(`Sign in failed: ${reason}`);
          return null;
        }
        return await persistSession(body);
      } finally {
        bootstrapping = null;
      }
    })();
    return bootstrapping;
  }

  async function persistSession(body) {
    const session = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + body.expires_in * 1000,
    };
    await store.set('auth-session', session);
    return session;
  }

  // ── Event log + offline retry queue ──────────────────────────────────────
  async function logEvent(eventType, extra = {}) {
    const event = {
      id: crypto.randomUUID(),
      host,
      url: location.href,
      event_type: eventType,
      device: deviceLabel(),
      client_created_at: new Date().toISOString(),
      ...extra,
    };
    const queue = await store.get('pending-events', []);
    queue.push(event);
    await store.set('pending-events', queue.slice(-500));
    flushQueue(); // fire and forget — network sync never blocks the caller
    return event;
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      const session = await getSession();
      if (!session) return;
      // Batch-POST the whole queue, then remove exactly the sent ids from a
      // FRESH read of storage — events appended concurrently by logEvent
      // survive the filter, and the loop picks them up on the next pass.
      while (true) {
        const queue = await store.get('pending-events', []);
        if (!queue.length) return;
        if (!await syncEvents(queue, session)) return;
        const sent = new Set(queue.map(e => e.id));
        const latest = await store.get('pending-events', []);
        await store.set('pending-events', latest.filter(e => !sent.has(e.id)));
      }
    } finally {
      flushing = false;
    }
  }

  async function syncEvents(events, session) {
    try {
      const res = await gmRequest({
        method: 'POST',
        url: `${CONFIG.SUPABASE_URL}/rest/v1/events`,
        headers: {
          apikey: CONFIG.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          // ignore-duplicates = ON CONFLICT DO NOTHING: idempotent retries
          // without needing an UPDATE RLS policy on the append-only table.
          Prefer: 'resolution=ignore-duplicates',
        },
        data: JSON.stringify(events),
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  // This site's "minutes saved per prevented visit" heuristic, from the
  // sites table, cached locally after the first fetch.
  async function siteAvgMinutes(headers) {
    const cached = await store.get(`site-avg:${host}`, null);
    if (cached != null) return cached;
    try {
      const res = await gmRequest({
        method: 'GET',
        url: `${CONFIG.SUPABASE_URL}/rest/v1/sites?host=eq.${encodeURIComponent(host)}&select=avg_minutes_saved`,
        headers,
      });
      const avg = JSON.parse(res.responseText)[0]?.avg_minutes_saved ?? 5;
      await store.set(`site-avg:${host}`, avg);
      return avg;
    } catch {
      return 5;
    }
  }

  // Prevented count: every attempt is unique — an attempt that never led to
  // entry counts as prevented, whether that was an explicit "I don't want to
  // open this" or just closing the tab. Each proceeded consumes exactly one
  // attempt (its own page load), so:
  //   prevented = attempts − proceeded
  function countPrevented(attempts, proceeded) {
    return Math.max(0, attempts - proceeded);
  }

  // Time saved is stricter than the prevented count: one saved session can't
  // be credited twice. A prevented attempt opens a credit window as long as
  // the session it hypothetically replaced (the site's avg_minutes_saved);
  // retries inside that window add attempts but no extra saved time, and
  // continuing inside the window cancels the credit (the session happened).
  function savedSessions(events, windowMins) {
    const rows = events
      .filter(e => e.event_type === 'attempt' || e.event_type === 'proceeded')
      .map(e => ({ t: new Date(e.client_created_at).getTime(), type: e.event_type }))
      .sort((a, b) => a.t - b.t);
    let count = 0, open = false, windowEnd = 0, entered = false;
    const close = () => { if (open && !entered) count++; open = false; };
    for (const r of rows) {
      if (open && r.t > windowEnd) close();
      if (!open) {
        if (r.type !== 'attempt') continue; // proceeded with no live window: nothing to cancel
        open = true;
        entered = false;
        windowEnd = r.t + windowMins * 60000;
      }
      if (r.type === 'proceeded') entered = true;
    }
    close();
    return count;
  }

  // `excludeId` is the just-logged "attempt" event for this page load — it's
  // excluded so the stat line reads "N attempts before this one" / the true
  // previous last-use, regardless of whether it has finished syncing yet.
  async function fetchRemoteStats(session, excludeId) {
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const url = `${CONFIG.SUPABASE_URL}/rest/v1/events`
        + `?host=eq.${encodeURIComponent(host)}`
        + `&client_created_at=gt.${encodeURIComponent(since)}`
        + `&id=neq.${encodeURIComponent(excludeId)}`
        + `&event_type=in.(attempt,proceeded)`
        + `&select=event_type,client_created_at&order=client_created_at.desc`;
      const headers = { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` };
      const [res, avgMins] = await Promise.all([
        gmRequest({ method: 'GET', url, headers }),
        siteAvgMinutes(headers),
      ]);
      const rows = JSON.parse(res.responseText);
      const attempts = rows.filter(r => r.event_type === 'attempt');
      const proceeded = rows.filter(r => r.event_type === 'proceeded').length;
      const stats = {
        attempts24h: attempts.length,
        prevented24h: countPrevented(attempts.length, proceeded),
        minutesSaved24h: savedSessions(rows, avgMins) * avgMins,
        lastUse: attempts[0] ? new Date(attempts[0].client_created_at).getTime() : null,
      };
      await store.set(`stats-cache:${host}`, stats);
      return stats;
    } catch {
      return null;
    }
  }

  // ── Local unlock session (per host) ──────────────────────────────────────
  async function isUnlocked() {
    const unlock = await store.get(`unlock:${host}`, null);
    return !!(unlock && Date.now() < unlock.until);
  }

  async function unlockHost(mins) {
    await store.set(`unlock:${host}`, { until: Date.now() + mins * 60000 });
  }

  async function localStats() {
    return store.get(`stats-cache:${host}`, { attempts24h: 0, prevented24h: 0, minutesSaved24h: 0, lastUse: null });
  }

  async function recordLocalAttempt() {
    const stats = await localStats();
    stats.attempts24h += 1;
    stats.lastUse = Date.now();
    await store.set(`stats-cache:${host}`, stats);
  }

  function relativeTime(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'}`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'}`;
    return `${Math.round(hrs / 24)} d`;
  }

  // ── Overlay ───────────────────────────────────────────────────────────────
  GM.addStyle(`
    #mdt-overlay { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
      background: linear-gradient(135deg, #7987c8, #5d6aae) !important;
      display: flex !important; align-items: stretch !important; justify-content: center !important;
      color: #fff !important; font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      transition: background 1.5s ease !important; }
    #mdt-overlay.mdt-hold { background: linear-gradient(135deg, #4a568e, #38406e) !important; }
    /* Top-anchored, not vertically centered: the stat header stays at the
       same y-position across the breathing, choice, and dial screens no
       matter how tall the content below it is — no jumping between screens. */
    .mdt-card { text-align: center !important;
      padding: calc(clamp(2.5rem, 12vh, 6rem) + env(safe-area-inset-top, 0px)) 1.5rem
               calc(clamp(1.5rem, 6vh, 3.5rem) + env(safe-area-inset-bottom, 0px)) !important;
      width: 100% !important; overflow-y: auto !important;
      display: flex !important; flex-direction: column !important; align-items: center !important;
      justify-content: flex-start !important; }
    /* Soft fade on each screen swap instead of an instant jump */
    .mdt-card > * { animation: mdt-fade 0.4s ease both !important; }
    @keyframes mdt-fade { from { opacity: 0; } to { opacity: 1; } }
    .mdt-title { font-size: clamp(1.3rem, 3.2vw, 1.9rem) !important; font-weight: 700 !important;
      margin: 0 0 0.75rem !important; line-height: 1.3 !important; max-width: 480px !important; }
    .mdt-sub { font-size: 0.95rem !important; opacity: 0.7 !important; margin: 0 0 1.75rem !important;
      max-width: 420px !important; line-height: 1.45 !important; }
    /* Full-page breathing stage — sized like index.html's .breather (55vmin) */
    .mdt-stage { position: relative !important;
      width: clamp(200px, 52vmin, 480px) !important; height: clamp(200px, 52vmin, 480px) !important;
      margin: clamp(0.5rem, 2.5vh, 1.5rem) auto clamp(1.4rem, 4vh, 2.5rem) !important;
      display: flex !important; align-items: center !important; justify-content: center !important; }
    .mdt-square { position: absolute !important; inset: 0 !important; border: 1.5px solid rgba(255,255,255,0.3) !important;
      border-radius: 4px !important; }
    /* rect() offset-paths always start at the top-left corner; rotating the
       full-size track by -90deg puts the start at the LOWER-LEFT corner and
       sends the dot up the left edge as "Breathe in" begins. */
    .mdt-dot-track { position: absolute !important; inset: 0 !important;
      transform: rotate(-90deg) !important; pointer-events: none !important; }
    .mdt-dot { position: absolute !important; width: 14px !important; height: 14px !important;
      background: #fff !important; border-radius: 50% !important;
      box-shadow: 0 0 12px rgba(255,255,255,0.9) !important;
      top: -7px !important; left: -7px !important;
      /* sharp-cornered path: with rounded corners the edge lengths become
         unequal, so the dot drifts off the 5s phase marks */
      offset-path: rect(0% 100% 100% 0%) !important; opacity: 0.45 !important; }
    .mdt-dot.mdt-running { opacity: 1 !important; animation: mdt-follow ${CONFIG.PHASE_MS * 4}ms linear infinite !important; }
    @keyframes mdt-follow { from { offset-distance: 0%; } to { offset-distance: 100%; } }
    .mdt-circle { width: 44% !important; height: 44% !important; background: rgba(255,255,255,0.25) !important;
      border-radius: 50% !important; transition: transform 5s cubic-bezier(0.4,0,0.2,1), background 1.5s ease !important; }
    .mdt-circle.mdt-inhale { transform: scale(2.15) !important; }
    .mdt-circle.mdt-hold-circle { background: rgba(56,64,110,0.5) !important; }
    .mdt-phase { font-size: clamp(1.1rem, 2.8vw, 1.5rem) !important; font-weight: 500 !important;
      margin: 0 0 2rem !important; min-height: 1.4em !important; }
    .mdt-big-num { font-size: clamp(2.6rem, 9vmin, 4.2rem) !important; font-weight: 800 !important;
      line-height: 1.05 !important; margin: 0 0 0.2rem !important;
      font-variant-numeric: tabular-nums !important; }
    .mdt-stats { font-size: 0.85rem !important; opacity: 0.75 !important;
      margin: 0 0 clamp(1rem, 3vh, 1.75rem) !important; line-height: 1.6 !important;
      min-height: 3.2em !important; } /* always reserve 2 lines — the caption
      can be 1 line ("First time today") or 2; without this the content below
      shifts when fresh stats swap in */
    /* Short viewports (landscape phones, small windows): compress the header
       and stage so everything fits without scrolling. */
    @media (max-height: 600px) {
      .mdt-big-num { font-size: 2rem !important; }
      .mdt-stats { margin-bottom: 0.75rem !important; line-height: 1.4 !important; }
      .mdt-stage { width: clamp(150px, 48vh, 300px) !important; height: clamp(150px, 48vh, 300px) !important;
        margin: 0.25rem auto 1rem !important; }
      .mdt-phase { margin-bottom: 1rem !important; }
      .mdt-title { font-size: 1.2rem !important; }
      .mdt-dial { width: min(40vh, 220px) !important; margin-bottom: 0.75rem !important; }
    }
    .mdt-btn { display: block !important; width: 100% !important; max-width: 360px !important; padding: 0.9rem !important;
      margin: 0 auto 0.75rem !important;
      border: none !important; border-radius: 14px !important; font-weight: 700 !important; font-size: 1rem !important;
      cursor: pointer !important; font-family: inherit !important; }
    /* Buttons anchor to the bottom (thumb reach, One Sec-style); the auto
       top margin absorbs spare height so the header stays pinned up top. */
    .mdt-btn-primary { background: rgba(255,255,255,0.92) !important; color: #5d6aae !important;
      margin-top: auto !important; }
    .mdt-btn-secondary { background: rgba(255,255,255,0.15) !important; color: #fff !important; }
    .mdt-btn-ghost { display: block !important; background: none !important; border: none !important;
      color: #fff !important; opacity: 0.75 !important; font-weight: 600 !important;
      font-size: 0.95rem !important; cursor: pointer !important; font-family: inherit !important;
      padding: 0.6rem 1rem !important; margin: 0.25rem auto 0 !important; }
    .mdt-btn-ghost:hover { opacity: 1 !important; }
    .mdt-pills { display: flex !important; gap: 0.6rem !important; justify-content: center !important;
      flex-wrap: wrap !important; margin: 0 0 1rem !important; }
    .mdt-pill { padding: 0.8rem 1.4rem !important; border-radius: 999px !important; border: none !important;
      background: rgba(255,255,255,0.15) !important; color: #fff !important; font-weight: 700 !important;
      font-size: 1rem !important; min-width: 3.2rem !important; cursor: pointer !important;
      font-family: inherit !important; }
    .mdt-pill:hover { background: rgba(255,255,255,0.3) !important; }
    .mdt-dial { display: block !important; width: min(64vw, 280px) !important; height: auto !important;
      margin: 0 auto 1.5rem !important; touch-action: none !important; cursor: pointer !important;
      -webkit-tap-highlight-color: transparent !important; }

    /* ── Re-lock bar (shown while a site is unlocked) ───────────────────── */
    #mdt-relock { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
      z-index: 2147483646 !important; height: auto !important;
      padding: calc(0.6rem + env(safe-area-inset-top, 0px)) 1rem 0.6rem !important;
      background: linear-gradient(135deg, #7987c8, #5d6aae) !important; color: #fff !important;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      font-size: 13px !important; font-weight: 600 !important; text-align: center !important;
      cursor: pointer !important; border-bottom: 1px solid rgba(255,255,255,0.2) !important;
      font-variant-numeric: tabular-nums !important; transition: background 0.2s ease !important; }
    #mdt-relock:hover { background: linear-gradient(135deg, #4a568e, #38406e) !important; }
    html.mdt-relock-pad { padding-top: calc(40px + env(safe-area-inset-top, 0px)) !important; }
    html.mdt-relock-pad #mdt-gear { top: calc(48px + env(safe-area-inset-top, 0px)) !important; }

    /* ── Gear + in-page stats panel ─────────────────────────────────────── */
    #mdt-gear { position: fixed !important; top: calc(10px + env(safe-area-inset-top, 0px)) !important;
      right: 12px !important; z-index: 2147483647 !important;
      width: 34px !important; height: 34px !important; border-radius: 50% !important;
      background: rgba(30, 30, 60, 0.35) !important; color: #fff !important;
      border: none !important; cursor: pointer !important; padding: 0 !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      font-size: 17px !important; line-height: 1 !important; opacity: 0.55 !important;
      backdrop-filter: blur(6px) !important; -webkit-backdrop-filter: blur(6px) !important;
      transition: opacity 0.2s ease !important; }
    #mdt-gear:hover { opacity: 1 !important; }
    #mdt-panel { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
      background: #f3f3f8 !important; color: #1c1c28 !important; overflow-y: auto !important;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      padding: calc(1.25rem + env(safe-area-inset-top, 0px)) 1rem 3rem !important; }
    .mdt-p-wrap { max-width: 640px !important; margin: 0 auto !important; text-align: left !important; }
    .mdt-p-head { display: flex !important; align-items: center !important;
      justify-content: space-between !important; margin: 0 0 1rem !important; }
    .mdt-p-title { font-size: 1.5rem !important; font-weight: 800 !important; margin: 0 !important; }
    .mdt-p-close { background: none !important; border: none !important; cursor: pointer !important;
      font-size: 1.5rem !important; color: inherit !important; opacity: 0.5 !important; padding: 0.25rem !important; }
    .mdt-tabs { display: flex !important; gap: 4px !important; background: #e6e6ee !important;
      border-radius: 12px !important; padding: 4px !important; margin: 0 0 1rem !important; }
    .mdt-tab { flex: 1 !important; padding: 0.5rem 0 !important; text-align: center !important;
      border: none !important; border-radius: 9px !important; background: transparent !important;
      font-weight: 600 !important; font-size: 0.85rem !important; cursor: pointer !important;
      color: inherit !important; font-family: inherit !important; }
    .mdt-tab.mdt-active { background: #fff !important; box-shadow: 0 1px 2px rgba(0,0,0,0.08) !important; }
    .mdt-p-nav { display: flex !important; align-items: center !important; justify-content: center !important;
      gap: 1rem !important; margin: 0 0 1rem !important; }
    .mdt-p-arrow { width: 34px !important; height: 34px !important; border-radius: 50% !important;
      border: none !important; background: #e6e6ee !important; color: inherit !important;
      font-size: 1.15rem !important; line-height: 1 !important; cursor: pointer !important;
      font-family: inherit !important; }
    .mdt-p-arrow:disabled { opacity: 0.3 !important; cursor: default !important; }
    .mdt-p-navlabel { font-weight: 700 !important; min-width: 10rem !important; text-align: center !important; }
    .mdt-p-hero { background: linear-gradient(135deg, #7987c8, #5d6aae) !important; color: #fff !important;
      border-radius: 18px !important; padding: 1.2rem 1.4rem !important;
      display: flex !important; flex-wrap: wrap !important; gap: 1rem 2rem !important; margin: 0 0 1rem !important; }
    .mdt-p-num { font-size: 1.7rem !important; font-weight: 800 !important; }
    .mdt-p-label { font-size: 0.7rem !important; letter-spacing: 0.04em !important;
      text-transform: uppercase !important; opacity: 0.75 !important; }
    .mdt-p-site { background: #fff !important; border-radius: 16px !important;
      padding: 1rem 1.2rem !important; margin: 0 0 0.7rem !important;
      display: flex !important; align-items: center !important; justify-content: space-between !important; }
    .mdt-p-site-name { font-weight: 700 !important; margin: 0 0 0.2rem !important; }
    .mdt-p-site-sub { font-size: 0.8rem !important; opacity: 0.55 !important; }
    .mdt-p-site-right { text-align: right !important; }
    .mdt-p-note { text-align: center !important; font-size: 0.85rem !important;
      opacity: 0.6 !important; margin: 1.2rem 0 0 !important; }
    .mdt-p-status { text-align: center !important; opacity: 0.55 !important; padding: 2.5rem 0 !important; }
  `);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // ── In-page stats panel (opened via the gear icon) ───────────────────────
  const PERIODS = [
    { key: 'day', label: 'Day' },
    { key: 'week', label: 'Week' },
    { key: 'month', label: 'Month' },
    { key: 'year', label: 'Year' },
  ];

  // Calendar range for a period type at `offset` (0 = current, -1 = previous…).
  // Weeks start on Monday.
  function periodRange(type, offset) {
    const now = new Date();
    let start, end;
    if (type === 'day') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset + 1);
    } else if (type === 'week') {
      const dow = (now.getDay() + 6) % 7;
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + offset * 7);
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    } else if (type === 'month') {
      start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
    } else {
      start = new Date(now.getFullYear() + offset, 0, 1);
      end = new Date(now.getFullYear() + offset + 1, 0, 1);
    }
    return { start, end };
  }

  function periodLabel(type, offset, { start, end }) {
    const fmt = (d, opts) => d.toLocaleDateString(undefined, opts);
    if (type === 'day') {
      if (offset === 0) return 'Today';
      if (offset === -1) return 'Yesterday';
      return fmt(start, { weekday: 'short', month: 'short', day: 'numeric' });
    }
    if (type === 'week') {
      if (offset === 0) return 'This week';
      if (offset === -1) return 'Last week';
      const last = new Date(end.getTime() - 86400000);
      return `${fmt(start, { month: 'short', day: 'numeric' })} – ${fmt(last, { month: 'short', day: 'numeric' })}`;
    }
    if (type === 'month') {
      const opts = start.getFullYear() === new Date().getFullYear()
        ? { month: 'long' } : { month: 'long', year: 'numeric' };
      return fmt(start, opts);
    }
    return `${start.getFullYear()}`;
  }

  function formatDuration(minutes) {
    if (!minutes) return '0 mins';
    if (minutes < 1) return `${Math.round(minutes * 60)} secs`;
    if (minutes < 60) { const m = Math.round(minutes); return `${m} min${m === 1 ? '' : 's'}`; }
    if (minutes < 60 * 24) return `${(minutes / 60).toFixed(1)} hrs`;
    if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 60 / 24)} d`;
    const weeks = Math.round(minutes / 60 / 24 / 7);
    return `${weeks} wk${weeks === 1 ? '' : 's'}`;
  }

  // One events fetch per period, aggregated client-side — event volume is tiny
  // (personal use), and it lets every number on the panel follow the selected
  // period instead of being pinned to fixed server queries.
  // PostgREST caps responses at its max-rows setting (Supabase default 1000);
  // ordered desc so a very busy period drops oldest rows first.
  async function fetchStatsData({ start, end }) {
    const session = await getSession();
    if (!session) return null;
    const headers = { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` };
    const eventsUrl = `${CONFIG.SUPABASE_URL}/rest/v1/events`
      + `?select=host,event_type,client_created_at,cycles&order=client_created_at.desc&limit=1000`
      + `&client_created_at=gte.${encodeURIComponent(start.toISOString())}`
      + `&client_created_at=lt.${encodeURIComponent(end.toISOString())}`;
    const [evRes, siteRes] = await Promise.all([
      gmRequest({ method: 'GET', url: eventsUrl, headers }),
      gmRequest({ method: 'GET', url: `${CONFIG.SUPABASE_URL}/rest/v1/sites?select=*`, headers }),
    ]);
    return { events: JSON.parse(evRes.responseText), sites: JSON.parse(siteRes.responseText) };
  }

  function aggregateStats(events, sites, windowDays) {
    const cfg = Object.fromEntries(sites.map(s => [s.host, s]));
    const perSite = {};
    for (const e of events) {
      const s = perSite[e.host] ??= { host: e.host, attempts: 0, proceeded: 0, breaths: 0, list: [] };
      if (e.event_type === 'attempt') s.attempts++;
      if (e.event_type === 'proceeded') s.proceeded++;
      if (e.event_type === 'breathing') s.breaths += e.cycles || 1;
      s.list.push(e);
    }
    const rows = Object.values(perSite).map(({ list, ...s }) => {
      const avgMins = cfg[s.host]?.avg_minutes_saved ?? 5;
      return {
        ...s,
        prevented: countPrevented(s.attempts, s.proceeded),
        displayName: cfg[s.host]?.display_name || s.host,
        minutesSaved: savedSessions(list, avgMins) * avgMins,
      };
    }).sort((a, b) => b.minutesSaved - a.minutesSaved || b.prevented - a.prevented || b.attempts - a.attempts);
    const totals = rows.reduce(
      (t, s) => ({
        attempts: t.attempts + s.attempts,
        prevented: t.prevented + s.prevented,
        minutes: t.minutes + s.minutesSaved,
        breaths: t.breaths + s.breaths,
      }),
      { attempts: 0, prevented: 0, minutes: 0, breaths: 0 },
    );
    const annual = {
      prevented: Math.round(totals.prevented / windowDays * 365),
      minutes: totals.minutes / windowDays * 365,
    };
    return { rows, totals, annual };
  }

  function renderPanelBody(wrap, data, windowDays) {
    // Everything below the header + tabs + nav is rebuilt per period change.
    [...wrap.querySelectorAll('.mdt-p-hero, .mdt-p-site, .mdt-p-note, .mdt-p-status')].forEach(n => n.remove());
    if (!data) {
      wrap.appendChild(el('div', 'mdt-p-status', 'Couldn’t load stats — sign in on a tracked site first.'));
      return;
    }
    const { rows, totals, annual } = aggregateStats(data.events, data.sites, windowDays);
    if (!rows.length) {
      wrap.appendChild(el('div', 'mdt-p-status', 'No activity in this period.'));
      return;
    }

    const hero = el('div', 'mdt-p-hero');
    const heroAttempts = el('div');
    heroAttempts.append(el('div', 'mdt-p-num', `${totals.attempts}×`), el('div', 'mdt-p-label', 'Attempts'));
    const heroPrevented = el('div');
    heroPrevented.append(el('div', 'mdt-p-num', `${totals.prevented}×`), el('div', 'mdt-p-label', 'Prevented'));
    const heroSaved = el('div');
    heroSaved.append(el('div', 'mdt-p-num', formatDuration(totals.minutes)), el('div', 'mdt-p-label', 'Time saved'));
    const cycleSecs = CONFIG.PHASE_MS * 4 / 1000;
    const heroBreaths = el('div');
    heroBreaths.append(
      el('div', 'mdt-p-num', formatDuration(totals.breaths * cycleSecs / 60)),
      el('div', 'mdt-p-label', `Breathing (${totals.breaths} cycles)`),
    );
    hero.append(heroAttempts, heroPrevented, heroSaved, heroBreaths);
    wrap.appendChild(hero);

    for (const s of rows) {
      const row = el('div', 'mdt-p-site');
      const left = el('div');
      left.append(
        el('div', 'mdt-p-site-name', s.displayName),
        el('div', 'mdt-p-site-sub',
          `${s.attempts} attempt${s.attempts === 1 ? '' : 's'} · ${s.prevented} prevented · ${s.proceeded} continued`
          + (s.breaths ? ` · ${s.breaths} breath cycle${s.breaths === 1 ? '' : 's'}` : '')),
      );
      const right = el('div', 'mdt-p-site-right');
      right.append(
        el('div', 'mdt-p-site-name', formatDuration(s.minutesSaved)),
        el('div', 'mdt-p-site-sub', 'time saved'),
      );
      row.append(left, right);
      wrap.appendChild(row);
    }

    wrap.appendChild(el('div', 'mdt-p-note',
      `At this rate: ${annual.prevented}× prevented · ${formatDuration(annual.minutes)} saved per year`));
  }

  function openStatsPanel() {
    if (document.getElementById('mdt-panel')) return;
    const panel = el('div');
    panel.id = 'mdt-panel';
    const wrap = el('div', 'mdt-p-wrap');
    panel.appendChild(wrap);

    const head = el('div', 'mdt-p-head');
    const closeBtn = el('button', 'mdt-p-close', '✕');
    closeBtn.onclick = () => panel.remove();
    head.append(el('h2', 'mdt-p-title', 'Distractions'), closeBtn);
    wrap.appendChild(head);

    const tabs = el('div', 'mdt-tabs');
    wrap.appendChild(tabs);

    // ‹ period › navigation — step backward/forward through calendar periods
    const nav = el('div', 'mdt-p-nav');
    const prevBtn = el('button', 'mdt-p-arrow', '‹');
    const navLabel = el('div', 'mdt-p-navlabel');
    const nextBtn = el('button', 'mdt-p-arrow', '›');
    nav.append(prevBtn, navLabel, nextBtn);
    wrap.appendChild(nav);

    let periodType = 'week';
    let offset = 0; // 0 = current period, -1 = previous…
    let requestSeq = 0;
    const render = async () => {
      [...tabs.children].forEach(t => t.classList.toggle('mdt-active', t.dataset.key === periodType));
      const range = periodRange(periodType, offset);
      navLabel.textContent = periodLabel(periodType, offset, range);
      nextBtn.disabled = offset === 0;
      [...wrap.querySelectorAll('.mdt-p-hero, .mdt-p-site, .mdt-p-note, .mdt-p-status')].forEach(n => n.remove());
      wrap.appendChild(el('div', 'mdt-p-status', 'Loading…'));
      const seq = ++requestSeq;
      let data = null;
      try { data = await fetchStatsData(range); } catch {}
      if (seq !== requestSeq || !document.getElementById('mdt-panel')) return; // superseded or closed
      // Annualization window: elapsed days within the period (a current period
      // is only partially elapsed), floored at 1h so "today at 9am" isn't wild.
      const windowDays = Math.max(
        (Math.min(Date.now(), range.end.getTime()) - range.start.getTime()) / 86400000,
        1 / 24,
      );
      renderPanelBody(wrap, data, windowDays);
    };
    for (const p of PERIODS) {
      const btn = el('button', 'mdt-tab', p.label);
      btn.dataset.key = p.key;
      btn.onclick = () => { periodType = p.key; offset = 0; render(); };
      tabs.appendChild(btn);
    }
    prevBtn.onclick = () => { offset--; render(); };
    nextBtn.onclick = () => { if (offset < 0) { offset++; render(); } };

    document.documentElement.appendChild(panel);
    render();
  }

  // ── Re-lock bar — countdown + tap to re-lock; auto re-locks at expiry ────
  let relockInterval = null;
  async function showRelockBar() {
    if (document.getElementById('mdt-relock')) return;
    const bar = el('div');
    bar.id = 'mdt-relock';
    const update = async () => {
      const unlock = await store.get(`unlock:${host}`, null);
      const remaining = unlock ? unlock.until - Date.now() : 0;
      if (remaining <= 0) {
        // session over — reload so the interception runs again
        clearInterval(relockInterval);
        await GM.deleteValue(`unlock:${host}`);
        location.reload();
        return;
      }
      const m = Math.floor(remaining / 60000);
      const s = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
      bar.textContent = `🔓 ${siteName} unlocked · ${m}:${s} left · tap to re-lock`;
    };
    bar.onclick = async () => {
      clearInterval(relockInterval);
      await GM.deleteValue(`unlock:${host}`);
      location.reload();
    };
    relockInterval = setInterval(update, 1000);
    update();
    document.documentElement.appendChild(bar);
    document.documentElement.classList.add('mdt-relock-pad');
  }

  function addGear() {
    if (document.getElementById('mdt-gear')) return;
    const gear = el('button', null, '⚙');
    gear.id = 'mdt-gear';
    gear.title = 'Distraction stats';
    gear.onclick = openStatsPanel;
    document.documentElement.appendChild(gear);
  }

  function buildOverlay() {
    const overlay = el('div');
    overlay.id = 'mdt-overlay';
    const card = el('div', 'mdt-card');
    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);
    // Same z-index wins by DOM order — keep the gear clickable over the overlay.
    const gear = document.getElementById('mdt-gear');
    if (gear) document.documentElement.appendChild(gear);
    return { overlay, card };
  }

  // Shared header for the breathing + choice screens: the attempt count
  // (including the current attempt) as a big number over a caption — one
  // consistent header system across the overlay.
  function buildStatHeader(stats) {
    const n = stats.attempts24h + 1;
    const caption = el('div', 'mdt-stats');
    caption.appendChild(document.createTextNode(`attempt${n === 1 ? '' : 's'} to open ${siteName} in the last 24h`));
    caption.appendChild(document.createElement('br'));
    caption.appendChild(document.createTextNode(
      stats.lastUse ? `Last use: ${relativeTime(stats.lastUse)} ago` : 'First time today',
    ));
    return [el('div', 'mdt-big-num', `${n}`), caption];
  }

  // Renders the breathing view into the card and runs `cycles` box cycles;
  // re-runnable ("More breathing" on the choice screen). Completed runs are
  // logged as a 'breathing' event carrying the cycle count.
  function showBreathing({ overlay, card }, cycles, stats, onDone) {
    while (card.firstChild) card.removeChild(card.firstChild);
    const stage = el('div', 'mdt-stage');
    const circle = el('div', 'mdt-circle');
    const dotTrack = el('div', 'mdt-dot-track');
    dotTrack.appendChild(el('div', 'mdt-dot mdt-running'));
    stage.append(el('div', 'mdt-square'), dotTrack, circle);
    const phase = el('div', 'mdt-phase', 'Breathe in');
    card.append(...buildStatHeader(stats), stage, phase);
    // Force a style flush before the first .mdt-inhale toggle: without it the
    // class lands in the same frame the circle is inserted, so the 5s scale
    // transition never runs and the circle pops in already fully grown.
    void circle.offsetWidth;

    const wait = ms => new Promise(r => setTimeout(r, ms));
    (async () => {
      for (let cycle = 0; cycle < cycles; cycle++) {
        phase.textContent = 'Breathe in';
        circle.classList.add('mdt-inhale');
        overlay.classList.remove('mdt-hold');
        circle.classList.remove('mdt-hold-circle');
        await wait(CONFIG.PHASE_MS);

        phase.textContent = 'Hold';
        overlay.classList.add('mdt-hold');
        circle.classList.add('mdt-hold-circle');
        await wait(CONFIG.PHASE_MS);

        phase.textContent = 'Breathe out';
        circle.classList.remove('mdt-inhale');
        overlay.classList.remove('mdt-hold');
        circle.classList.remove('mdt-hold-circle');
        await wait(CONFIG.PHASE_MS);

        phase.textContent = 'Hold';
        overlay.classList.add('mdt-hold');
        circle.classList.add('mdt-hold-circle');
        await wait(CONFIG.PHASE_MS);
      }
      overlay.classList.remove('mdt-hold');
      logEvent('breathing', { cycles });
      onDone();
    })();
  }

  function abandonSite() {
    logEvent('abandoned');
    // window.close() is best-effort — Safari only honors it for tabs the
    // script's page opened. Fall back to a blank page if we're still here.
    window.close();
    setTimeout(() => { location.href = 'about:blank'; }, 250);
  }

  function showChoice(ui, stats, onLeave, onMore) {
    const { card } = ui;
    while (card.firstChild) card.removeChild(card.firstChild);
    card.append(
      ...buildStatHeader(stats),
      el('div', 'mdt-title', 'What could be a better use of your time?'),
    );

    // One Sec hierarchy: backing out is the highlighted action, continuing is
    // a quiet text link at the bottom.
    const leaveBtn = el('button', 'mdt-btn mdt-btn-primary', "I don't want to open this");
    leaveBtn.onclick = abandonSite;
    const moreBtn = el('button', 'mdt-btn mdt-btn-secondary', 'More breathing');
    moreBtn.onclick = () => showCyclePicker(ui, stats, onLeave, onMore);
    const continueBtn = el('button', 'mdt-btn-ghost', `Continue to ${siteName}`);
    continueBtn.onclick = () => showTimerPicker(ui, stats, onLeave, onMore);
    card.append(leaveBtn, moreBtn, continueBtn);
  }

  function svgEl(tag, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  // Circular arc slider (One Sec-style): a 270° dial, gap at the bottom,
  // draggable knob, value shown in the center.
  function buildDial(initialMins, maxMins, onChange) {
    const SIZE = 200, C = SIZE / 2, R = 78, START = 135, SWEEP = 270;
    const rad = deg => deg * Math.PI / 180;
    const pt = deg => [C + R * Math.cos(rad(deg)), C + R * Math.sin(rad(deg))];
    const [sx, sy] = pt(START), [ex, ey] = pt(START + SWEEP);
    const d = `M ${sx} ${sy} A ${R} ${R} 0 1 1 ${ex} ${ey}`;
    const L = R * rad(SWEEP); // exact arc length — avoids getTotalLength on a detached node

    const svg = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'mdt-dial' });
    const track = svgEl('path', { d, fill: 'none', stroke: 'rgba(255,255,255,0.18)', 'stroke-width': 14, 'stroke-linecap': 'round' });
    const prog = svgEl('path', { d, fill: 'none', stroke: 'rgba(255,255,255,0.85)', 'stroke-width': 14, 'stroke-linecap': 'round' });
    const knob = svgEl('circle', { r: 11, fill: '#fff' });
    const label = svgEl('text', {
      x: C, y: C, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: '#fff', 'font-size': 28, 'font-weight': 700, 'font-family': 'inherit',
    });
    svg.append(track, prog, knob, label);

    let mins = initialMins;
    const render = () => {
      const t = (mins - 1) / (maxMins - 1);
      prog.setAttribute('stroke-dasharray', `${L * t} ${L + 30}`);
      const [kx, ky] = pt(START + SWEEP * t);
      knob.setAttribute('cx', kx);
      knob.setAttribute('cy', ky);
      label.textContent = `${mins} min`;
      onChange(mins);
    };
    const setFromPointer = ev => {
      const rect = svg.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / rect.width * SIZE - C;
      const y = (ev.clientY - rect.top) / rect.height * SIZE - C;
      let rel = (Math.atan2(y, x) * 180 / Math.PI - START + 360) % 360;
      // pointer in the bottom gap: snap to the nearer end of the arc
      if (rel > SWEEP) rel = (rel - SWEEP < (360 - SWEEP) / 2) ? SWEEP : 0;
      mins = Math.max(1, Math.min(maxMins, Math.round(1 + rel / SWEEP * (maxMins - 1))));
      render();
    };
    let dragging = false;
    svg.addEventListener('pointerdown', e => { dragging = true; svg.setPointerCapture(e.pointerId); setFromPointer(e); e.preventDefault(); });
    svg.addEventListener('pointermove', e => { if (dragging) setFromPointer(e); });
    svg.addEventListener('pointerup', () => { dragging = false; });
    render();
    return svg;
  }

  function showTimerPicker(ui, stats, onLeave, onMore) {
    const { card } = ui;
    while (card.firstChild) card.removeChild(card.firstChild);
    card.append(
      el('div', 'mdt-title', `How much time do you need on ${siteName}?`),
      el('div', 'mdt-sub', 'Be realistic — give yourself the time you need to complete the task you have in mind.'),
    );
    let chosen = CONFIG.UNLOCK_DEFAULT_MINS;
    card.appendChild(buildDial(CONFIG.UNLOCK_DEFAULT_MINS, CONFIG.UNLOCK_MAX_MINS, m => { chosen = m; }));

    const leaveBtn = el('button', 'mdt-btn mdt-btn-primary', `I don't want to open ${siteName}`);
    leaveBtn.onclick = abandonSite;
    const continueBtn = el('button', 'mdt-btn-ghost', `Continue to ${siteName}`);
    continueBtn.onclick = async () => {
      await unlockHost(chosen);
      logEvent('proceeded', { session_mins: chosen });
      onLeave();
    };
    card.append(leaveBtn, continueBtn);
  }

  function showCyclePicker(ui, stats, onLeave, onMore) {
    const { card } = ui;
    while (card.firstChild) card.removeChild(card.firstChild);
    const cycleSecs = CONFIG.PHASE_MS * 4 / 1000;
    card.append(
      el('div', 'mdt-title', 'More breathing'),
      el('div', 'mdt-sub', `How many cycles? (${cycleSecs} s each)`),
    );
    const pills = el('div', 'mdt-pills');
    for (const nCycles of CONFIG.MORE_CYCLES_OPTIONS) {
      const pill = el('button', 'mdt-pill', `${nCycles}`);
      pill.onclick = () => onMore(nCycles);
      pills.appendChild(pill);
    }
    const back = el('button', 'mdt-btn-ghost', 'Back');
    back.onclick = () => showChoice(ui, stats, onLeave, onMore);
    card.append(pills, back);
  }

  function hidePage() {
    document.documentElement.classList.add('mdt-hidden-page');
  }
  function unhidePage() {
    document.documentElement.classList.remove('mdt-hidden-page');
  }
  GM.addStyle(`.mdt-hidden-page > body { visibility: hidden !important; }`);

  async function main() {
    flushQueue(); // opportunistic background sync, never blocks rendering
    addGear();    // stats entry point, present locked or unlocked

    if (await isUnlocked()) { showRelockBar(); return; } // site loads normally

    hidePage();
    const ui = buildOverlay();
    let currentStats = await localStats();
    const attemptEvent = await logEvent('attempt');
    recordLocalAttempt();

    const dismiss = () => {
      ui.overlay.remove();
      unhidePage();
      showRelockBar();
    };
    let mode = 'breathing';
    const renderChoice = () => {
      mode = 'choice';
      showChoice(ui, currentStats, dismiss, (nCycles) => {
        mode = 'breathing';
        showBreathing(ui, nCycles, currentStats, renderChoice);
      });
    };

    showBreathing(ui, CONFIG.BREATH_CYCLES, currentStats, renderChoice);

    // Fresh stats patch in progressively — never interrupting a breathing
    // cycle or a picker: mid-breathing the header numbers are swapped in
    // place; the main choice screen is re-rendered wholesale.
    const session = await getSession();
    const fresh = session && await fetchRemoteStats(session, attemptEvent.id);
    if (fresh) {
      currentStats = fresh;
      if (!document.getElementById('mdt-overlay')) return;
      if (mode === 'choice' && ui.card.querySelector('.mdt-stats')) {
        renderChoice();
      } else if (mode === 'breathing') {
        const [bigNum, caption] = buildStatHeader(fresh);
        ui.card.querySelector('.mdt-big-num')?.replaceWith(bigNum);
        ui.card.querySelector('.mdt-stats')?.replaceWith(caption);
      }
    }
  }

  main();
  // No MutationObserver needed for the body-not-yet-parsed case: the
  // `.mdt-hidden-page > body` rule above is a live CSS selector, so it
  // applies automatically the instant body is inserted, however late.
})();
