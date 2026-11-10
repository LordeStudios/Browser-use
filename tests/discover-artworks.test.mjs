import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Discover carousel must pull REAL artworks from lordemaximus.com with no
// loopholes in the sourcing:
//
//   * live rows come from the site's own Supabase query (active + sold, newest
//     first) — mirrored exactly, including the pagination;
//   * a bundled snapshot (built READ-ONLY from the donor project) guarantees
//     the carousel offline;
//   * one normalizer runs both sources, so the fallback can never diverge;
//   * every edge case has an explicit answer: image_url vs path, missing
//     artist/title/price, sold pieces, aspect ratios, HTML escaping — nothing
//     is invented, nothing is silently dropped without a reason.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(root, 'desktop', 'renderer', 'pages', 'assets', 'artworks.json');

// artworks-source.js is a classic browser script (the page loads it with a
// plain <script>), and this repo is "type": "module" — so it is evaluated the
// way the browser sees it rather than required as a module.
function loadArtSource() {
  const file = path.join(root, 'desktop', 'renderer', 'pages', 'artworks-source.js');
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = { exports: {} };
  new Function('module', 'exports', code)(sandbox, sandbox.exports);
  return sandbox.exports;
}
const ArtSource = loadArtSource();

// ── normalizer: image resolution ────────────────────────────────────────────

test('image_url is used verbatim (it can point at any bucket)', () => {
  const art = ArtSource.normalizeArtwork({
    id: 'a1', title: 'T', status: 'active',
    image_url: 'https://yoptatzqtwpxnzuizmcl.supabase.co/storage/v1/object/public/materials/x/y.webp'
  }, {});
  assert.equal(art.img, 'https://yoptatzqtwpxnzuizmcl.supabase.co/storage/v1/object/public/materials/x/y.webp');
});

test('path composes the public artworks-storage URL (snapshot rows)', () => {
  const art = ArtSource.normalizeArtwork({
    id: 'a1', title: 'T', status: 'active',
    path: 'e2fc49ac-03fe-4262-8277-dda0048655f3/1792921424021-ef9e6088.png'
  }, {});
  assert.equal(art.img,
    'https://yoptatzqtwpxnzuizmcl.supabase.co/storage/v1/object/public/artworks/e2fc49ac-03fe-4262-8277-dda0048655f3/1792921424021-ef9e6088.png');
});

test('thumbnail_url and image_urls are honored in order', () => {
  const withThumb = ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'active', thumbnail_url: 'https://x/thumb.webp' }, {});
  assert.equal(withThumb.img, 'https://x/thumb.webp');
  const withGallery = ArtSource.normalizeArtwork({ id: 'b', title: 'T', status: 'active', image_urls: ['', 'https://x/g1.webp'] }, {});
  assert.equal(withGallery.img, 'https://x/g1.webp');
});

test('a row with no image source at all gets img:"" (never a broken card)', () => {
  const art = ArtSource.normalizeArtwork({ id: 'a1', title: 'T', status: 'active' }, {});
  assert.equal(art.img, '');
});

// ── normalizer: status, ids, duplication ────────────────────────────────────

test('only what the site lists may appear: active and sold, nothing else', () => {
  assert.equal(ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'active' }, {}).sold, false);
  const sold = ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'sold' }, {});
  assert.equal(sold.sold, true);
  assert.equal(ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'draft' }, {}), null);
  assert.equal(ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'archived' }, {}), null);
  assert.equal(ArtSource.normalizeArtwork({ title: 'T', status: 'active' }, {}), null, 'a row with no id cannot be linked');
  assert.equal(ArtSource.normalizeArtwork(null, {}), null);
});

test('normalizeCatalog dedupes by id and orders newest first', () => {
  const rows = [
    { id: 'x', title: 'Old', status: 'active', created_at: '2026-01-01' },
    { id: 'y', title: 'New', status: 'active', created_at: '2026-06-01' },
    { id: 'x', title: 'Duplicate', status: 'active', created_at: '2026-07-01' }
  ];
  const catalog = ArtSource.normalizeCatalog(rows, {});
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].title, 'New');
  assert.equal(catalog[1].title, 'Old');
});

// ── normalizer: artist, price, aspect, text ─────────────────────────────────

