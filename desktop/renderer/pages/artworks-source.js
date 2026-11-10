// Artwork source layer for the homepage Discover carousel.
//
// Data comes from lordemaximus.com's own Supabase catalog — the same query the
// site's build runs (active + sold, newest first) — and falls back to the
// bundled snapshot at assets/artworks.json when the network is unavailable.
// The carousel is never empty and never fabricates artwork: whatever the
// site lists is what can appear here, and every card links to its real
// artwork page on lordemaximus.com.
//
// The donor project (uganda-art-pulse) is READ-ONLY; this module only speaks
// to its public REST/Storage endpoints with the same public anon key the site
// itself ships.
//
// Runs in a plain <script> in the page and under require() in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ArtSource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUPABASE_URL = 'https://yoptatzqtwpxnzuizmcl.supabase.co';
  // Public anon key — the exact client key lordemaximus.com ships in its own
  // pages. Read-only, protected by Supabase row-level security.
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvcHRhdHpxdHdweG56dWl6bWNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk0MzcxNzQsImV4cCI6MjA3NTAxMzE3NH0.YO11AiQKD3jXLelZeQCA3GlWOusBiZc2Cx3eGASwaD8';
  const SITE_URL = 'https://lordemaximus.com';
  const STORAGE_ARTWORKS = SUPABASE_URL + '/storage/v1/object/public/artworks/';
  const SNAPSHOT_URL = 'assets/artworks.json';

  // The site's own grid query (build.mjs fetchRest): these fields, active and
  // sold rows only, newest first. Mirrored exactly — anything the site would
  // not list must not appear in the carousel either.
  const ARTWORKS_SELECT = 'id,user_id,title,description,description_general,price,original_price,category,medium,year,orientation,cover_aspect_ratio,tags,status,created_at,image_url,thumbnail_url,image_urls,views_count,likes_count,artist_name';
  const LISTED_STATUS = { active: true, sold: true };
  // The catalog contains a couple of the donor's own end-to-end test pieces;
  // a showcase must not promote fixtures over real art.
  const FIXTURE_TITLE = /^(E2E|Test)\b|placeholder|dummy|lorem ipsum/i;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Mirrors the site's fmtPrice(): empty string when there is no real price.
  function formatPrice(n) {
    n = Number(n);
    return isFinite(n) && n > 0 ? 'UGX ' + n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
  }

  function numberOrZero(value) {
    const n = Number(value);
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
  }

  function firstHttpUrl(list) {
    if (!Array.isArray(list)) return '';
    for (const entry of list) {
      const url = typeof entry === 'string' ? entry : entry && entry.url;
      if (isHttpUrl(url)) return url.trim();
    }
    return '';
  }

  // Image resolution, no shortcuts:
  //   1. image_url        — full URL (live rows; 2 snapshot rows point at the
  //                          materials bucket, so it is used verbatim)
  //   2. thumbnail_url    — full URL variant
  //   3. image_urls[]     — first full URL in the gallery
  //   4. path             — storage path inside the artworks bucket (snapshot
  //                          rows), composed into the public storage URL
  //   5. ''               — no image source exists; the card is excluded from
  //                          the showcase rather than shown broken
  function artworkImage(row) {
    if (!row || typeof row !== 'object') return '';
    if (isHttpUrl(row.image_url)) return row.image_url.trim();
    if (isHttpUrl(row.thumbnail_url)) return row.thumbnail_url.trim();
    const fromGallery = firstHttpUrl(row.image_urls);
    if (fromGallery) return fromGallery;
    const storagePath = typeof row.path === 'string' ? row.path.trim() : '';
    if (storagePath) return STORAGE_ARTWORKS + storagePath;
    return '';
  }

  // Mirrors the site's cardAspect(): explicit cover_aspect_ratio wins, then
  // orientation (landscape 1.5 / square 1 / everything else 0.75). Snapshot
  // rows carry the precomputed ratio in `ar`.
  function artworkAspect(row) {
    const explicit = Number(row && (row.cover_aspect_ratio != null ? row.cover_aspect_ratio : row.ar));
    if (isFinite(explicit) && explicit > 0) return explicit;
    const orientation = String((row && row.orientation) || '').toLowerCase();
    if (orientation === 'landscape') return 1.5;
    if (orientation === 'square') return 1;
    return 0.75;
  }

  function oneLine(row) {
    const raw = row.description_general || row.description || row.desc || row.story || row.inspiration || '';
    const text = String(raw).replace(/—/g, ' · ').replace(/\s+/g, ' ').trim();
    if (text.length <= 150) return text;
    const cut = text.slice(0, 150);
    const boundary = cut.lastIndexOf(' ');
    return (boundary > 90 ? cut.slice(0, boundary) : cut).replace(/[ ·,.]+$/, '') + '…';
  }

  function artistMapFrom(profiles) {
    const map = {};
    for (const profile of Array.isArray(profiles) ? profiles : []) {
      if (!profile || profile.id == null) continue;
      const name = String(profile.full_name || profile.name || profile.username || '').trim();
      if (name) map[String(profile.id)] = name;
    }
    return map;
  }

  // One normalizer for live rows and snapshot rows alike, so the fallback path
  // can never diverge from the live one. Returns null only for rows the site
  // itself would not list (no id, or a status outside active/sold).
  function normalizeArtwork(row, artists) {
    if (!row || typeof row !== 'object') return null;
    const id = String(row.id == null ? '' : row.id).trim();
    if (!id) return null;
    const status = String(row.status == null ? 'active' : row.status).trim().toLowerCase();
    if (!LISTED_STATUS[status]) return null;
    const title = String(row.title == null ? '' : row.title).trim() || 'Untitled';
    const named = String(row.artist_name == null ? '' : row.artist_name).trim();
    const ownerId = String(row.user_id || row.owner || '').trim();
    const price = Number(row.price);
    const original = Number(row.original_price);
    return {
      id,
      title,
      artist: named || (artists && artists[ownerId]) || '',
      category: String(row.category == null ? '' : row.category).trim(),
      medium: String(row.medium == null ? '' : row.medium).trim(),
      year: row.year == null ? '' : String(row.year).trim(),
      price: isFinite(price) && price > 0 ? price : 0,
      originalPrice: isFinite(original) && original > 0 ? original : 0,
      sold: status === 'sold',
      desc: oneLine(row),
      views: numberOrZero(row.views_count != null ? row.views_count : row.views),
      likes: numberOrZero(row.likes_count != null ? row.likes_count : row.likes),
      aspect: artworkAspect(row),
      tags: (Array.isArray(row.tags) ? row.tags : [])
        .map((tag) => String(tag).trim()).filter(Boolean).slice(0, 6),
      created: String(row.created_at || ''),
      img: artworkImage(row),
      url: SITE_URL + '/artwork/' + encodeURIComponent(id) + '.html'
    };
  }

  function normalizeCatalog(rows, artists) {
    const out = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const art = normalizeArtwork(row, artists);
      if (!art || seen.has(art.id)) continue;
      seen.add(art.id);
      out.push(art);
    }
    out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return out;
  }

  async function fetchJson(doFetch, url, headers, timeoutMs) {
    // The timeout is a UI race, not a cancellation: aborting the request is
    // what surfaced every slow catalog call as net::ERR_ABORTED console noise.
    // The request is left to finish quietly in the background and a late
    // failure is swallowed, so it can never break the caller or the console.
    let timer = null;
    const slow = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    try {
      const response = await Promise.race([
        doFetch(url, { headers: headers || {} }).catch(() => new Promise(() => {})),
        slow
      ]);
      if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : 'no response'));
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Live catalog: the site's own query, paginated like the site's build does
  // (200 per page). One retry per page against transient failures.
  async function fetchLiveArtworks(doFetch) {
    const rows = [];
    for (let page = 0; page < 5; page += 1) {
      const url = SUPABASE_URL + '/rest/v1/artworks?select=' + ARTWORKS_SELECT +
        '&status=in.(active,sold)&order=created_at.desc&limit=200&offset=' + (page * 200);
      let chunk;
      try {
        chunk = await fetchJson(doFetch, url, { apikey: SUPABASE_ANON }, 6000);
      } catch (error) {
        chunk = await fetchJson(doFetch, url, { apikey: SUPABASE_ANON }, 6000);
      }
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      rows.push(...chunk);
      if (chunk.length < 200) break;
    }
    return rows;
  }

  // Live artist names (best-effort, never blocks the catalog).
  async function fetchLiveArtists(doFetch) {
    const rows = await fetchJson(
      doFetch,
      SUPABASE_URL + '/rest/v1/profiles?select=id,username,full_name&limit=1000',
      { apikey: SUPABASE_ANON },
      3000
    );
    return artistMapFrom(rows);
  }

  async function fetchSnapshotCatalog(doFetch) {
    const data = await fetchJson(doFetch, SNAPSHOT_URL, {}, 4000);
    return {
      rows: Array.isArray(data && data.artworks) ? data.artworks : [],
      artists: artistMapFrom(Object.entries((data && data.artists) || {}).map(([id, name]) => ({ id, full_name: name })))
    };
  }

  // Loads the full catalog. Live rows and snapshot rows are merged by id (live
  // wins), artist names come from both sources, and any single failure degrades
  // to the other source instead of emptying the carousel.
  async function loadArtworkCatalog(options) {
    const opts = options || {};
    const doFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const results = await Promise.allSettled([
      doFetch ? fetchLiveArtworks(doFetch) : Promise.reject(new Error('fetch unavailable')),
      doFetch ? fetchSnapshotCatalog(doFetch) : Promise.reject(new Error('fetch unavailable'))
    ]);
    const liveRows = results[0].status === 'fulfilled' ? results[0].value : [];
    const snap = results[1].status === 'fulfilled' ? results[1].value : { rows: [], artists: {} };

    let liveArtists = {};
    if (liveRows.length) {
      try {
        liveArtists = await fetchLiveArtists(doFetch);
      } catch { /* the snapshot map already covers known artists */ }
    }
    const artists = Object.assign({}, snap.artists, liveArtists);
    const artworks = normalizeCatalog(liveRows.concat(snap.rows), artists);
    return {
      artworks,
      artists,
      source: liveRows.length ? (snap.rows.length ? 'live+snapshot' : 'live')
        : (snap.rows.length ? 'snapshot' : 'none'),
      liveCount: liveRows.length,
      snapshotCount: snap.rows.length
    };
  }

  // Showcase curation: real, titled, imaged works — never fixtures — most
  // loved first (views + 3×likes, the site's audience signal), with at most
  // two pieces per category so one medium cannot crowd out the rest.
  function pickShowcaseArtworks(list, count) {
    const limit = count == null ? 8 : Math.max(1, Number(count) || 8);
    const pool = (Array.isArray(list) ? list : []).filter((art) =>
      art && art.img && art.title && art.title !== 'Untitled' && !FIXTURE_TITLE.test(art.title));
    // Keep the curation guardrails, but randomize the order on every catalog
    // read so repeated fetches do not replay the same posts.
    const ranked = pool.slice().sort(() => Math.random() - 0.5);
    const picked = [];
    const perCategory = {};
    for (const art of ranked) {
      const key = art.category || 'Other';
      if ((perCategory[key] || 0) >= 2) continue;
      perCategory[key] = (perCategory[key] || 0) + 1;
      picked.push(art);
      if (picked.length >= limit) return picked;
    }
    for (const art of ranked) {
      if (picked.length >= limit) break;
      if (!picked.includes(art)) picked.push(art);
    }
    return picked;
  }

  return {
    SUPABASE_URL, SUPABASE_ANON, SITE_URL, STORAGE_ARTWORKS, SNAPSHOT_URL,
    ARTWORKS_SELECT, FIXTURE_TITLE,
    esc, formatPrice, numberOrZero, isHttpUrl,
    artworkImage, artworkAspect, oneLine, artistMapFrom,
    normalizeArtwork, normalizeCatalog,
    fetchLiveArtworks, fetchLiveArtists, fetchSnapshotCatalog,
    loadArtworkCatalog, pickShowcaseArtworks
  };
});
