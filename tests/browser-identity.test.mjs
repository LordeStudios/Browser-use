// BROWSER IDENTITY: the UA must not identify as a non-Chrome product.
//
// Regression being pinned: Electron's default UA inserts the app name before
// the Chrome token —
//   ... (KHTML, like Gecko) lorde-browser-use/0.4.3 Chrome/150.0.7871.129
//   Electron/43.2.0 Safari/537.36
// — and WhatsApp Web reads that first product token as an unsupported browser
// and answers "WhatsApp works with Google Chrome 100+" on a Chromium 150 engine.
// Measured live: default Electron UA passes, app-token UA blocks, clean Chrome
// UA passes, and userAgentData.brands are identical in all three.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const identity = require('../desktop/browserIdentity.cjs');

// Tests run in plain Node, where process.versions.chrome does not exist, so the
// engine version is injected. The app never injects it — it uses the runtime.
const CHROME = '150.0.7871.129';
const MAJOR = Number(CHROME.split('.')[0]);

test('the reported UA never advertises the app name or Electron', () => {
  const ua = identity.buildUserAgent();
  assert.doesNotMatch(ua, /lorde-browser-use/i, 'the app-name token is what WhatsApp sniffs as "unsupported"');
  assert.doesNotMatch(ua, /Electron\//i, 'the Electron token identifies a non-Chrome product');
  assert.doesNotMatch(ua, /browser-use/i);
});

test('the reported UA is a well-formed Chrome UA carrying the real engine version', () => {
  const ua = identity.buildUserAgent({ chromeVersion: CHROME });
  assert.match(ua, /^Mozilla\/5\.0 \(/);
  assert.match(ua, /AppleWebKit\/537\.36/);
  assert.match(ua, /Safari\/537\.36$/);
  assert.match(ua, new RegExp(`Chrome/${CHROME.replace(/\./g, '\\.')}`), 'the version must be the engine we actually run');
  // Chrome must be the first product token after the comment, which is what
  // sniffers read. The comment itself contains a nested group, so take the tail
  // after the LAST ') ' rather than the first split.
  const afterComment = ua.slice(ua.lastIndexOf(') ') + 2);
  assert.ok(afterComment.startsWith('Chrome/'), `Chrome must lead the product tokens, got: ${afterComment}`);
});

test('the version floor only raises the reported version, never lowers it', () => {
  // A floor below the real engine is ignored: we never under-report.
  assert.equal(identity.reportedChromeVersion({ chromeVersion: CHROME, floor: '100' }), CHROME);
  // A floor on a newer major is honoured, so an aged bundle can still pass a
  // site's minimum without shipping a new build.
  const raised = identity.reportedChromeVersion({ chromeVersion: CHROME, floor: `${MAJOR + 5}` });
  assert.equal(Number(raised.split('.')[0]), MAJOR + 5);
  assert.match(identity.buildUserAgent({ chromeVersion: CHROME, floor: `${MAJOR + 5}` }), new RegExp(`Chrome/${MAJOR + 5}\\.`));
});

test('a malformed floor is ignored instead of corrupting the UA', () => {
  for (const bad of ['', 'latest', 'v150', null, undefined, '1e3']) {
    const ua = identity.buildUserAgent({ chromeVersion: CHROME, floor: bad });
    assert.match(ua, /Chrome\/\d+\.\d+\.\d+\.\d+/, `floor ${JSON.stringify(bad)} produced ${ua}`);
    assert.doesNotMatch(ua, /undefined|NaN/);
  }
});

test('client-hint metadata names Google Chrome, matching the UA major', () => {
  const metadata = identity.buildMetadata({ chromeVersion: CHROME });
  const brands = metadata.brands.map((entry) => entry.brand);
  assert.ok(brands.includes('Google Chrome'), 'a site checking brands must see Chrome, not Chromium alone');
  assert.ok(brands.includes('Chromium'));
  assert.ok(brands.some((brand) => /^Not.A Brand$/.test(brand)), 'the GREASE brand must be present or the list is a fingerprint');
  assert.equal(metadata.brands.find((entry) => entry.brand === 'Google Chrome').version, String(MAJOR));
  assert.equal(metadata.mobile, false);
});

test('the global application sets the fallback and returns the same string', () => {
  const fakeApp = {};
  const ua = identity.applyGlobal(fakeApp);
  assert.equal(fakeApp.userAgentFallback, ua);
  assert.match(ua, /Chrome\//);
});

test('the session application sets an explicit UA and language list', () => {
  const calls = [];
  identity.applyToSession({ setUserAgent: (ua, languages) => calls.push([ua, languages]) });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /Chrome\//);
  assert.equal(calls[0][1], 'en-US,en');
});

test('a failing Electron hook never blocks startup', () => {
  const hostile = { get userAgentFallback() { return ''; }, set userAgentFallback(_value) { throw new Error('nope'); } };
  assert.doesNotThrow(() => identity.applyGlobal(hostile));
  assert.doesNotThrow(() => identity.applyToSession({ setUserAgent() { throw new Error('nope'); } }));
});

test('gate detection names the WhatsApp phrasing and ignores ordinary pages', () => {
  assert.equal(identity.detectGate('WhatsApp works with Google Chrome 100+\nTo use WhatsApp, update Chrome'), 'update chrome');
  assert.ok(identity.detectGate('Please update your browser to continue'));
  assert.ok(identity.detectGate('Your browser is out of date'));
  assert.equal(identity.detectGate('Welcome to your inbox. 42 unread messages.'), null);
  assert.equal(identity.detectGate(''), null);
  assert.equal(identity.detectGate(null), null);
});