test('artist resolution never invents a name', () => {
  const named = ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'active', artist_name: 'Hazo' }, {});
  assert.equal(named.artist, 'Hazo');
  const byOwner = ArtSource.normalizeArtwork({ id: 'b', title: 'T', status: 'active', owner: 'p1' }, { p1: 'Emeru artistry' });
  assert.equal(byOwner.artist, 'Emeru artistry');
  const byUser = ArtSource.normalizeArtwork({ id: 'c', title: 'T', status: 'active', user_id: 'p2' }, { p2: 'Josh arts' });
  assert.equal(byUser.artist, 'Josh arts');
  const unknown = ArtSource.normalizeArtwork({ id: 'd', title: 'T', status: 'active' }, {});
  assert.equal(unknown.artist, '', 'unknown artist stays empty — never a placeholder name');
});

test('price formatting matches the site: UGX with thousands separators, empty when absent', () => {
  assert.equal(ArtSource.formatPrice(413000), 'UGX 413,000');
  assert.equal(ArtSource.formatPrice(0), '');
  assert.equal(ArtSource.formatPrice(-5), '');
  assert.equal(ArtSource.formatPrice(NaN), '');
  const art = ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'active', price: 236000, original_price: 300000 }, {});
  assert.equal(art.price, 236000);
  assert.equal(art.originalPrice, 300000);
  const free = ArtSource.normalizeArtwork({ id: 'b', title: 'T', status: 'active', price: 0 }, {});
  assert.equal(free.price, 0);
});

test('aspect mirrors the site: cover_aspect_ratio wins, then ar, then orientation', () => {
  assert.equal(ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'active', cover_aspect_ratio: 1.5 }, {}).aspect, 1.5);
  assert.equal(ArtSource.normalizeArtwork({ id: 'b', title: 'T', status: 'active', ar: 1 }, {}).aspect, 1);
  assert.equal(ArtSource.normalizeArtwork({ id: 'c', title: 'T', status: 'active', orientation: 'landscape' }, {}).aspect, 1.5);
  assert.equal(ArtSource.normalizeArtwork({ id: 'd', title: 'T', status: 'active', orientation: 'square' }, {}).aspect, 1);
  assert.equal(ArtSource.normalizeArtwork({ id: 'e', title: 'T', status: 'active', orientation: 'portrait' }, {}).aspect, 0.75);
  assert.equal(ArtSource.normalizeArtwork({ id: 'f', title: 'T', status: 'active' }, {}).aspect, 0.75);
});

test('description falls back down the chain, trims, and breaks at words', () => {
  const fromGeneral = ArtSource.normalizeArtwork({ id: 'a', title: 'T', status: 'active', description_general: 'General', description: 'Plain' }, {});
  assert.equal(fromGeneral.desc, 'General');
  const fromDescription = ArtSource.normalizeArtwork({ id: 'b', title: 'T', status: 'active', description: 'Plain' }, {});
  assert.equal(fromDescription.desc, 'Plain');
  const long = ArtSource.normalizeArtwork({ id: 'c', title: 'T', status: 'active', desc: Array(40).fill('word').join(' ') }, {});
  assert.ok(long.desc.length <= 151, `desc must be bounded: ${long.desc.length}`);
  assert.ok(long.desc.endsWith('…'), 'a cut desc must say so');
  assert.ok(long.desc.endsWith('word…'), 'the cut must land on a word boundary, never mid-word');
  const dashed = ArtSource.normalizeArtwork({ id: 'd', title: 'T', status: 'active', desc: 'a — b' }, {});
  assert.equal(dashed.desc, 'a · b');
});

test('the card links to the artwork’s real page on lordemaximus.com', () => {
  const art = ArtSource.normalizeArtwork({ id: '6ec7f4fb-f5a5-4d4d-bb76-302b869ff1b7', title: 'T', status: 'active' }, {});
  assert.equal(art.url, 'https://lordemaximus.com/artwork/6ec7f4fb-f5a5-4d4d-bb76-302b869ff1b7.html');
});

