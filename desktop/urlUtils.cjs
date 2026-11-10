'use strict';

const { pathToFileURL } = require('url');

// Shared address-bar / agent navigation normalization. One source of truth
// for "is this input an address or a search query", used by the main-process
// IPC surface and the agent's BrowserViewController alike.
//
// file:// URLs and Windows drive paths must open the local resource — they
// used to fall through to the search fallback, so navigating to a rendered
// file such as file:///F:/out.png redirected to Google instead.
function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error('Enter a web address or search query.');
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Browser-use accepts http(s) URLs only.');
    return parsed.toString();
  }
  if (/^file:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'file:') throw new Error('Browser-use accepts file:// URLs only with the file: scheme.');
    return parsed.toString();
  }
  if (/^about:(blank)?$/.test(trimmed.toLowerCase())) return 'about:blank';
  // A Windows drive path (F:\folder\file.png or F:/folder/file.png) opens as
  // a local file URL instead of being treated as a search query.
  if (/^[a-z]:[\\/]/i.test(trimmed)) return pathToFileURL(trimmed).toString();
  // Treat whitespace and non-domain text as a search. This avoids turning a
  // normal query such as "design studio examples" into a broken hostname.
  // localhost keeps its own branch so ports AND paths work (localhost:3000/admin).
  const looksLikeHostname = /^(?:localhost(?::\d+)?(?:[/?#].*)?|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?)$/i.test(trimmed);
  if (!looksLikeHostname) return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  return new URL(`https://${trimmed}`).toString();
}

module.exports = { normalizeUrl };
