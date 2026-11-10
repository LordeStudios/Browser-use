// Address normalization: file:// URLs and Windows drive paths must open the
// local resource (they used to fall through to the Google search fallback,
// so file:///F:/out.png "redirected to Google" instead of opening the file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeUrl } = require('../desktop/urlUtils.cjs');

test('file URLs open locally instead of redirecting to a search', () => {
  assert.equal(normalizeUrl('file:///F:/BlenderRender/modern_room_cinematic.png'), 'file:///F:/BlenderRender/modern_room_cinematic.png');
});

test('windows drive paths convert to file URLs', () => {
  const url = normalizeUrl('F:\\BlenderRender\\modern_room_cinematic.png');
  assert.match(url, /^file:\/\/\/F:\/BlenderRender\/modern_room_cinematic\.png$/);
  assert.equal(normalizeUrl('F:/BlenderRender/scene.blend'), 'file:///F:/BlenderRender/scene.blend');
});

test('about:blank passes through instead of becoming a search', () => {
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.equal(normalizeUrl('ABOUT:BLANK'), 'about:blank');
});

test('web addresses and search queries keep their existing behavior', () => {
  assert.equal(normalizeUrl('https://example.test/page?q=1'), 'https://example.test/page?q=1');
  assert.equal(normalizeUrl('example.test'), 'https://example.test/');
  assert.equal(normalizeUrl('design studio examples'), 'https://www.google.com/search?q=design%20studio%20examples');
  assert.equal(normalizeUrl('localhost:3000/admin'), 'https://localhost:3000/admin');
  assert.throws(() => normalizeUrl('   '), /Enter a web address/);
  // Non-web schemes keep the historical fallback: unknown text becomes a
  // search query rather than a thrown error (only http s with a bad parse
  // throws, and file:// is now first-class).
  assert.equal(normalizeUrl('ftp://example.test/file'), 'https://www.google.com/search?q=ftp%3A%2F%2Fexample.test%2Ffile');
});