test('every catalog string can be dropped into HTML safely', () => {
  assert.equal(ArtSource.esc('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
});

// ── live source: the site's own query, mirrored ─────────────────────────────

test('the live query mirrors the site contract exactly', () => {
  assert.match(ArtSource.ARTWORKS_SELECT, /\bid\b/);
  assert.match(ArtSource.ARTWORKS_SELECT, /\bimage_url\b/);
  assert.match(ArtSource.ARTWORKS_SELECT, /\bcover_aspect_ratio\b/);
  assert.match(ArtSource.ARTWORKS_SELECT, /\bartist_name\b/);
  assert.ok(ArtSource.SUPABASE_ANON.length > 100, 'the public anon key must be present');
  assert.equal(ArtSource.SITE_URL, 'https://lordemaximus.com');
  assert.equal(ArtSource.SNAPSHOT_URL, 'assets/artworks.json');
});

function stubFetch(handlers) {
  return async (url) => {
    for (const [pattern, value] of handlers) {
      if (pattern.test(String(url))) {
        const body = typeof value === 'function' ? await value(String(url)) : value;
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('loadArtworkCatalog merges live rows with the snapshot (live wins)', async () => {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const fetchImpl = stubFetch([
    [/rest\/v1\/artworks/, [{ id: 'live-1', title: 'Fresh Piece', status: 'active', user_id: 'p9', image_url: 'https://x/fresh.webp', views_count: 5, likes_count: 2, created_at: '2027-01-01' }]],
    [/rest\/v1\/profiles/, [{ id: 'p9', username: 'fresh', full_name: 'Fresh Artist' }]],
    [/assets\/artworks\.json/, snapshot]
  ]);
  const catalog = await ArtSource.loadArtworkCatalog({ fetchImpl });
  assert.equal(catalog.source, 'live+snapshot');
  const fresh = catalog.artworks.find((a) => a.id === 'live-1');
  assert.ok(fresh, 'the live row must be in the merged catalog');
  assert.equal(fresh.artist, 'Fresh Artist', 'live rows resolve artists from the live profiles map');
  assert.ok(catalog.artworks.length >= snapshot.artworks.length, 'snapshot rows must survive the merge');
  const known = catalog.artworks.find((a) => a.id === snapshot.artworks[0].id);
  assert.ok(known, 'snapshot rows must be present when live pagination never reaches them');
});

test('when the live catalog is down, the bundled snapshot carries the carousel', async () => {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const fetchImpl = stubFetch([
    [/assets\/artworks\.json/, snapshot],
    [/rest\/v1\//, () => { throw new Error('network down'); }]
  ]);
  const catalog = await ArtSource.loadArtworkCatalog({ fetchImpl });
  assert.equal(catalog.source, 'snapshot');
  assert.ok(catalog.artworks.length > 300, `the snapshot must carry the full catalog: ${catalog.artworks.length}`);
});

test('when the snapshot is missing, live rows still load', async () => {
  const fetchImpl = stubFetch([
    [/rest\/v1\/artworks/, [{ id: 'live-1', title: 'Fresh', status: 'active', image_url: 'https://x/f.webp' }]],
    [/rest\/v1\/profiles/, []]
  ]);
  const catalog = await ArtSource.loadArtworkCatalog({ fetchImpl });
  assert.equal(catalog.source, 'live');
  assert.equal(catalog.artworks.length, 1);
});

test('when both sources fail the result is honest and empty — the page keeps its studio cards', async () => {
  const fetchImpl = () => { throw new Error('no network'); };
  const catalog = await ArtSource.loadArtworkCatalog({ fetchImpl });
  assert.equal(catalog.source, 'none');
  assert.equal(catalog.artworks.length, 0);
});

// ── showcase curation ───────────────────────────────────────────────────────

test('the showcase never promotes fixtures or imageless works', () => {
  const picked = ArtSource.pickShowcaseArtworks([
    { id: 'f', title: 'E2E Live Artwork 1792921419798', img: 'https://x/f.webp', views: 9999, likes: 999 },
    { id: 'n', title: 'No Image', img: '', views: 9999, likes: 999 },
    { id: 'u', title: 'Untitled', img: 'https://x/u.webp', views: 9999, likes: 999 },
    { id: 'r', title: 'Tiger’s Intense Gaze', img: 'https://x/r.webp', category: 'Painting', views: 235, likes: 2 }
  ], 8);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, 'r');
});

test('the showcase spreads categories — at most two per category', () => {
  const list = [];
  for (const [category, count] of [['Painting', 6], ['Photography', 3], ['Drawing', 3], ['Mixed Media', 2], ['Sculpture', 2]]) {
    for (let i = 0; i < count; i += 1) {
      list.push({ id: category + i, title: category + ' ' + i, img: 'https://x/' + category + i + '.webp', category, views: 100 - i, likes: 0 });
    }
  }
  const picked = ArtSource.pickShowcaseArtworks(list, 8);
  assert.equal(picked.length, 8, 'a diverse catalog fills the rotation');
  const perCategory = {};
  for (const art of picked) perCategory[art.category] = (perCategory[art.category] || 0) + 1;
  for (const [category, count] of Object.entries(perCategory)) {
    assert.ok(count <= 2, `one category cannot crowd out the rest: ${category} × ${count}`);
  }
});

test('when the catalog is tiny the showcase still shows everything it can', () => {
  const list = [
    { id: 'a', title: 'A', img: 'https://x/a.webp', category: 'Painting', views: 9, likes: 0 },
    { id: 'b', title: 'B', img: 'https://x/b.webp', category: 'Painting', views: 8, likes: 0 },
    { id: 'c', title: 'C', img: 'https://x/c.webp', category: 'Painting', views: 7, likes: 0 }
  ];
  const picked = ArtSource.pickShowcaseArtworks(list, 8);
  assert.equal(picked.length, 3, 'the diversity cap must not hide works when nothing else exists');
});

// ── the bundled snapshot itself ─────────────────────────────────────────────

test('the bundled snapshot covers the donor catalog completely', () => {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  assert.ok(Array.isArray(snapshot.artworks) && snapshot.artworks.length >= 371,
    `every donor artwork must be carried: ${snapshot.artworks && snapshot.artworks.length}`);
  assert.ok(Object.keys(snapshot.artists || {}).length >= 200, 'artist names must travel with the snapshot');
  const catalog = ArtSource.normalizeCatalog(snapshot.artworks, snapshot.artists);
  assert.equal(catalog.length, snapshot.artworks.length, 'every snapshot row must normalize (no silent drops)');
  for (const art of catalog) {
    assert.ok(art.img, `no artwork may lack an image source: ${art.id} ${art.title}`);
    assert.ok(art.url.startsWith('https://lordemaximus.com/artwork/'), `every card must link to the site: ${art.url}`);
    assert.ok(art.title && art.title !== 'Untitled', `every catalog piece has a real title: ${art.id}`);
  }
  const soldRows = snapshot.artworks.filter((row) => String(row.status).toLowerCase() === 'sold');
  const soldMarked = catalog.filter((art) => art.sold);
  assert.equal(soldMarked.length, soldRows.length, 'sold pieces must be carried and marked honestly');
  const picked = ArtSource.pickShowcaseArtworks(catalog, 8);
  assert.equal(picked.length, 8, 'the snapshot alone must fill the carousel');
  for (const art of picked) {
    assert.ok(!ArtSource.FIXTURE_TITLE.test(art.title), `fixture leaked into the showcase: ${art.title}`);
    assert.ok(/^https:\/\//.test(art.img), `showcase images must be real URLs: ${art.img}`);
  }
});

test('the generator left the donor project untouched', () => {
  // Provenance guard: the snapshot says where it came from, and nothing in
  // this repo may write into the donor folder.
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  assert.match(String(snapshot.source), /read-only/i);
  const generator = fs.readFileSync(path.join(root, 'scripts', 'build-artworks-snapshot.mjs'), 'utf8');
  assert.ok(!/writeFileSync\s*\(\s*['"`]?C:[/\\]Users[/\\]london[/\\]Documents/i.test(generator),
    'the generator must never write into the donor project');
});

// ── the homepage page itself ────────────────────────────────────────────────

test('the homepage has no hardcoded art and no dependency on the donor folder', () => {
  const html = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'pages', 'homepage.html'), 'utf8');
  assert.ok(!html.includes('file:///C:/Users/london/Documents'),
    'no runtime path may point into the donor project');
  for (const fake of ['African Wildlife Collection', 'Golden Hour & Serenity', 'Limited Edition Prints', 'Contemporary African Art']) {
    assert.ok(!html.includes(fake), `the invented showcase copy must be gone: ${fake}`);
  }
  assert.ok(html.includes('<script src="artworks-source.js"></script>'), 'the source layer must load with the page');
  assert.ok(html.includes('ArtSource.loadArtworkCatalog()'), 'the carousel must pull the real catalog');
  assert.ok(html.includes('assets/showcase/lorde-design-studio.jpg'), 'studio art must come from local copies');
  assert.ok(html.includes('class="showcase-sold"'), 'sold pieces must be marked honestly');
  assert.ok(!/\bconst SHOWCASE\b/.test(html), 'the showcase list must be data-driven, not a hardcoded array');
});

test('every local image the homepage references exists on disk', () => {
  const html = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'pages', 'homepage.html'), 'utf8');
  // The cards are rendered from JS templates, so asset paths live in string
  // literals and a couple of src= attributes — collect both, skip bare
  // directory prefixes like 'assets/weather-icons/'.
  const refs = new Set([
    ...[...html.matchAll(/src="(assets\/[^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/'(assets\/[^']+)'/g)].map((m) => m[1])
  ]);
  const files = [...refs].filter((ref) => !ref.endsWith('/'));
  assert.ok(files.length >= 7, `expected the studio and weather icon references: ${files.length}`);
  for (const ref of files) {
    const file = path.join(root, 'desktop', 'renderer', 'pages', ref);
    assert.ok(fs.existsSync(file), `missing page asset: ${ref}`);
  }
});
