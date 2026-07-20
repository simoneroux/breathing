// ==UserScript==
// @name         Distraction Tracker
// @namespace    mindful.distraction-tracker
// @version      2.10.0
// @description  Box-breathing friction + Supabase-backed distraction tracking, One Sec style.
// @author       Simon Roux
// @homepageURL  https://github.com/simoneroux/breathing
// @updateURL    https://raw.githubusercontent.com/simoneroux/breathing/main/distraction-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/simoneroux/breathing/main/distraction-tracker.user.js
// @match        *://*/*
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.addStyle
// @connect      wqdktvfwbjumkgvcijux.supabase.co
// @connect      oauth2.googleapis.com
// @connect      www.googleapis.com
// @run-at       document-start
// @noframes
// ==/UserScript==

// Companion to index.html's manual breathing tool (canonical visual language:
// colors, box+dot+circle, 5s phases — see that file if the two ever need to
// be kept in sync). This script intercepts a user-managed list of distracting
// sites, forces a short box-breathing pause, then offers a One Sec-style
// choice ("Continue" / "I don't want to open this") and logs the outcome to
// Supabase so it can be reviewed across devices in the in-page stats
// panel (gear icon, top right of any tracked site).
//
// @match is *://*/* on purpose: the tracked-site list is edited from the
// stats panel and synced through the Supabase `sites` table, and userscript
// managers can't widen a fixed @match list at runtime. On untracked pages
// the script reads one GM value and exits before touching the DOM.
//
// Auth happens on the hosted auth page (CONFIG.AUTH_PAGE, served from GitHub
// Pages): passkey or password sign-in with real <input>s, so password
// managers can autofill and WebAuthn ceremonies have a real origin. The page
// hands the session to this script via the auth bridge at the bottom of this
// file; GM storage is per-script and shared across all matched origins, so
// one sign-in covers every tracked site on the device.
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
    AUTH_PAGE: 'https://simoneroux.github.io/breathing/auth.html',
    // ── Sync backend ────────────────────────────────────────────────────
    // 'supabase' (default): the original hosted-Postgres backend above.
    // 'gdrive': store the event log in the user's own Google Drive app-data
    // folder — zero infrastructure, but needs a Google OAuth client of type
    // "TV and Limited Input" (device flow). The installed-app secret is not
    // confidential by Google's own definition, so shipping it here is fine.
    // The active backend is a per-device setting ('sync-backend' in GM
    // storage, switchable from the panel footer); this is just the default.
    SYNC_BACKEND_DEFAULT: 'supabase',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    // Optional device label for debugging cross-device sync ('' = auto-detect
    // from the platform). Leave as '' — auto-updates from @updateURL overwrite
    // any manual edits to this file, so per-device edits don't survive.
    DEVICE_NAME: '',
    UNLOCK_MAX_MINS: 20,     // dial maximum on "Continue" (single session)
    UNLOCK_DEFAULT_MINS: 5,  // dial starting position
    DAILY_UNLOCK_MAX_MINS: 60, // total unlock budget per day, all sites combined
    MORE_CYCLES_OPTIONS: [1, 2, 3, 4], // cycle-count choices for "More breathing"
    BREATH_CYCLES: 1,   // box-breathing cycles before the choice screen shows
    PHASE_MS: 5000,
  };

  // Seed list only: the live tracked-site list is the Supabase `sites` table,
  // cached in GM storage ('tracked-sites') and editable from the stats panel.
  // This map is used once, to initialize the cache before the first sync.
  const DEFAULT_SITES = {
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

  // Assigned during bootstrap (bottom of the file) once the tracked-site
  // list has decided this page is intercepted; everything below that reads
  // them (event log keys, overlay copy) only runs on tracked pages.
  let host = null;
  let siteName = null;

  // ── Tracked-site list (synced via the Supabase `sites` table) ───────────
  async function getTrackedSites() {
    const list = await store.get('tracked-sites', null);
    if (Array.isArray(list) && list.length) return list;
    const seeded = Object.entries(DEFAULT_SITES).map(([h, display_name]) => ({ host: h, display_name }));
    await store.set('tracked-sites', seeded);
    return seeded;
  }

  // Pull the backend's list into the local cache. An empty (or failed) fetch
  // is ignored — wiping the cache to nothing would un-track every site on a
  // glitch. avg_minutes_saved rides along so host edits and the time-saved
  // math can use the tuned heuristic without extra fetches.
  async function refreshTrackedSites(throttleMins) {
    const last = await store.get('tracked-sites-synced-at', 0);
    if (throttleMins && Date.now() - last < throttleMins * 60000) return;
    try {
      const rows = await sync.fetchSites();
      if (Array.isArray(rows) && rows.length) {
        await store.set('tracked-sites', rows.map(
          r => ({ host: r.host, display_name: r.display_name, avg_minutes_saved: r.avg_minutes_saved })));
        await store.set('tracked-sites-synced-at', Date.now());
      }
    } catch {}
  }

  // Longest host wins so 'news.google.com' beats a hypothetical 'google.com'.
  function matchTrackedSite(hostname, tracked) {
    const bare = hostname.replace(/^www\./, '').toLowerCase();
    return [...tracked]
      .sort((a, b) => b.host.length - a.host.length)
      .find(s => bare === s.host || bare.endsWith('.' + s.host)) || null;
  }

  // "youtube.com", "https://www.youtube.com/feed", "m.youtube.com/" all
  // normalize to a bare registrable-ish host; garbage returns null.
  function normalizeHost(raw) {
    let v = (raw || '').trim().toLowerCase();
    if (!v) return null;
    try {
      if (v.includes('/') || v.includes(':')) v = new URL(v.includes('://') ? v : `https://${v}`).hostname;
    } catch { return null; }
    v = v.replace(/^www\./, '').replace(/\.$/, '');
    return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(v) ? v : null;
  }

  // Add/remove/update push straight to the active backend (the panel gates
  // all three behind a connection) and update the local cache immediately so
  // the change applies on this device's next page load without waiting.
  async function addTrackedSite(newHost, name) {
    const display = (name || '').trim() || newHost;
    const list = await getTrackedSites();
    if (!list.some(s => s.host === newHost)) {
      await store.set('tracked-sites', [...list, { host: newHost, display_name: display }]);
    }
    return sync.addSite(newHost, display);
  }

  async function updateTrackedSite(oldHost, newHost, newName) {
    const list = await getTrackedSites();
    const entry = list.find(s => s.host === oldHost) || {};
    const updated = { ...entry, host: newHost, display_name: newName };
    await store.set('tracked-sites', list.map(s => (s.host === oldHost ? updated : s)));
    return sync.updateSite(oldHost, newHost, newName, entry);
  }

  async function removeTrackedSite(oldHost) {
    const list = await getTrackedSites();
    await store.set('tracked-sites', list.filter(s => s.host !== oldHost));
    return sync.removeSite(oldHost);
  }

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

  // ── Auth: Supabase session, minted on the hosted auth page ──────────────
  // The session originates from auth.html (passkey or password sign-in) and
  // arrives via the auth bridge below; this script only ever refreshes it
  // against Supabase's own /auth/v1/token endpoint.
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

  // Sign-in happens on the hosted auth page (CONFIG.AUTH_PAGE): password
  // managers and passkeys both need a real origin with real <input>s, which
  // prompt() can never provide. The page mints a session and hands it to
  // this script via the auth bridge at the bottom of this file; until then,
  // getSession() returns null and events simply queue locally.
  function bootstrapSession() {
    return null;
  }

  function openAuthPage() {
    window.open(CONFIG.AUTH_PAGE, '_blank');
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

  // ── Google Drive backend internals ──────────────────────────────────────
  // Layout in the Drive app-data folder: one `events-<installId>.json` per
  // device (each device writes ONLY its own file and reads the others, so
  // there are no write races by construction) plus a shared `sites.json`.
  async function driveInstallId() {
    let id = await store.get('gdrive-install-id', null);
    if (!id) {
      id = crypto.randomUUID().slice(0, 8);
      await store.set('gdrive-install-id', id);
    }
    return id;
  }

  // The OAuth client can also live in GM storage ('gdrive-client':
  // {id, secret}) — auto-updates from @updateURL overwrite manual CONFIG
  // edits, so a client pasted into the file would be lost on next release.
  async function driveClient() {
    const stored = await store.get('gdrive-client', null);
    return {
      id: stored?.id || CONFIG.GOOGLE_CLIENT_ID,
      secret: stored?.secret || CONFIG.GOOGLE_CLIENT_SECRET,
    };
  }

  async function driveToken() {
    const auth = await store.get('gdrive-auth', null);
    if (!auth?.refresh_token) return null;
    if (auth.expires_at > Date.now() + 60000) return auth.access_token;
    try {
      const client = await driveClient();
      const res = await gmRequest({
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `client_id=${encodeURIComponent(client.id)}`
          + `&client_secret=${encodeURIComponent(client.secret)}`
          + `&refresh_token=${encodeURIComponent(auth.refresh_token)}`
          + '&grant_type=refresh_token',
      });
      const t = JSON.parse(res.responseText);
      if (!t.access_token) {
        // invalid_grant = pairing revoked/expired: wipe the dead tokens so
        // the UI offers a fresh pairing instead of failing silently forever.
        if (t.error === 'invalid_grant') await GM.deleteValue('gdrive-auth');
        return null;
      }
      await store.set('gdrive-auth', { ...auth, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 });
      return t.access_token;
    } catch {
      return null;
    }
  }

  async function driveRequest(opts) {
    const token = await driveToken();
    if (!token) return null;
    try {
      return await gmRequest({ ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
    } catch {
      return null;
    }
  }

  // name → file id for the app-data folder, memoized per page load.
  let driveIndexMemo = null;
  async function driveFileIndex() {
    if (driveIndexMemo) return driveIndexMemo;
    const res = await driveRequest({
      method: 'GET',
      url: 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&pageSize=100&fields=files(id,name)',
    });
    if (!res || res.status !== 200) return null;
    try {
      driveIndexMemo = Object.fromEntries((JSON.parse(res.responseText).files || []).map(f => [f.name, f.id]));
      return driveIndexMemo;
    } catch {
      return null;
    }
  }

  // undefined = couldn't reach Drive (retry later); null = file doesn't exist.
  async function driveReadJson(name) {
    const index = await driveFileIndex();
    if (!index) return undefined;
    if (!index[name]) return null;
    const res = await driveRequest({
      method: 'GET',
      url: `https://www.googleapis.com/drive/v3/files/${index[name]}?alt=media`,
    });
    if (!res || res.status !== 200) return undefined;
    try { return JSON.parse(res.responseText); } catch { return undefined; }
  }

  async function driveWriteJson(name, value) {
    const index = await driveFileIndex();
    if (!index) return false;
    const body = JSON.stringify(value);
    let res;
    if (index[name]) {
      res = await driveRequest({
        method: 'PATCH',
        url: `https://www.googleapis.com/upload/drive/v3/files/${index[name]}?uploadType=media`,
        headers: { 'Content-Type': 'application/json' },
        data: body,
      });
    } else {
      const B = 'mdt-multipart-boundary';
      res = await driveRequest({
        method: 'POST',
        url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        headers: { 'Content-Type': `multipart/related; boundary=${B}` },
        data: `--${B}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
          + JSON.stringify({ name, parents: ['appDataFolder'] })
          + `\r\n--${B}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${B}--`,
      });
      if (res && res.status >= 200 && res.status < 300) {
        try { driveIndexMemo[name] = JSON.parse(res.responseText).id; } catch { driveIndexMemo = null; }
      }
    }
    return !!res && res.status >= 200 && res.status < 300;
  }

  // Merged view of every device's event file, memoized briefly — remote data
  // only changes when another device writes. Rows carry _own so the budget
  // split doesn't depend on device labels (twin "Mac Chrome" installs stay
  // distinct). Returns null if ANY file fails to read: a partial merge would
  // silently understate the daily budget.
  let driveEventsMemo = null;
  async function driveAllEvents() {
    if (driveEventsMemo && Date.now() - driveEventsMemo.at < 60000) return driveEventsMemo.rows;
    const index = await driveFileIndex();
    if (!index) return null;
    const ownName = `events-${await driveInstallId()}.json`;
    const rows = [];
    for (const name of Object.keys(index).filter(n => n.startsWith('events-'))) {
      const data = await driveReadJson(name);
      if (data === undefined) return null;
      for (const e of data?.events || []) rows.push({ ...e, _own: name === ownName });
    }
    driveEventsMemo = { at: Date.now(), rows };
    return rows;
  }

  // ── Sync backends ────────────────────────────────────────────────────────
  // Every network touchpoint goes through `sync` (chosen in the bootstrap):
  // the original Supabase backend, or Google Drive for a zero-infrastructure
  // install. Shared contract: fetchEvents/fetchSites return null on failure,
  // pushEvents returns an HTTP-ish status (0 = never reached the backend).
  let sync;
  async function initSync() {
    const name = await store.get('sync-backend', CONFIG.SYNC_BACKEND_DEFAULT);
    sync = name === 'gdrive' ? driveBackend : supabaseBackend;
  }

  const supabaseBackend = {
    name: 'supabase',
    label: 'Supabase',
    async isConnected() {
      return !!(await store.get('auth-session', null));
    },
    async accountLabel() {
      // The email lives in the access token's JWT payload — decode it
      // (base64url), and return null if anything about it surprises us.
      try {
        const session = await store.get('auth-session', null);
        const b64 = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(b64)).email || null;
      } catch {
        return null;
      }
    },
    connect() {
      openAuthPage();
    },
    // Local-only: deletes this device's tokens without revoking anything
    // server-side — other devices stay signed in, and queued events survive
    // to sync after the next sign-in.
    async disconnect() {
      await GM.deleteValue('auth-session');
    },
    async pushEvents(events) {
      const session = await getSession();
      if (!session) return 0;
      return postEvents(events, session);
    },
    async fetchEvents(sinceIso, untilIso) {
      const session = await getSession();
      if (!session) return null;
      try {
        const url = `${CONFIG.SUPABASE_URL}/rest/v1/events`
          + '?select=id,host,event_type,client_created_at,cycles,session_mins,device'
          + '&order=client_created_at.desc&limit=1000'
          + `&client_created_at=gte.${encodeURIComponent(sinceIso)}`
          + (untilIso ? `&client_created_at=lt.${encodeURIComponent(untilIso)}` : '');
        const res = await gmRequest({
          method: 'GET', url,
          headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
        });
        const rows = JSON.parse(res.responseText);
        return Array.isArray(rows) ? rows : null;
      } catch {
        return null;
      }
    },
    // The sites SELECT policy is public, so this works signed out too.
    async fetchSites() {
      try {
        const res = await gmRequest({
          method: 'GET',
          url: `${CONFIG.SUPABASE_URL}/rest/v1/sites?select=*`,
          headers: { apikey: CONFIG.SUPABASE_ANON_KEY },
        });
        const rows = JSON.parse(res.responseText);
        return Array.isArray(rows) ? rows : null;
      } catch {
        return null;
      }
    },
    async headers(session, extra = {}) {
      return {
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        ...extra,
      };
    },
    async addSite(newHost, display) {
      const session = await getSession();
      if (!session) return false;
      try {
        const res = await gmRequest({
          method: 'POST',
          url: `${CONFIG.SUPABASE_URL}/rest/v1/sites`,
          headers: await this.headers(session, { Prefer: 'resolution=ignore-duplicates' }),
          data: JSON.stringify([{ host: newHost, display_name: display }]),
        });
        return res.status >= 200 && res.status < 300;
      } catch {
        return false;
      }
    },
    async updateSite(oldHost, newHost, newName, entry) {
      const session = await getSession();
      if (!session) return false;
      try {
        if (newHost === oldHost) {
          const res = await gmRequest({
            method: 'PATCH',
            url: `${CONFIG.SUPABASE_URL}/rest/v1/sites?host=eq.${encodeURIComponent(oldHost)}`,
            headers: await this.headers(session),
            data: JSON.stringify({ display_name: newName }),
          });
          return res.status >= 200 && res.status < 300;
        }
        // Host is the primary key: insert the new row first — carrying the
        // old row's avg_minutes_saved so the tuned heuristic survives — and
        // delete the old one only once the insert landed.
        const ins = await gmRequest({
          method: 'POST',
          url: `${CONFIG.SUPABASE_URL}/rest/v1/sites`,
          headers: await this.headers(session, { Prefer: 'resolution=ignore-duplicates' }),
          data: JSON.stringify([{
            host: newHost,
            display_name: newName,
            ...(entry?.avg_minutes_saved != null ? { avg_minutes_saved: entry.avg_minutes_saved } : {}),
          }]),
        });
        if (!(ins.status >= 200 && ins.status < 300)) return false;
        const del = await gmRequest({
          method: 'DELETE',
          url: `${CONFIG.SUPABASE_URL}/rest/v1/sites?host=eq.${encodeURIComponent(oldHost)}`,
          headers: await this.headers(session),
        });
        return del.status >= 200 && del.status < 300;
      } catch {
        return false;
      }
    },
    async removeSite(oldHost) {
      const session = await getSession();
      if (!session) return false;
      try {
        const res = await gmRequest({
          method: 'DELETE',
          url: `${CONFIG.SUPABASE_URL}/rest/v1/sites?host=eq.${encodeURIComponent(oldHost)}`,
          headers: await this.headers(session),
        });
        return res.status >= 200 && res.status < 300;
      } catch {
        return false;
      }
    },
  };

  const driveBackend = {
    name: 'gdrive',
    label: 'Google Drive',
    async isConnected() {
      const auth = await store.get('gdrive-auth', null);
      return !!auth?.refresh_token;
    },
    async accountLabel() {
      return (await store.get('gdrive-auth', null))?.email || null;
    },
    // OAuth device flow: show a short code, the user enters it at
    // google.com/device on any signed-in device, and we poll for the grant.
    // The only OAuth flow a userscript can run natively (no redirect URI),
    // and Google allows exactly the Drive scopes we need on it.
    async connect(statusEl, onDone) {
      const status = msg => { if (statusEl) statusEl.textContent = msg; };
      const client = await driveClient();
      if (!client.id || !client.secret) {
        status('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the script CONFIG first (a "TV and Limited Input" OAuth client).');
        return;
      }
      try {
        const res = await gmRequest({
          method: 'POST',
          url: 'https://oauth2.googleapis.com/device/code',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: `client_id=${encodeURIComponent(client.id)}`
            + `&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.appdata email')}`,
        });
        const d = JSON.parse(res.responseText);
        if (!d.device_code) {
          status(`Couldn't start pairing: ${d.error || `HTTP ${res.status}`}`);
          return;
        }
        status(`Enter code ${d.user_code} at ${d.verification_url} (code copied)`);
        try { navigator.clipboard?.writeText(d.user_code); } catch {}
        window.open(d.verification_url, '_blank');
        const deadline = Date.now() + d.expires_in * 1000;
        let interval = (d.interval || 5) * 1000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, interval));
          const tr = await gmRequest({
            method: 'POST',
            url: 'https://oauth2.googleapis.com/token',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: `client_id=${encodeURIComponent(client.id)}`
              + `&client_secret=${encodeURIComponent(client.secret)}`
              + `&device_code=${encodeURIComponent(d.device_code)}`
              + '&grant_type=urn:ietf:params:oauth:grant-type:device_code',
          });
          const t = JSON.parse(tr.responseText);
          if (t.access_token) {
            const auth = {
              access_token: t.access_token,
              refresh_token: t.refresh_token,
              expires_at: Date.now() + t.expires_in * 1000,
            };
            // Best-effort email for the "syncing as" line.
            try {
              const ui = await gmRequest({
                method: 'GET',
                url: 'https://www.googleapis.com/oauth2/v3/userinfo',
                headers: { Authorization: `Bearer ${t.access_token}` },
              });
              auth.email = JSON.parse(ui.responseText).email || null;
            } catch {}
            await store.set('gdrive-auth', auth);
            status('Connected ✓');
            flushQueue();
            onDone?.();
            return;
          }
          if (t.error === 'slow_down') interval += 5000;
          else if (t.error !== 'authorization_pending') {
            status(`Pairing failed: ${t.error || 'unknown error'}`);
            return;
          }
        }
        status('Pairing code expired — try again.');
      } catch {
        status('Network error during pairing.');
      }
    },
    async disconnect() {
      const auth = await store.get('gdrive-auth', null);
      if (auth?.refresh_token) {
        // Best-effort server-side revoke; wiping the local tokens is what
        // actually disconnects this device.
        try {
          await gmRequest({
            method: 'POST',
            url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(auth.refresh_token)}`,
          });
        } catch {}
      }
      await GM.deleteValue('gdrive-auth');
    },
    async pushEvents(events) {
      const name = `events-${await driveInstallId()}.json`;
      const existing = await driveReadJson(name);
      if (existing === undefined) return 0;
      // Read-union-write against our own file only: idempotent on retries
      // (union by id) and race-free (no other device writes this file).
      const current = existing?.events || [];
      const seen = new Set(current.map(e => e.id));
      const merged = [...current, ...events.filter(e => !seen.has(e.id))].slice(-5000);
      const ok = await driveWriteJson(name, { device: deviceLabel(), events: merged });
      driveEventsMemo = null;
      return ok ? 200 : 0;
    },
    async fetchEvents(sinceIso, untilIso) {
      const rows = await driveAllEvents();
      if (!rows) return null;
      // ISO-8601 Z strings compare correctly as plain strings.
      return rows.filter(e =>
        (!sinceIso || e.client_created_at >= sinceIso)
        && (!untilIso || e.client_created_at < untilIso));
    },
    async fetchSites() {
      const sites = await driveReadJson('sites.json');
      if (sites === undefined) return null;
      if (sites === null) {
        // First run against this Drive: seed with the local list (defaults
        // included) so every other device starts from the same place.
        const seed = await getTrackedSites();
        await driveWriteJson('sites.json', seed);
        return seed;
      }
      return sites;
    },
    // sites.json is shared, so concurrent edits from two devices can race —
    // acceptable last-writer-wins for a personal, rarely-edited list.
    async mutateSites(mutate) {
      const sites = await this.fetchSites();
      if (!sites) return false;
      return driveWriteJson('sites.json', mutate(sites));
    },
    addSite(newHost, display) {
      return this.mutateSites(list =>
        list.some(s => s.host === newHost) ? list : [...list, { host: newHost, display_name: display }]);
    },
    updateSite(oldHost, newHost, newName) {
      return this.mutateSites(list =>
        list.map(s => (s.host === oldHost ? { ...s, host: newHost, display_name: newName } : s)));
    },
    removeSite(oldHost) {
      return this.mutateSites(list => list.filter(s => s.host !== oldHost));
    },
  };

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

  // 4xx the server will keep returning no matter how often we retry —
  // malformed row, constraint violation, unknown column. Auth (401/403) and
  // throttling/timeout (408/429) are excluded: those heal on their own.
  function isPermanentReject(status) {
    return status >= 400 && status < 500
      && status !== 401 && status !== 403 && status !== 408 && status !== 429;
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      if (!sync || !(await sync.isConnected())) return;
      // Push the whole queue, then remove exactly the sent ids from a
      // FRESH read of storage — events appended concurrently by logEvent
      // survive the filter, and the loop picks them up on the next pass.
      while (true) {
        const queue = await store.get('pending-events', []);
        if (!queue.length) return;
        const status = await sync.pushEvents(queue);
        if (status >= 200 && status < 300) {
          await removeFromQueue(queue.map(e => e.id));
          continue;
        }
        if (!isPermanentReject(status)) return; // offline/auth/5xx: retry next load
        // The server refuses the batch outright (e.g. an event type its
        // check constraint doesn't know yet). Retrying wholesale would wedge
        // the queue forever — the original stats outage — so sync events
        // one-by-one and drop only the specific rows it permanently rejects.
        for (const event of queue) {
          const single = await sync.pushEvents([event]);
          if ((single >= 200 && single < 300) || isPermanentReject(single)) {
            await removeFromQueue([event.id]);
          } else {
            return;
          }
        }
      }
    } finally {
      flushing = false;
    }
  }

  async function removeFromQueue(ids) {
    const sent = new Set(ids);
    const latest = await store.get('pending-events', []);
    await store.set('pending-events', latest.filter(e => !sent.has(e.id)));
  }

  // Returns the HTTP status, or 0 when the request never got a response.
  async function postEvents(events, session) {
    // PostgREST bulk inserts demand identical keys on every row (PGRST102
    // "All object keys must match" otherwise) — pad the optional columns so
    // a mixed attempt/breathing/proceeded batch can't wedge the whole queue.
    const rows = events.map(e => ({
      id: e.id,
      host: e.host,
      url: e.url ?? null,
      event_type: e.event_type,
      device: e.device ?? null,
      cycles: e.cycles ?? null,
      session_mins: e.session_mins ?? null,
      client_created_at: e.client_created_at,
    }));
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
        data: JSON.stringify(rows),
      });
      return res.status;
    } catch {
      return 0;
    }
  }

  // This site's "minutes saved per prevented visit" heuristic — served from
  // the tracked-sites cache (refreshTrackedSites keeps it in step with the
  // backend), so it costs no extra request.
  async function siteAvgMinutes() {
    const entry = (await getTrackedSites()).find(s => s.host === host);
    return entry?.avg_minutes_saved ?? 5;
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
  // Filtering happens client-side on the shared fetchEvents contract.
  async function fetchRemoteStats(excludeId) {
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const [all, avgMins] = await Promise.all([sync.fetchEvents(since), siteAvgMinutes()]);
      if (!all) return null;
      const rows = all
        .filter(r => r.host === host && r.id !== excludeId
          && (r.event_type === 'attempt' || r.event_type === 'proceeded'))
        .sort((a, b) => (a.client_created_at < b.client_created_at ? 1 : -1)); // newest first
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
    await addUnlockUsage(mins);
  }

  // ── Daily unlock budget (all sites combined, synced across devices) ─────
  // Minutes are charged up front when a session starts ('proceeded' events
  // carry them in session_mins); re-locking early via the bar refunds the
  // unused whole minutes as a 'relocked' event. Spent budget is
  //   sum(proceeded) − sum(relocked) since local midnight
  // computed from Supabase (all devices) plus this device's unsynced queue,
  // with a device-local ledger as the offline floor. The ledger key is the
  // local calendar date, so the budget resets at local midnight.
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  async function localUnlockUsedToday() {
    const ledger = await store.get('unlock-ledger', null);
    return ledger && ledger.date === todayKey() ? ledger.mins : 0;
  }

  async function addUnlockUsage(mins) {
    const used = await localUnlockUsedToday();
    await store.set('unlock-ledger', { date: todayKey(), mins: Math.max(0, used + mins) });
  }

  function budgetDelta(e) {
    if (e.event_type === 'proceeded') return e.session_mins || 0;
    if (e.event_type === 'relocked') return -(e.session_mins || 0);
    return 0;
  }

  // One remote fetch per page load (re-keyed at midnight), split into this
  // device's rows vs every other device's. Drive rows carry an exact _own
  // flag (per-install files); Supabase rows fall back to the device label,
  // so twin setups there (two "Mac Chrome"s) should pin distinct
  // CONFIG.DEVICE_NAMEs. A failed fetch is NOT memoized: the next budget
  // check retries instead of running ledger-only until midnight.
  // Resolves null when not connected or the request fails.
  let remoteUsedMemo = null;
  function remoteUnlockUsedToday() {
    if (remoteUsedMemo?.day !== todayKey()) {
      const day = todayKey();
      remoteUsedMemo = {
        day,
        promise: (async () => {
          try {
            const all = await sync.fetchEvents(startOfToday().toISOString());
            if (!all) return null;
            const rows = all.filter(r => r.event_type === 'proceeded' || r.event_type === 'relocked');
            const mine = deviceLabel();
            const isOwn = r => (r._own !== undefined ? r._own : r.device === mine);
            const sum = which => Math.max(0, rows.filter(which).reduce((t, r) => t + budgetDelta(r), 0));
            return { own: sum(isOwn), others: sum(r => !isOwn(r)) };
          } catch {
            return null;
          }
        })().then(v => {
          if (v == null && remoteUsedMemo?.day === day) remoteUsedMemo = null;
          return v;
        }),
      };
    }
    return remoteUsedMemo.promise;
  }

  // Today's budget movement still waiting in the offline queue — by
  // definition not yet reflected in the remote sum.
  async function pendingUnlockUsedToday() {
    const queue = await store.get('pending-events', []);
    const start = startOfToday();
    return queue.reduce(
      (sum, e) => new Date(e.client_created_at) >= start ? sum + budgetDelta(e) : sum,
      0,
    );
  }

  async function unlockUsedToday() {
    const local = await localUnlockUsedToday();
    // Cap the wait: budget checks gate UI renders, and the remote fetch is
    // prefetched in main() so this normally resolves instantly.
    const remote = await Promise.race([
      remoteUnlockUsedToday(),
      new Promise(resolve => setTimeout(() => resolve(null), 2500)),
    ]);
    if (remote == null) return local;
    // The ledger is authoritative for this device's own usage: it's charged
    // up front and refunded the instant a session is re-locked, whereas the
    // server's copy of our own events can race the queue flush — a remote
    // snapshot taken mid-flush misses a just-synced refund that the queue
    // no longer holds, which used to swallow refunds until the next reload.
    // The server's own-device rows only fill in when the ledger is empty
    // (fresh GM storage mid-day).
    const own = local > 0 ? local : remote.own + await pendingUnlockUsedToday();
    return remote.others + own;
  }

  async function unlockRemainingToday() {
    return Math.max(0, CONFIG.DAILY_UNLOCK_MAX_MINS - await unlockUsedToday());
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
      background: linear-gradient(135deg, #4d5890, #3f4877) !important;
      display: flex !important; align-items: stretch !important; justify-content: center !important;
      color: #fff !important; font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      transition: background 1.5s ease !important; }
    #mdt-overlay.mdt-hold { background: linear-gradient(135deg, #353d66, #2b3254) !important; }
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
    /* Full-page breathing stage — sized like index.html's .breather (55vmin).
       Stage internals are prefixed with #mdt-overlay: !important ties are
       broken by specificity, and some sites (Lapresse) ship high-specificity
       resets that beat bare single-class selectors. The circle is also
       self-centering (absolute + translate baked into both transform states)
       so it never depends on the parent's flex properties surviving. */
    #mdt-overlay .mdt-stage { position: relative !important;
      width: clamp(200px, 52vmin, 480px) !important; height: clamp(200px, 52vmin, 480px) !important;
      margin: clamp(0.5rem, 2.5vh, 1.5rem) auto clamp(1.4rem, 4vh, 2.5rem) !important;
      display: flex !important; align-items: center !important; justify-content: center !important; }
    #mdt-overlay .mdt-square { position: absolute !important; inset: 0 !important; border: 1.5px solid rgba(255,255,255,0.3) !important;
      border-radius: 4px !important; margin: 0 !important; }
    /* rect() offset-paths always start at the top-left corner; rotating the
       full-size track by -90deg puts the start at the LOWER-LEFT corner and
       sends the dot up the left edge as "Breathe in" begins. */
    #mdt-overlay .mdt-dot-track { position: absolute !important; inset: 0 !important;
      transform: rotate(-90deg) !important; transform-origin: center !important;
      margin: 0 !important; pointer-events: none !important; }
    #mdt-overlay .mdt-dot { position: absolute !important; width: 14px !important; height: 14px !important;
      background: #fff !important; border-radius: 50% !important;
      box-shadow: 0 0 12px rgba(255,255,255,0.9) !important;
      top: -7px !important; left: -7px !important; margin: 0 !important;
      /* sharp-cornered path: with rounded corners the edge lengths become
         unequal, so the dot drifts off the 5s phase marks */
      offset-path: rect(0% 100% 100% 0%) !important; opacity: 0.45 !important; }
    #mdt-overlay .mdt-dot.mdt-running { opacity: 1 !important; animation: mdt-follow ${CONFIG.PHASE_MS * 4}ms linear infinite !important; }
    @keyframes mdt-follow { from { offset-distance: 0%; } to { offset-distance: 100%; } }
    #mdt-overlay .mdt-circle { position: absolute !important; left: 50% !important; top: 50% !important;
      width: 44% !important; height: 44% !important; margin: 0 !important;
      background: rgba(255,255,255,0.25) !important; border-radius: 50% !important;
      transform: translate(-50%, -50%) scale(1) !important;
      transform-origin: center !important;
      transition: transform 5s cubic-bezier(0.4,0,0.2,1), background 1.5s ease !important; }
    #mdt-overlay .mdt-circle.mdt-inhale { transform: translate(-50%, -50%) scale(2.15) !important; }
    #mdt-overlay .mdt-circle.mdt-hold-circle { background: rgba(30,36,64,0.45) !important; }
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
      #mdt-overlay .mdt-stage { width: clamp(150px, 48vh, 300px) !important; height: clamp(150px, 48vh, 300px) !important;
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
    .mdt-btn-primary { background: rgba(255,255,255,0.92) !important; color: #3f4877 !important;
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
    .mdt-budget { font-size: 0.85rem !important; opacity: 0.7 !important;
      margin: -0.75rem 0 1.25rem !important; font-variant-numeric: tabular-nums !important; }

    /* ── Re-lock bar (shown while a site is unlocked) ───────────────────── */
    #mdt-relock { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
      z-index: 2147483646 !important; height: auto !important;
      padding: calc(0.6rem + env(safe-area-inset-top, 0px)) 1rem 0.6rem !important;
      background: linear-gradient(135deg, #4d5890, #3f4877) !important; color: #fff !important;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      font-size: 13px !important; font-weight: 600 !important; text-align: center !important;
      cursor: pointer !important; border-bottom: 1px solid rgba(255,255,255,0.2) !important;
      font-variant-numeric: tabular-nums !important; transition: background 0.2s ease !important; }
    #mdt-relock:hover { background: linear-gradient(135deg, #353d66, #2b3254) !important; }
    html.mdt-relock-pad { padding-top: calc(40px + env(safe-area-inset-top, 0px)) !important; }
    html.mdt-relock-pad #mdt-gear { top: calc(48px + env(safe-area-inset-top, 0px)) !important; }

    /* ── Gear + in-page stats panel ─────────────────────────────────────── */
    #mdt-gear { position: fixed !important; top: calc(10px + env(safe-area-inset-top, 0px)) !important;
      right: 12px !important; z-index: 2147483647 !important;
      width: 34px !important; height: 34px !important; border-radius: 50% !important;
      background: rgba(30, 30, 60, 0.3) !important; color: rgba(255, 255, 255, 0.92) !important;
      border: 1px solid rgba(255, 255, 255, 0.18) !important; cursor: pointer !important; padding: 0 !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      opacity: 0.6 !important; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15) !important;
      backdrop-filter: blur(8px) !important; -webkit-backdrop-filter: blur(8px) !important;
      transition: opacity 0.2s ease, transform 0.3s ease !important; }
    #mdt-gear:hover { opacity: 1 !important; transform: rotate(45deg) !important; }
    /* Panel corner buttons share the gear's footprint: the ✕ sits on the
       gear's exact spot (right: 12px), the view toggle just left of it. */
    .mdt-corner-btn { position: fixed !important; top: calc(10px + env(safe-area-inset-top, 0px)) !important;
      z-index: 2147483647 !important; width: 34px !important; height: 34px !important;
      border-radius: 50% !important; background: rgba(28, 28, 50, 0.07) !important;
      color: #1c1c28 !important; border: none !important; cursor: pointer !important;
      padding: 0 !important; display: flex !important; align-items: center !important;
      justify-content: center !important; opacity: 0.7 !important;
      transition: opacity 0.2s ease, background 0.2s ease !important; }
    .mdt-corner-btn:hover { opacity: 1 !important; background: rgba(28, 28, 50, 0.13) !important; }
    #mdt-p-close { right: 12px !important; }
    #mdt-p-view { right: 54px !important; }
    #mdt-panel { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
      background: #f3f3f8 !important; color: #1c1c28 !important; overflow-y: auto !important;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      padding: calc(1.25rem + env(safe-area-inset-top, 0px)) 1rem 3rem !important; }
    .mdt-p-wrap { max-width: 640px !important; margin: 0 auto !important; text-align: left !important; }
    .mdt-p-head { display: flex !important; align-items: center !important;
      justify-content: space-between !important; margin: 0 0 1rem !important; }
    .mdt-p-title { font-size: 1.5rem !important; font-weight: 800 !important; margin: 0 !important; }
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
    .mdt-p-hero { background: linear-gradient(135deg, #4d5890, #3f4877) !important; color: #fff !important;
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
    .mdt-p-signin { margin-top: 0.9rem !important; padding: 0.65rem 1.5rem !important;
      border: none !important; border-radius: 999px !important; cursor: pointer !important;
      background: linear-gradient(135deg, #4d5890, #3f4877) !important; color: #fff !important;
      font-weight: 700 !important; font-size: 0.9rem !important; font-family: inherit !important; }
    .mdt-p-account { font-size: 0.8rem !important; opacity: 0.55 !important;
      margin: 0 0 0.6rem !important; min-height: 1em !important; }
    .mdt-p-signout { padding: 0.55rem 1.3rem !important; border: none !important;
      border-radius: 999px !important; cursor: pointer !important;
      background: #e6e6ee !important; color: #1c1c28 !important;
      font-weight: 700 !important; font-size: 0.85rem !important; font-family: inherit !important; }
    .mdt-p-signout:hover { background: #dcdce6 !important; }

    /* ── Blocked-sites editor (view inside the stats panel) ────────────── */
    .mdt-set-title { font-size: 1.05rem !important; font-weight: 800 !important;
      margin: 1.5rem 0 0.75rem !important; }
    .mdt-set-row { background: #fff !important; border-radius: 14px !important;
      padding: 0.7rem 1rem !important; margin: 0 0 0.5rem !important;
      display: flex !important; align-items: center !important;
      justify-content: space-between !important; gap: 0.75rem !important; }
    .mdt-set-actions { display: flex !important; align-items: center !important; gap: 0.2rem !important; }
    .mdt-set-icon-btn { background: none !important; border: none !important; color: inherit !important;
      opacity: 0.4 !important; cursor: pointer !important; padding: 0.45rem !important;
      border-radius: 8px !important; font-family: inherit !important;
      display: flex !important; align-items: center !important; justify-content: center !important; }
    .mdt-set-icon-btn:hover { opacity: 1 !important; background: rgba(28, 28, 50, 0.06) !important; }
    .mdt-set-form { display: flex !important; flex-direction: column !important;
      gap: 0.6rem !important; flex: 1 !important; margin: 0 !important; }
    .mdt-set-formrow { display: flex !important; gap: 0.6rem !important; }
    .mdt-set-btn.mdt-set-btn-quiet { background: #e6e6ee !important; color: #1c1c28 !important; }
    .mdt-set-input { flex: 1 !important; min-width: 0 !important; padding: 0.7rem 1rem !important;
      border: 1px solid #d5d5e0 !important; border-radius: 12px !important;
      background: #fff !important; color: inherit !important;
      /* 16px: anything smaller makes iOS Safari zoom the page on focus */
      font-size: 16px !important; font-family: inherit !important; }
    .mdt-set-btn { padding: 0.7rem 1.2rem !important; border: none !important;
      border-radius: 12px !important; cursor: pointer !important;
      background: linear-gradient(135deg, #4d5890, #3f4877) !important; color: #fff !important;
      font-weight: 700 !important; font-size: 0.9rem !important; font-family: inherit !important; }
    .mdt-set-note { text-align: center !important; font-size: 0.8rem !important;
      opacity: 0.55 !important; margin: 0.75rem 0 0 !important; }
    .mdt-set-foot { text-align: center !important; margin: 1.5rem 0 0 !important; }
    .mdt-p-switch { display: block !important; margin: 0.6rem auto 0 !important; background: none !important;
      border: none !important; color: inherit !important; opacity: 0.45 !important;
      font-size: 0.75rem !important; cursor: pointer !important; font-family: inherit !important;
      text-decoration: underline !important; }
    .mdt-p-switch:hover { opacity: 0.8 !important; }

    /* ── Google Drive setup popup ──────────────────────────────────────── */
    #mdt-modal-backdrop { position: fixed !important; inset: 0 !important;
      z-index: 2147483647 !important; background: rgba(18, 18, 38, 0.55) !important;
      -webkit-backdrop-filter: blur(3px) !important; backdrop-filter: blur(3px) !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      padding: calc(1rem + env(safe-area-inset-top, 0px)) 1rem
               calc(1rem + env(safe-area-inset-bottom, 0px)) !important;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif !important; }
    .mdt-modal { background: #f3f3f8 !important; color: #1c1c28 !important;
      width: 100% !important; max-width: 460px !important; max-height: 85vh !important;
      overflow-y: auto !important; border-radius: 20px !important;
      padding: 1.25rem !important; text-align: left !important;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35) !important; }
    .mdt-modal-head { display: flex !important; align-items: center !important;
      justify-content: space-between !important; gap: 0.75rem !important; margin: 0 0 0.5rem !important; }
    .mdt-modal-title { font-size: 1.2rem !important; font-weight: 800 !important; margin: 0 !important; }
    .mdt-modal-close { width: 32px !important; height: 32px !important; flex: none !important;
      border-radius: 50% !important; background: rgba(28, 28, 50, 0.07) !important;
      border: none !important; cursor: pointer !important; padding: 0 !important; color: inherit !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      opacity: 0.7 !important; }
    .mdt-modal-close:hover { opacity: 1 !important; background: rgba(28, 28, 50, 0.13) !important; }
    .mdt-modal-intro { font-size: 0.85rem !important; line-height: 1.5 !important;
      opacity: 0.7 !important; margin: 0 0 0.9rem !important; }
    .mdt-steps { margin: 0 0 1rem !important; padding: 0 0 0 1.2rem !important;
      font-size: 0.85rem !important; line-height: 1.55 !important; }
    .mdt-steps li { margin: 0 0 0.4rem !important; }
    .mdt-code { background: rgba(28, 28, 50, 0.08) !important; border-radius: 5px !important;
      padding: 0.05rem 0.3rem !important; font-family: ui-monospace, Menlo, monospace !important;
      font-size: 0.78rem !important; }
    .mdt-link { color: #3f4877 !important; font-weight: 700 !important;
      text-decoration: underline !important; }
    .mdt-modal .mdt-set-form { margin-top: 0.25rem !important; }
  `);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // Inline styles with the 'important' priority outrank every author
  // stylesheet rule, whatever its specificity — the last resort against
  // sites (Lapresse) whose resets beat even #id-prefixed !important rules.
  // CSP-safe: style-src blocks <style> tags and style="" attributes, but
  // programmatic CSSOM writes like this are exempt.
  function setImportant(node, styles) {
    for (const [prop, val] of Object.entries(styles)) node.style.setProperty(prop, val, 'important');
  }

  // Inline SVG icons (Lucide outlines) — replaces the ⚙ emoji, which rendered
  // platform-dependently and broke the visual language. Built via
  // createElementNS (CSP-safe) and pinned with important inline styles so
  // page CSS targeting bare `svg` can't distort them.
  function iconEl(size, parts) {
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    setImportant(svg, { width: `${size}px`, height: `${size}px`, display: 'block', 'pointer-events': 'none' });
    for (const [tag, attrs] of parts) svg.appendChild(svgEl(tag, attrs));
    return svg;
  }
  const icons = {
    cog: (size = 18) => iconEl(size, [
      ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
      ['circle', { cx: '12', cy: '12', r: '3' }],
    ]),
    x: (size = 18) => iconEl(size, [
      ['path', { d: 'M18 6 6 18' }],
      ['path', { d: 'm6 6 12 12' }],
    ]),
    list: (size = 18) => iconEl(size, [
      ['path', { d: 'M8 6h13' }], ['path', { d: 'M8 12h13' }], ['path', { d: 'M8 18h13' }],
      ['path', { d: 'M3 6h.01' }], ['path', { d: 'M3 12h.01' }], ['path', { d: 'M3 18h.01' }],
    ]),
    chart: (size = 18) => iconEl(size, [
      ['path', { d: 'M3 3v16a2 2 0 0 0 2 2h16' }],
      ['path', { d: 'M18 17V9' }], ['path', { d: 'M13 17V5' }], ['path', { d: 'M8 17v-3' }],
    ]),
    pencil: (size = 15) => iconEl(size, [
      ['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }],
    ]),
  };

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

  // One events fetch per period, aggregated client-side — event volume is
  // tiny (personal use), and it lets every number on the panel follow the
  // selected period instead of being pinned to fixed server queries.
  async function fetchStatsData({ start, end }) {
    if (!(await sync.isConnected())) return null;
    const [events, sites] = await Promise.all([
      sync.fetchEvents(start.toISOString(), end.toISOString()),
      sync.fetchSites(),
    ]);
    if (!events || !sites) return null;
    return { events, sites };
  }

  function aggregateStats(events, sites, windowDays) {
    const cfg = Object.fromEntries(sites.map(s => [s.host, s]));
    const perSite = {};
    for (const e of events) {
      const s = perSite[e.host] ??= { host: e.host, attempts: 0, proceeded: 0, breaths: 0, unlockedMins: 0, list: [] };
      if (e.event_type === 'attempt') s.attempts++;
      if (e.event_type === 'proceeded') { s.proceeded++; s.unlockedMins += e.session_mins || 0; }
      if (e.event_type === 'relocked') s.unlockedMins -= e.session_mins || 0;
      if (e.event_type === 'breathing') s.breaths += e.cycles || 1;
      s.list.push(e);
    }
    const rows = Object.values(perSite).map(({ list, ...s }) => {
      const avgMins = cfg[s.host]?.avg_minutes_saved ?? 5;
      return {
        ...s,
        unlockedMins: Math.max(0, s.unlockedMins), // refunds can't go below zero
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
        unlockedMins: t.unlockedMins + s.unlockedMins,
      }),
      { attempts: 0, prevented: 0, minutes: 0, breaths: 0, unlockedMins: 0 },
    );
    const annual = {
      prevented: Math.round(totals.prevented / windowDays * 365),
      minutes: totals.minutes / windowDays * 365,
    };
    return { rows, totals, annual };
  }

  // One-time Google Drive setup popup: the OAuth client (id + secret) is
  // entered here rather than by editing the script, and kept in GM storage
  // so script auto-updates never wipe it. GM storage is per-script and
  // shared across every matched origin, so this is once per device, not
  // once per site. `onSaved` runs after a successful save.
  function openDriveSetupModal(onSaved) {
    if (document.getElementById('mdt-modal-backdrop')) return;
    const backdrop = el('div');
    backdrop.id = 'mdt-modal-backdrop';
    const modal = el('div', 'mdt-modal');
    backdrop.appendChild(modal);
    backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };

    const head = el('div', 'mdt-modal-head');
    const closeBtn = el('button', 'mdt-modal-close');
    closeBtn.title = 'Close';
    closeBtn.appendChild(icons.x(16));
    closeBtn.onclick = () => backdrop.remove();
    head.append(el('h2', 'mdt-modal-title', 'Set up Google Drive sync'), closeBtn);

    const intro = el('div', 'mdt-modal-intro',
      'Your stats stay in your own Google Drive — nothing is stored on anyone '
      + "else's server. Google needs a one-time \"app\" to grant access to; you "
      + 'create it once, free, then paste its two values below.');

    const steps = el('ol', 'mdt-steps');
    const step = (...nodes) => {
      const li = document.createElement('li');
      li.append(...nodes);
      steps.appendChild(li);
    };
    const link = el('a', 'mdt-link', 'Google Cloud Console');
    link.href = 'https://console.cloud.google.com/projectcreate';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    step('Open the ', link, ' and create a project (any name).');
    step('APIs & Services → Library → enable ', el('span', 'mdt-code', 'Google Drive API'), '.');
    step('APIs & Services → OAuth consent screen → External, fill in the app name and your email, and add the scope ',
      el('span', 'mdt-code', '.../auth/drive.appdata'), '.');
    step('On that same screen, press Publish app. (Left in "Testing", Google expires the connection every 7 days.)');
    step('Credentials → Create credentials → OAuth client ID → application type ',
      el('span', 'mdt-code', 'TVs and Limited Input devices'), '.');
    step('Copy the client ID and client secret it shows, and paste them here.');

    const form = el('form', 'mdt-set-form');
    const id = el('input', 'mdt-set-input');
    id.placeholder = 'Client ID (ends in .apps.googleusercontent.com)';
    const secret = el('input', 'mdt-set-input');
    secret.placeholder = 'Client secret';
    for (const i of [id, secret]) { i.autocapitalize = 'off'; i.spellcheck = false; }
    const save = el('button', 'mdt-set-btn', 'Save');
    save.type = 'submit';
    const row = el('div', 'mdt-set-formrow');
    row.append(secret, save);
    form.append(id, row);
    const status = el('div', 'mdt-set-note',
      'Stored on this device only, and kept across script updates.');
    form.onsubmit = async e => {
      e.preventDefault();
      if (!id.value.trim() || !secret.value.trim()) {
        status.textContent = 'Both fields are required.';
        return;
      }
      await store.set('gdrive-client', { id: id.value.trim(), secret: secret.value.trim() });
      backdrop.remove();
      onSaved?.();
    };
    // Prefill when re-opened to change an existing client.
    driveClient().then(c => { id.value = c.id || ''; secret.value = c.secret || ''; });

    modal.append(head, intro, steps, form, status);
    document.documentElement.appendChild(backdrop);
  }

  // Disconnected-state CTA in the stats panel.
  function buildConnectBox(onDone) {
    const box = el('div', 'mdt-p-status', 'Not syncing — activity is only stored on this device.');
    const slot = el('div');
    const status = el('div', 'mdt-p-account', '');
    box.append(slot, status);

    const render = (hasClient) => {
      while (slot.firstChild) slot.removeChild(slot.firstChild);
      if (sync.name === 'gdrive' && !hasClient) {
        const setup = el('button', 'mdt-p-signin', 'Set up Google Drive');
        setup.onclick = () => openDriveSetupModal(() => render(true));
        slot.appendChild(setup);
        return;
      }
      const btn = el('button', 'mdt-p-signin',
        sync.name === 'gdrive' ? 'Connect Google Drive' : 'Sign in to sync');
      btn.onclick = () => sync.connect(status, onDone);
      slot.appendChild(btn);
      if (sync.name === 'gdrive') {
        const edit = el('button', 'mdt-p-switch', 'Change Google OAuth client');
        edit.onclick = () => openDriveSetupModal(() => render(true));
        slot.appendChild(edit);
      }
    };

    if (sync.name === 'gdrive') driveClient().then(c => render(!!(c.id && c.secret)));
    else render(true);
    return box;
  }

  function renderPanelBody(wrap, data, windowDays) {
    // `wrap` is the panel's stats container — rebuilt wholesale per period.
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    if (!data) {
      wrap.appendChild(buildConnectBox(() => location.reload()));
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
    const heroUnlocked = el('div');
    heroUnlocked.append(
      el('div', 'mdt-p-num', formatDuration(totals.unlockedMins)),
      el('div', 'mdt-p-label', `Unlocked (${CONFIG.DAILY_UNLOCK_MAX_MINS} min/day cap)`),
    );
    const cycleSecs = CONFIG.PHASE_MS * 4 / 1000;
    const heroBreaths = el('div');
    heroBreaths.append(
      el('div', 'mdt-p-num', formatDuration(totals.breaths * cycleSecs / 60)),
      el('div', 'mdt-p-label', `Breathing (${totals.breaths} cycles)`),
    );
    hero.append(heroAttempts, heroPrevented, heroSaved, heroUnlocked, heroBreaths);
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

    // Corner controls, pinned to the screen's top-right: the ✕ lands on the
    // exact spot the page gear occupied, so opening the panel reads as the
    // gear morphing into a close button. The list/chart toggle beside it
    // flips between the stats and blocked-sites views.
    const closeBtn = el('button', 'mdt-corner-btn');
    closeBtn.id = 'mdt-p-close';
    closeBtn.title = 'Close';
    closeBtn.appendChild(icons.x());
    closeBtn.onclick = () => panel.remove();
    const viewBtn = el('button', 'mdt-corner-btn');
    viewBtn.id = 'mdt-p-view';
    panel.append(viewBtn, closeBtn);

    const head = el('div', 'mdt-p-head');
    const title = el('h2', 'mdt-p-title', 'Distractions');
    head.appendChild(title);
    wrap.appendChild(head);

    // Two views — stats (period tabs + numbers) and the blocked-sites
    // editor — with the account footer below whichever one is active.
    const statsView = el('div');
    const sitesView = el('div');
    const footer = el('div');
    wrap.append(statsView, sitesView, footer);

    const tabs = el('div', 'mdt-tabs');
    statsView.appendChild(tabs);

    // ‹ period › navigation — step backward/forward through calendar periods
    const nav = el('div', 'mdt-p-nav');
    const prevBtn = el('button', 'mdt-p-arrow', '‹');
    const navLabel = el('div', 'mdt-p-navlabel');
    const nextBtn = el('button', 'mdt-p-arrow', '›');
    nav.append(prevBtn, navLabel, nextBtn);
    statsView.appendChild(nav);

    const body = el('div');
    statsView.appendChild(body);

    let periodType = 'week';
    let offset = 0; // 0 = current period, -1 = previous…
    let requestSeq = 0;
    const render = async () => {
      [...tabs.children].forEach(t => t.classList.toggle('mdt-active', t.dataset.key === periodType));
      const range = periodRange(periodType, offset);
      navLabel.textContent = periodLabel(periodType, offset, range);
      nextBtn.disabled = offset === 0;
      while (body.firstChild) body.removeChild(body.firstChild);
      body.appendChild(el('div', 'mdt-p-status', 'Loading…'));
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
      renderPanelBody(body, data, windowDays);
    };
    for (const p of PERIODS) {
      const btn = el('button', 'mdt-tab', p.label);
      btn.dataset.key = p.key;
      btn.onclick = () => { periodType = p.key; offset = 0; render(); };
      tabs.appendChild(btn);
    }
    prevBtn.onclick = () => { offset--; render(); };
    nextBtn.onclick = () => { if (offset < 0) { offset++; render(); } };

    // ── Blocked-sites view: list with inline editing + add form ─────────
    let editingHost = null; // host currently open in the inline editor
    const buildSiteForm = ({ name, url, submitLabel, onSubmit, onCancel }) => {
      const form = el('form', 'mdt-set-form');
      const nameInput = el('input', 'mdt-set-input');
      nameInput.placeholder = 'Display name (optional)';
      nameInput.value = name || '';
      const row = el('div', 'mdt-set-formrow');
      const urlInput = el('input', 'mdt-set-input');
      urlInput.placeholder = 'example.com or full URL';
      urlInput.value = url || '';
      urlInput.autocapitalize = 'off';
      urlInput.spellcheck = false;
      const submit = el('button', 'mdt-set-btn', submitLabel);
      submit.type = 'submit';
      row.append(urlInput, submit);
      if (onCancel) {
        const cancel = el('button', 'mdt-set-btn mdt-set-btn-quiet', 'Cancel');
        cancel.type = 'button';
        cancel.onclick = onCancel;
        row.appendChild(cancel);
      }
      form.append(nameInput, row);
      form.onsubmit = async e => {
        e.preventDefault();
        const h = normalizeHost(urlInput.value);
        if (!h) { alert('Enter a site like example.com'); return; }
        await onSubmit(h, nameInput.value.trim());
      };
      return form;
    };

    const renderSites = async () => {
      while (sitesView.firstChild) sitesView.removeChild(sitesView.firstChild);
      const signedIn = await sync.isConnected();
      const list = await getTrackedSites();
      for (const s of [...list].sort((a, b) => a.host.localeCompare(b.host))) {
        const row = el('div', 'mdt-set-row');
        if (s.host === editingHost) {
          row.appendChild(buildSiteForm({
            // A name equal to the host is the auto-filled default, not a
            // deliberate label — present it as blank.
            name: s.display_name === s.host ? '' : s.display_name,
            url: s.host,
            submitLabel: 'Save',
            onSubmit: async (h, name) => {
              const ok = await updateTrackedSite(s.host, h, name || h);
              if (!ok) alert("Saved on this device, but the change didn't reach the server — it won't sync to other devices yet.");
              editingHost = null;
              renderSites();
            },
            onCancel: () => { editingHost = null; renderSites(); },
          }));
          sitesView.appendChild(row);
          continue;
        }
        const left = el('div');
        left.append(
          el('div', 'mdt-p-site-name', s.display_name || s.host),
          el('div', 'mdt-p-site-sub', s.host),
        );
        row.appendChild(left);
        if (signedIn) {
          const actions = el('div', 'mdt-set-actions');
          const edit = el('button', 'mdt-set-icon-btn');
          edit.title = `Edit ${s.host}`;
          edit.appendChild(icons.pencil());
          edit.onclick = () => { editingHost = s.host; renderSites(); };
          const del = el('button', 'mdt-set-icon-btn');
          del.title = `Stop blocking ${s.host}`;
          del.appendChild(icons.x(15));
          del.onclick = async () => {
            if (list.length <= 1) {
              alert('Keep at least one blocked site — this panel only exists on blocked pages.');
              return;
            }
            if (!confirm(`Stop blocking ${s.host}?`)) return;
            const ok = await removeTrackedSite(s.host);
            if (!ok) alert(`${s.host} is unblocked on this device, but the change didn't reach the server — a later sync may bring it back.`);
            renderSites();
          };
          actions.append(edit, del);
          row.appendChild(actions);
        }
        sitesView.appendChild(row);
      }
      if (signedIn) {
        sitesView.appendChild(el('div', 'mdt-set-title', 'Add a site'));
        sitesView.appendChild(buildSiteForm({
          submitLabel: 'Add',
          onSubmit: async (h, name) => {
            const ok = await addTrackedSite(h, name);
            if (!ok) alert(`${h} is blocked on this device, but the change didn't reach the server — it won't sync to other devices yet.`);
            renderSites();
          },
        }));
        sitesView.appendChild(el('div', 'mdt-set-note',
          'Changes apply on the next page load and sync to your other devices.'));
      } else {
        sitesView.appendChild(el('div', 'mdt-set-note', 'Sign in to add or remove blocked sites.'));
      }
    };

    // ── View toggle: list icon shows the sites editor, chart flips back ──
    let view = 'stats';
    const applyView = () => {
      title.textContent = view === 'stats' ? 'Distractions' : 'Blocked sites';
      setImportant(statsView, { display: view === 'stats' ? 'block' : 'none' });
      setImportant(sitesView, { display: view === 'sites' ? 'block' : 'none' });
      while (viewBtn.firstChild) viewBtn.removeChild(viewBtn.firstChild);
      viewBtn.appendChild(view === 'stats' ? icons.list() : icons.chart());
      viewBtn.title = view === 'stats' ? 'Blocked sites' : 'Stats';
      if (view === 'sites') {
        editingHost = null;
        renderSites();
        // Then pull the server list so edits from other devices show up —
        // but never clobber a form the user has already started typing in.
        refreshTrackedSites(0).then(() => {
          const dirty = editingHost
            || [...sitesView.querySelectorAll('.mdt-set-input')].some(i => i.value);
          if (view === 'sites' && !dirty && document.getElementById('mdt-panel')) renderSites();
        }, () => {});
      }
    };
    viewBtn.onclick = () => { view = view === 'stats' ? 'sites' : 'stats'; applyView(); };

    // ── Account footer: connection state, connect/disconnect, backend ───
    const renderFooter = async () => {
      while (footer.firstChild) footer.removeChild(footer.firstChild);
      const foot = el('div', 'mdt-set-foot');
      footer.appendChild(foot);
      if (await sync.isConnected()) {
        const account = el('div', 'mdt-p-account', `Syncing via ${sync.label}`);
        sync.accountLabel().then(l => {
          if (l) account.textContent = `Syncing via ${sync.label} as ${l}`;
        });
        const out = el('button', 'mdt-p-signout',
          sync.name === 'gdrive' ? 'Disconnect Google Drive' : 'Sign out on this device');
        out.onclick = async () => {
          await sync.disconnect();
          location.reload();
        };
        foot.append(account, out);
      }
      // Not connected: no connect button here — the stats body already
      // shows the one canonical connect CTA (a second button reads as two
      // different actions). The footer keeps only the backend switch.
      // Per-device backend switch — takes effect on reload. Choosing Drive
      // without an OAuth client yet opens the setup popup first, so the
      // switch never lands the user on a dead "connect" button.
      const other = sync.name === 'gdrive' ? supabaseBackend : driveBackend;
      const sw = el('button', 'mdt-p-switch', `Use ${other.label} sync instead`);
      const switchTo = async () => {
        await store.set('sync-backend', other.name);
        location.reload();
      };
      sw.onclick = async () => {
        if (other.name === 'gdrive') {
          const c = await driveClient();
          if (!c.id || !c.secret) { openDriveSetupModal(switchTo); return; }
        }
        switchTo();
      };
      foot.appendChild(sw);
    };

    document.documentElement.appendChild(panel);
    applyView();
    // Drain any locally queued events first so the numbers include this
    // device's latest activity; render regardless of how the flush went.
    flushQueue().then(render, render);
    renderFooter();
  }

  // ── Re-lock bar — countdown + tap to re-lock; auto re-locks at expiry ────
  let relockInterval = null;
  async function showRelockBar() {
    if (document.getElementById('mdt-relock')) return;
    const bar = el('div');
    bar.id = 'mdt-relock';
    // Static for the whole session: minutes were charged up front at unlock.
    const remainingToday = await unlockRemainingToday();
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
      bar.textContent = `🔓 ${siteName} unlocked · ${m}:${s} left · ${remainingToday} min left today · tap to re-lock`;
    };
    bar.onclick = async () => {
      // Double-tap guard: the async work below spans several awaits, so a
      // second tap before the reload would refund (and log) twice.
      if (bar.dataset.relocking) return;
      bar.dataset.relocking = '1';
      clearInterval(relockInterval);
      // Refund the unused whole minutes — re-locking early shouldn't cost
      // budget the session never consumed. The 'relocked' event carries the
      // refund to Supabase so other devices subtract it too; if the reload
      // cancels the in-flight sync, the event survives in the pending queue.
      const unlock = await store.get(`unlock:${host}`, null);
      const refund = unlock ? Math.floor(Math.max(0, unlock.until - Date.now()) / 60000) : 0;
      if (refund) {
        await addUnlockUsage(-refund);
        await logEvent('relocked', { session_mins: refund });
      }
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
    const gear = el('button');
    gear.id = 'mdt-gear';
    gear.title = 'Distraction stats';
    gear.appendChild(icons.cog());
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
    const square = el('div', 'mdt-square');
    const circle = el('div', 'mdt-circle');
    const dotTrack = el('div', 'mdt-dot-track');
    dotTrack.appendChild(el('div', 'mdt-dot mdt-running'));
    stage.append(square, dotTrack, circle);
    // Geometry pinned inline (see setImportant): the stylesheet still carries
    // these rules for sane sites, but the layout-critical properties can't be
    // left to a specificity fight. The inhale scale is driven through
    // setScale below for the same reason — an inline transform would shadow
    // any class-based transform state anyway.
    setImportant(stage, { position: 'relative' });
    setImportant(square, { position: 'absolute', inset: '0', margin: '0' });
    setImportant(dotTrack, {
      position: 'absolute', inset: '0', margin: '0',
      transform: 'rotate(-90deg)', 'transform-origin': 'center',
    });
    setImportant(circle, {
      position: 'absolute', left: '50%', top: '50%',
      width: '44%', height: '44%', margin: '0',
      'transform-origin': 'center',
      transform: 'translate(-50%, -50%) scale(1)',
      transition: 'transform 5s cubic-bezier(0.4,0,0.2,1), background 1.5s ease',
    });
    const setScale = s =>
      circle.style.setProperty('transform', `translate(-50%, -50%) scale(${s})`, 'important');
    const phase = el('div', 'mdt-phase', 'Breathe in');
    // Budget notice lives on the breathing screen itself: when the daily
    // unlock time is spent, say so here — the user learns the outcome up
    // front instead of after breathing through to the choice screen. The
    // breathing itself always runs.
    const budgetNote = el('div', 'mdt-budget', '');
    card.append(...buildStatHeader(stats), stage, phase, budgetNote);
    unlockRemainingToday().then(rem => {
      if (rem < 1) {
        budgetNote.textContent =
          `Daily unlock limit reached (${CONFIG.DAILY_UNLOCK_MAX_MINS} min) — back tomorrow.`;
      }
    });
    // Force a style flush before the first scale-up: without it the new
    // transform lands in the same frame the circle is inserted, so the 5s
    // transition never runs and the circle pops in already fully grown.
    void circle.offsetWidth;

    const wait = ms => new Promise(r => setTimeout(r, ms));
    (async () => {
      for (let cycle = 0; cycle < cycles; cycle++) {
        phase.textContent = 'Breathe in';
        setScale(2.15);
        overlay.classList.remove('mdt-hold');
        circle.classList.remove('mdt-hold-circle');
        await wait(CONFIG.PHASE_MS);

        phase.textContent = 'Hold';
        overlay.classList.add('mdt-hold');
        circle.classList.add('mdt-hold-circle');
        await wait(CONFIG.PHASE_MS);

        phase.textContent = 'Breathe out';
        setScale(1);
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

  async function showChoice(ui, stats, onLeave, onMore) {
    const { card } = ui;
    const remainingToday = await unlockRemainingToday();
    while (card.firstChild) card.removeChild(card.firstChild);
    card.append(
      ...buildStatHeader(stats),
      el('div', 'mdt-title', 'What could be a better use of your time?'),
    );

    // One Sec hierarchy: backing out is the highlighted action, continuing is
    // a quiet text link at the bottom — and only while daily budget remains.
    const leaveBtn = el('button', 'mdt-btn mdt-btn-primary', "I don't want to open this");
    leaveBtn.onclick = abandonSite;
    const moreBtn = el('button', 'mdt-btn mdt-btn-secondary', 'More breathing');
    moreBtn.onclick = () => showCyclePicker(ui, stats, onLeave, onMore);
    card.append(leaveBtn, moreBtn);
    if (remainingToday >= 1) {
      const continueBtn = el('button', 'mdt-btn-ghost', `Continue to ${siteName}`);
      continueBtn.onclick = () => showTimerPicker(ui, stats, onLeave, onMore);
      card.appendChild(continueBtn);
    } else {
      card.appendChild(el('div', 'mdt-budget',
        `Daily unlock limit reached (${CONFIG.DAILY_UNLOCK_MAX_MINS} min) — back tomorrow.`));
    }
    if (!stats.signedIn) {
      const signIn = el('button', 'mdt-btn-ghost',
        sync.name === 'gdrive' ? 'Not syncing — connect Google Drive' : 'Not syncing — sign in');
      // Drive pairing lives in the stats panel footer; Supabase has its own
      // hosted sign-in page.
      signIn.onclick = () => (sync.name === 'gdrive' ? openStatsPanel() : openAuthPage());
      card.appendChild(signIn);
    }
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
    const span = Math.max(1, maxMins - 1); // maxMins can be 1 when the daily budget is nearly spent
    const render = () => {
      const t = (mins - 1) / span;
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
      mins = Math.max(1, Math.min(maxMins, Math.round(1 + rel / SWEEP * span)));
      render();
    };
    let dragging = false;
    svg.addEventListener('pointerdown', e => { dragging = true; svg.setPointerCapture(e.pointerId); setFromPointer(e); e.preventDefault(); });
    svg.addEventListener('pointermove', e => { if (dragging) setFromPointer(e); });
    svg.addEventListener('pointerup', () => { dragging = false; });
    render();
    return svg;
  }

  async function showTimerPicker(ui, stats, onLeave, onMore) {
    const { card } = ui;
    const remainingToday = await unlockRemainingToday();
    while (card.firstChild) card.removeChild(card.firstChild);
    if (remainingToday < 1) { showChoice(ui, stats, onLeave, onMore); return; }
    card.append(
      el('div', 'mdt-title', `How much time do you need on ${siteName}?`),
      el('div', 'mdt-sub', 'Be realistic — give yourself the time you need to complete the task you have in mind.'),
    );
    // The dial can never grant more than what's left of the daily budget.
    const dialMax = Math.min(CONFIG.UNLOCK_MAX_MINS, remainingToday);
    let chosen = Math.min(CONFIG.UNLOCK_DEFAULT_MINS, dialMax);
    card.appendChild(buildDial(chosen, dialMax, m => { chosen = m; }));
    card.appendChild(el('div', 'mdt-budget',
      `${remainingToday} of your ${CONFIG.DAILY_UNLOCK_MAX_MINS} unlock minutes left today`));

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
    remoteUnlockUsedToday(); // prefetch the cross-device budget — resolved by
                             // the time any budget-gated screen needs it
    addGear();    // stats entry point, present locked or unlocked

    if (await isUnlocked()) { showRelockBar(); return; } // site loads normally

    hidePage();
    const ui = buildOverlay();
    let currentStats = {
      ...await localStats(),
      signedIn: await sync.isConnected(),
    };
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
    const fresh = (await sync.isConnected()) && await fetchRemoteStats(attemptEvent.id);
    if (fresh) {
      currentStats = { ...fresh, signedIn: true };
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

  // ── Auth bridge: runs only on the hosted auth page ───────────────────────
  // auth.html signs in (passkey or password), writes the session JSON into
  // #mdt-session-json and fires 'mdt-session-ready'; this branch stores it in
  // GM storage — shared across every matched site on this device — flushes
  // any locally queued events, and confirms back with 'mdt-session-stored'
  // so the page can show "Synced ✓". The ping/pong pair lets the page detect
  // whether the userscript is active on its domain at all.
  function installAuthBridge() {
    const adopt = async () => {
      const node = document.getElementById('mdt-session-json');
      if (!node?.textContent) return;
      try {
        const session = JSON.parse(node.textContent);
        if (!session?.access_token || !session?.refresh_token) return;
        await store.set('auth-session', session);
        flushQueue();
        document.dispatchEvent(new Event('mdt-session-stored'));
      } catch {}
    };
    document.addEventListener('mdt-session-ready', adopt);
    document.addEventListener('mdt-ping', () => document.dispatchEvent(new Event('mdt-pong')));
    // Announce on load too: if injection happened after the page's first
    // ping (late document-start, first visit to the domain), this clears the
    // "userscript not detected" banner without waiting for the next ping.
    document.dispatchEvent(new Event('mdt-pong'));
    if (document.readyState !== 'loading') adopt();
    else document.addEventListener('DOMContentLoaded', adopt);
  }

  await initSync();
  if (location.hostname === 'simoneroux.github.io') {
    installAuthBridge();
  } else {
    // Cheap on untracked pages: one throttled background list sync plus one
    // GM read to decide, then exit without ever touching the DOM.
    refreshTrackedSites(10);
    const tracked = matchTrackedSite(location.hostname, await getTrackedSites());
    if (tracked) {
      host = tracked.host;
      siteName = tracked.display_name || tracked.host;
      main();
    }
  }
  // No MutationObserver needed for the body-not-yet-parsed case: the
  // `.mdt-hidden-page > body` rule above is a live CSS selector, so it
  // applies automatically the instant body is inserted, however late.
})();
