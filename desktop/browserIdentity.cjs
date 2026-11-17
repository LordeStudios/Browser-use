'use strict';
// ── BROWSER IDENTITY ────────────────────────────────────────────────────────
// Electron's default User-Agent carries two tokens that are not Chrome's:
//
//   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like
//   Gecko) lorde-browser-use/0.4.3 Chrome/150.0.7871.129 Electron/43.2.0
//   Safari/537.36
//
// Site-side sniffers read the product token that follows the comment and
// classify an unrecognised one as "not a supported browser". WhatsApp Web does
// exactly that: on this build (Chromium 150, while it requires Chrome 100+) it
// answers "WhatsApp works with Google Chrome 100+" — a false positive caused by
// the identity string, not by an outdated engine.
//
// Measured on Electron 43.2.0 / Chromium 150.0.7871.129, all four against
// https://web.whatsapp.com/ :
//
//   default Electron UA ...................... gate passes
//   app-name token before Chrome ............. gate blocks   <-- shipped today
//   clean Chrome UA .......................... gate passes
//   userAgentData.brands ..................... identical in every case
//
// So the token is the whole cause, and client hints are NOT involved. That
// negative result matters: it means the fix does not need CDP user-agent
// metadata overrides, which would otherwise have to be attached per tab and
// would have to keep brands and Sec-CH-UA headers consistent.
//
// ── WHY A LAYER AND NOT A STRING ────────────────────────────────────────────
// A hardcoded UA goes stale. Two knobs keep this correct over time:
//   • the reported version tracks the real Chromium, so we never advertise an
//     engine we do not have (lying upward makes sites call APIs that are absent
//     and produces worse failures than the gate itself);
//   • BROWSER_USE_UA_FLOOR raises only the *reported* version when our bundled
//     Chromium has aged past a site's minimum. It is deliberately explicit and
//     off by default: it buys time, and the honest fix is still an Electron
//     bump on our own schedule.
//
// Anything a site gates on that is not identity (a real API we lack) cannot be
// faked forever. `detectGate` exists so that case is observed and named instead
// of arriving as an unexplained blank page.

const DEFAULT_GATE_PHRASES = [
  'update your browser',
  'browser is not supported',
  'browser not supported',
  'unsupported browser',
  'update google chrome',
  'update chrome',
  'works with google chrome',
  'your browser is out of date',
  'please upgrade your browser',
  'this browser version is not supported'
];

// Chromium's real version, e.g. "150.0.7871.129".
function realChromeVersion() {
  const version = String(process.versions.chrome || '');
  return /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version : null;
}

function parseFloor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const match = String(raw).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) return null;
  const [, major, minor = '0', build = '0', patch = '0'] = match;
  return `${Number(major)}.${Number(minor)}.${Number(build)}.${Number(patch)}`;
}

// The version we admit to. Real Chromium unless an explicit floor is higher.
// `options.chromeVersion` exists so the layer is testable outside Electron,
// where process.versions.chrome is absent — the app never passes it.
function reportedChromeVersion(options = {}) {
  const real = parseFloor(options.chromeVersion) || realChromeVersion();
  const floor = parseFloor(options.floor ?? process.env.BROWSER_USE_UA_FLOOR);
  if (!real) return floor || '120.0.0.0';
  if (!floor) return real;
  const [realMajor] = real.split('.').map(Number);
  const [floorMajor] = floor.split('.').map(Number);
  if (floorMajor > realMajor) return floor;
  if (floorMajor === realMajor) return real; // same engine line: keep the truth
  return real;
}

// A Chrome UA with no app token and no Electron token. Everything a site sniffs
// for (Chrome/<version>, platform, WebKit) is truthful; only the branding that
// would identify a non-Chrome product is gone.
function buildUserAgent(options = {}) {
  const version = reportedChromeVersion(options);
  const platform = options.platform || process.platform;
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }
  if (platform === 'linux') {
    return `Mozilla/5.0 (X11; Linux ${arch}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

// Only needed by callers that deliberately override identity through CDP
// (device emulation, per-site testing). Not required for the gate fix.
function buildMetadata(options = {}) {
  const version = reportedChromeVersion(options);
  const major = String(version).split('.')[0];
  const platform = options.platform || process.platform;
  const platformName = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'Windows';
  return {
    brands: [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major }
    ],
    fullVersionList: [
      { brand: 'Not_A Brand', version: '8.0.0.0' },
      { brand: 'Chromium', version },
      { brand: 'Google Chrome', version }
    ],
    fullVersion: version,
    platform: platformName,
    platformVersion: platformName === 'Windows' ? '15.0.0' : '14.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false
  };
}

// Global application. `userAgentFallback` is consulted when a webContents is
// created, so setting it once covers every tab, every future tab, popups and
// any session the app has not built yet — no per-tab bookkeeping to forget.
function applyGlobal(electronApp, options = {}) {
  const userAgent = buildUserAgent(options);
  try { electronApp.userAgentFallback = userAgent; } catch { /* never block startup on identity */ }
  return userAgent;
}

// Belt and braces for the managed browsing partition: an explicit session UA
// survives even if a future Electron build changes fallback semantics.
function applyToSession(targetSession, options = {}) {
  const userAgent = buildUserAgent(options);
  try { targetSession.setUserAgent(userAgent, 'en-US,en'); } catch { /* see above */ }
  return userAgent;
}

// Passive detector: names the gate instead of letting it present as a blank page.
// Returns null when the text carries no gate marker.
function detectGate(text, phrases = DEFAULT_GATE_PHRASES) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  for (const phrase of phrases) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

module.exports = {
  DEFAULT_GATE_PHRASES,
  buildMetadata,
  buildUserAgent,
  detectGate,
  realChromeVersion,
  reportedChromeVersion,
  applyGlobal,
  applyToSession
};
