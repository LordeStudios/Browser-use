// Builds desktop/renderer/pages/assets/artworks.json — the offline fallback
// catalog for the homepage Discover carousel.
//
// Source of truth: the lordemaximus.com build artifact at
//   C:\Users\london\Documents\GitHub\uganda-art-pulse\dist\data\artworks.json
// The donor project is READ-ONLY: this script only reads from it and writes
// into THIS repo. Nothing is ever written back to the donor.
//
// The runtime normalizer (desktop/renderer/pages/artworks-source.js) treats
// these rows exactly like live Supabase REST rows, so the fallback path can
// never diverge from the live path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DONOR = 'C:/Users/london/Documents/GitHub/uganda-art-pulse/dist/data/artworks.json';
const OUT = path.join(root, 'desktop', 'renderer', 'pages', 'assets', 'artworks.json');

const donor = JSON.parse(fs.readFileSync(DONOR, 'utf8'));
const rows = Array.isArray(donor.artworks) ? donor.artworks : [];

// Artist names come from the donor's profiles list — resolved at build time so
// the snapshot self-contains them. owner/user_id -> display name.
const artists = {};
for (const profile of Array.isArray(donor.profiles) ? donor.profiles : []) {
  if (!profile || !profile.id) continue;
  const name = String(profile.full_name || profile.name || profile.username || '').trim();
  if (name) artists[String(profile.id)] = name;
}

// Keep only the fields the runtime normalizer reads. The donor rows already
// carry exactly these; this pass also strips anything unexpected so the file
// stays small and its contract is explicit.
const FIELDS = [
  'id', 'owner', 'user_id', 'title', 'price', 'original_price', 'category',
  'medium', 'year', 'status', 'desc', 'description', 'description_general',
  'story', 'inspiration', 'artist_name', 'created_at', 'views', 'views_count',
  'likes', 'likes_count', 'ar', 'cover_aspect_ratio', 'orientation', 'tags',
  'path', 'image_url', 'thumbnail_url', 'image_urls'
];
const artworks = rows.map((row) => {
  const out = {};
  for (const key of FIELDS) if (row[key] !== undefined) out[key] = row[key];
  return out;
});

const snapshot = {
  generated: new Date().toISOString(),
  source: 'uganda-art-pulse/dist/data/artworks.json (read-only donor artifact)',
  site: 'https://lordemaximus.com',
  artists,
  artworks
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot), 'utf8');

const withImages = artworks.filter((a) => a.image_url || a.path).length;
console.log(`artworks: ${artworks.length} (with image source: ${withImages})`);
console.log(`artists: ${Object.keys(artists).length}`);
console.log(`written: ${OUT} (${fs.statSync(OUT).size} bytes)`);
