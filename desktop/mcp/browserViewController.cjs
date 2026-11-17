'use strict';

const ANONYMOUS_INPUT_OWNER = 'gpt-action-bridge';
// capturePage() resolves only when the compositor produces a frame, and a view
// detached by an open drawer never produces one. Without a ceiling the promise
// never settles, so the MCP request hangs until the host gives up.
const CAPTURE_TIMEOUT_MS = 4_000;
// A document can keep loading analytics, fonts, or third-party resources long
// after its main frame is ready for a grounded DOM action. Agent navigation is
// complete at main-frame commit, not at an arbitrary network-idle tail.
const NAVIGATION_COMMIT_TIMEOUT_MS = 12_000;
// The pointer renderer caps one eased trajectory at 360ms. Keeping drag
// segments below that ceiling prevents a long low-step drag from arriving,
// idling, fading, and only reappearing for its release edge.
const POINTER_DRAG_SEGMENT_MAX_MS = 300;
// Chromium forwards a synthetic mouse move to the renderer immediately but can
// take SECONDS to acknowledge it: this fork measured ~5.1s per move, which made
// a single hover cost 5s and a 4-step drag 25.5s. The acknowledgement is not the
// delivery — CDP processes commands in order on one session — so waiting for it
// added dead time without changing where the event landed. Bound it, and release
// the tab's serialization slot at the same budget so one slow move cannot stall
// the next call. The reply, if it arrives late, is still observed.
// 1.2s was still the whole cost of a hover: the reply is advisory, so the budget
// only needs to cover a healthy acknowledgement. When it is exceeded the result
// says `acknowledged:false` and the caller learns the truth without paying for
// it. An unacknowledged move is still ordered ahead of every later command.
const MOUSE_MOVE_ACK_BUDGET_MS = 250;
// A wheel's acknowledgement is NOT proof the default scroll action ran — the
// document's own scroll position is. Chromium can defer the wheel reply past any
// sensible budget, so this is a short observation window; `scroll()` then polls
// the document itself for the real answer instead of waiting on the reply.
const MOUSE_WHEEL_ACK_BUDGET_MS = 1_200;
// How long scroll() watches the document for the effect of its own wheel before
// deciding the delivery was unknown.
const SCROLL_SETTLE_POLLS = 6;
const SCROLL_SETTLE_INTERVAL_MS = 60;
// Chromium DISCARDS mouse and wheel input for a hidden render widget, and a
// Browser-use window that is merely occluded — the agent's own chat window in
// front, another app maximised over it, or a minimised window — is enough to
// hide it. The event then lands nowhere while the call still looks successful:
// the live measurement for this fork was 0 mousemove and 0 wheel DOM events
// across 3 hovers and 3 scrolls on a painted tab, which is the same
// "six foreground clicks, zero page effect" failure class as the chess run.
// The page states its own visibility in ~13ms, so gate every pointer path on it.
const INPUT_VISIBILITY_TTL_MS = 2_000;
// After raising the window, how long to wait for the renderer to report visible
// again. Occlusion recovery is fast, but it crosses a window-manager round trip.
const INPUT_RAISE_SETTLE_MS = 700;
const INPUT_VISIBILITY_POLL_MS = 60;
// When a search engine interstitials a human-verification challenge, the
// search call waits this long for a human to clear it in the visible window
// (the agent surfaces a notice), then resumes automatically. The user's own
// hand must complete the challenge — the app never fills or bypasses it.
const CAPTCHA_HUMAN_WAIT_MS = 90_000;
const CAPTCHA_POLL_INTERVAL_MS = 3_000;

class BrowserViewController {
  constructor({ getTabs, getSelectedTabId, getConsoleEntries, normalizeUrl, createTab = null, closeTab = null, isTabPaintable = null, ensureTabPaintable = null, raiseForInput = null, selectTab = null, deviceEmulator = null, debuggerLeaseManager = null, pointerVisualizer = null, onDeviceModeChanged = null, fileDialogBridge = null }) {
    this.getTabs = getTabs;
    this.getSelectedTabId = getSelectedTabId;
    this.createTabCallback = createTab;
    this.closeTabCallback = closeTab;
    this.getConsoleEntries = getConsoleEntries;
    this.normalizeUrl = normalizeUrl;
    // Reports whether a tab currently owns a compositor surface. Screenshots fail
    // fast and explain themselves instead of hanging when it does not.
    this.isTabPaintable = isTabPaintable;
    // The selected BrowserView can be transiently detached by an Electron
    // layout/z-order pass. The shell may reattach only that already-selected
    // view once before native input fails closed.
    this.ensureTabPaintable = ensureTabPaintable;
    // Brings the Browser-use window back above whatever is covering it. Chromium
    // stops delivering pointer input to an occluded view, so a pointer action
    // taken while the user is looking at another window cannot land without
    // this. Injected because only main owns the BrowserWindow.
    this.raiseForInput = typeof raiseForInput === 'function' ? raiseForInput : null;
    // Selects a tab in the shell. Binding a tab that is not on screen would
    // otherwise bind a renderer that can never receive input.
    this.selectTab = typeof selectTab === 'function' ? selectTab : null;
    // Per-tab memo of the last visibility verdict, so a drag or a click does not
    // pay a page round trip per event. Visibility does not change mid-gesture.
    this.inputVisibility = new Map();
    // Present when device emulation is available. Under a mobile or tablet
    // profile the pointer is not an input device at all, so the mouse tools
    // refuse rather than silently sending events the page cannot receive.
    this.deviceEmulator = deviceEmulator;
    this.onDeviceModeChanged = typeof onDeviceModeChanged === 'function' ? onDeviceModeChanged : null;
    this.debuggerLeaseManager = debuggerLeaseManager;
    // File dialog bridge: answers native Open dialogs and routes Save/downloads
    // to a directory so the agent never has to operate the OS dialog. Injected
    // because this module stays dependency-free (main owns the instance).
    this.fileDialogBridge = fileDialogBridge;
    // App-owned visualization is isolated from the controlled page. The
    // visualizer may wait for a smooth arrival, but it never changes target DOM
    // and never decides which WebContents receives the native event.
    this.pointerVisualizer = pointerVisualizer;
    // owner -> { tabId, buttons, keys, buttonRoutes }. Held input is
    // tracked per caller so revoking one session cannot release another's keys.
    this.heldInput = new Map();
    this.sessionInputGeneration = new Map();
    this.tabInputGeneration = new Map();
    this.pointerActionGeneration = new Map();
    // Set while the input path re-lays-out its own surface (see prepareNativeInput).
    this.suppressPointerInvalidation = false;
    // Only the newest top-level pointer operation for a tab may still own a
    // visual trajectory. Keeping the operation itself lets cancellation stop
    // the overlay at its currently rendered point instead of merely dropping
    // the eventual native event after a stale animation has finished.
    this.activePointerOperations = new Map();
    // Automatic cleanup (session end, resize, tab invalidation) can release a
    // held button before the caller's already-planned mouseUp arrives. A short
    // tombstone lets that matching edge be consumed exactly once while keeping
    // genuinely untracked recovery mouseUp calls valid.
    this.releasedButtonTombstones = new Map();
    // owner/tab/button -> { promise }. A tab-scoped CDP mouseUp is asynchronous.
    // Cleanup that races it must join the same delivery instead of enqueueing a
    // second release while the first one is still awaiting the debugger queue.
    this.pendingButtonReleases = new Map();
    // Tabs whose page probe has been armed (a hit test or observation returned
    // probe data). Delivery enforcement only acts on armed probes: an empty
    // list from a just-installed probe proves nothing.
    this.clickProbeArmed = new Set();
    // Visualizer circuit breaker: tabs whose pointer overlay never acks. A
    // dead overlay must not tax every stage with its timeout — two strikes and
    // the tab stops waiting on the visual (input goes straight to delivery).
    this.visualizerStrikes = new Map();
    this.visualizerBroken = new Set();
    // Learned delivery channel per tab: 'native' once CDP input proved
    // swallowed. Reusing it skips a dead dispatch + probe + retry per click.
    this.deliveryChannel = new Map();
    this.globalInputGeneration = 0;
    // tabId -> { at, elements[] }. Snapshot indices are only valid for the newest
    // DOM read of that tab, which keeps index-based clicks deterministic.
    this.elementSnapshots = new Map();
    // tabId -> { x, y }. The last place the agent pointer was placed, so wheel
    // and release events can keep the visible cursor near the relevant content.
    this.lastPointer = new Map();
    // tabId -> { width, height, scrollX, scrollY }. DOM reads establish the
    // CSS viewport used by all BrowserView input coordinates.
    this.lastViewport = new Map();
  }

  selectedTabId() {
    const tabId = this.getSelectedTabId();
    if (!tabId) throw new Error('No active Browser-use tab is available');
    this.requireTab(tabId);
    return tabId;
  }

  listTabs() {
    return this.getTabs().map((tab) => summarizeTab(tab, this.getSelectedTabId?.()));
  }

  createTab(url = 'about:blank') {
    if (!this.createTabCallback) throw new Error('Creating a new tab is unavailable.');
    const tab = this.createTabCallback(url, false);
    return summarizeTab(tab, this.getSelectedTabId?.());
  }

  closeTab(tabId) {
    if (!this.closeTabCallback) throw new Error('Closing a tab is unavailable.');
    return this.closeTabCallback(String(tabId));
  }

  getTab(tabId) {
    return summarizeTab(this.requireTab(tabId), this.getSelectedTabId?.());
  }

  // ---- File dialogs (open / save / attach) -------------------------------
  // Owner directive: the agent must be able to complete an Open or Save
  // dialog without the OS dialog, and it must know when one is waiting.

  requireFileDialogBridge() {
    if (!this.fileDialogBridge) {
      const error = new Error('File dialog bridge is unavailable in this build.');
      error.code = 'FILE_DIALOG_BRIDGE_MISSING';
      throw error;
    }
    return this.fileDialogBridge;
  }

  /** Arms interception for the bound tab; safe to call before triggering a picker. */
  async fileDialogArm(tabId) {
    const bridge = this.requireFileDialogBridge();
    const webContents = this.requireTab(tabId).webContents;
    const state = await bridge.attach(webContents);
    return { tabId, ...state };
  }

  /** Reports whether a chooser is open, its mode, and recent downloads. */
  async fileDialogState(tabId) {
    const bridge = this.requireFileDialogBridge();
    if (tabId) {
      const webContents = this.requireTab(tabId).webContents;
      await bridge.attach(webContents);
    }
    return { tabId: tabId || null, ...bridge.state() };
  }

  /** Answers the open dialog with real files — no OS dialog is shown. */
  async fileDialogAccept(tabId, { files, selector = null } = {}) {
    const bridge = this.requireFileDialogBridge();
    const webContents = this.requireTab(tabId).webContents;
    await bridge.attach(webContents);
    return bridge.accept(files, { selector });
  }

  async fileDialogCancel(tabId) {
    const bridge = this.requireFileDialogBridge();
    const webContents = this.requireTab(tabId).webContents;
    await bridge.attach(webContents);
    return bridge.cancel();
  }

  /** Downloads (Save As) land in this directory instead of prompting. */
  async downloadsSetPath(tabId, { directory } = {}) {
    const bridge = this.requireFileDialogBridge();
    const webContents = this.requireTab(tabId).webContents;
    await bridge.attach(webContents);
    return bridge.setDownloadPath(directory);
  }

  async downloadsList() {
    return { downloads: this.requireFileDialogBridge().listDownloads() };
  }

  /** Writes agent-supplied content to disk with no dialog involved. */
  async saveFileToDisk({ path: target, text = null, base64 = null } = {}) {
    return this.requireFileDialogBridge().saveFile(target, { text, base64 });
  }

  async screenshot(tabId) {
    const tab = this.requireTab(tabId);
    const captureViaCdp = async () => {
      if (!this.debuggerLeaseManager) {
        throw new Error('The bound tab is not currently painted, so background visual capture is unavailable. Restore or reattach the browsing view, continue with DOM observation, or select the tab manually.');
      }
      // BUG FIX: For background/detached tabs, use fromSurface: false to avoid
      // waiting for a compositor frame that will never arrive. This prevents the
      // "run holds at pause until user switches to attached tab" issue.
      const tab = this.requireTab(tabId);
      const isPaintable = this.isTabPaintable?.(tabId);
      const fromSurface = isPaintable !== false; // Only use fromSurface if tab is paintable
      
      return withTimeout(
        this.debuggerLeaseManager.send(tabId, 'background screenshot', 'Page.captureScreenshot', { format: 'png', fromSurface }),
        CAPTURE_TIMEOUT_MS,
        'Timed out capturing the background tab: the browsing view is not producing frames. This is the normal signature of a minimised or fully occluded Browser-use window, or of a view detached by an open drawer. Bring the window to the front, then retry — or continue with DOM observation, which needs no frames.'
      ).then(async (result) => {
        if (!result?.data) throw new Error('Background visual capture returned no image data. Continue with DOM observation or select the tab manually.');
        const metadata = result?.metadata || {};
        const cssViewport = await this.captureCssViewport(tabId);
        const width = Number(metadata.width) || 0;
        const height = Number(metadata.height) || 0;
        const scaleX = width > 0 && cssViewport?.width > 0 ? width / cssViewport.width : null;
        const scaleY = height > 0 && cssViewport?.height > 0 ? height / cssViewport.height : null;
        return { tabId, mimeType: 'image/png', data: result.data, source: 'cdp',
          screenshotId: `shot-${tabId}-${Date.now()}`,
          width, height, coordinateSpace: 'browser-view-physical-pixels',
          cssViewport, scaleX, scaleY, devicePixelRatio: this.pageDevicePixelRatio?.(tabId) ?? null, capturedAt: Date.now(),
          url: String(tab.webContents.getURL?.() || ''), title: String(tab.webContents.getTitle?.() || '') };
      });
    };
    if (this.isTabPaintable?.(tabId)) {
      try {
        const image = await withTimeout(
          tab.webContents.capturePage(),
          CAPTURE_TIMEOUT_MS,
          'Timed out capturing the bound tab. The browsing view is not producing frames — close any open drawer, or make sure the Browser-use window is not minimised, then retry.'
        );
        // Coordinate contract: capturePage returns PHYSICAL pixels of the
        // BrowserView, while clickAt/viewportPoint consume CSS viewport pixels.
        // Ship both sizes plus the derived image→CSS scale so screenshot-derived
        // coordinates (canvas games, pixel reasoning) can be mapped exactly at
        // any devicePixelRatio, zoom, or window size.
        const size = image.getSize();
        const cssViewport = await this.captureCssViewport(tabId);
        const scaleX = cssViewport?.width > 0 ? size.width / cssViewport.width : null;
        const scaleY = cssViewport?.height > 0 ? size.height / cssViewport.height : null;
        return { tabId, mimeType: 'image/png', data: image.toPNG().toString('base64'), source: 'capturePage',
          screenshotId: `shot-${tabId}-${Date.now()}`,
          width: size.width, height: size.height, coordinateSpace: 'browser-view-physical-pixels',
          cssViewport, scaleX, scaleY, devicePixelRatio: this.pageDevicePixelRatio?.(tabId) ?? null, capturedAt: Date.now(),
          // Identity rides the result (run-forensics 2026-10-15): a screenshot
          // with no url/title let the model confuse a file:// reference image
          // with the live page — four times in one run.
          url: String(tab.webContents.getURL?.() || ''), title: String(tab.webContents.getTitle?.() || '') };
      } catch (error) {
        // A paintable tab can still stop producing frames (occluded or
        // minimised window, drawer detach). Fall through to the CDP background
        // capture instead of failing the caller — that path never needs a
        // compositor surface. Without a lease manager, rethrow the original
        // bounded error.
        if (!this.debuggerLeaseManager) throw error;
      }
    }
    // A detached target cannot safely use capturePage(), which can wait forever
    // for a compositor frame. Ask the shared CDP lease for a bounded background
    // capture instead; it must never foreground or attach the target view.
    return captureViaCdp();
  }

  async executePageScript(tabId, { script } = {}) {
    if (typeof script !== 'string' || !script.trim()) throw new Error('browser_execute requires a non-empty script.');
    if (script.length > 12_000) throw new Error('browser_execute script exceeds the 12,000 character limit.');
    const tab = this.requireTab(tabId);
    // The script is evaluated solely inside the bound renderer. It has no Node
    // integration and must return JSON-serializable proof of the actions it did.
    // Body-style scripts carry their own `return`; an expression-style script
    // (an IIFE or a plain expression) must be wrapped in `return (...)` or its
    // value is silently discarded and the model reads back only `{tabId}`.
    const trimmed = script.trim();
    // An IIFE or any script that opens with `(` is an expression, even when it
    // contains its own internal `return` statements — it must be wrapped in
    // `return (...)` or its value is silently discarded and the model reads
    // back only `{tabId}`.
    const isExpression = /^\(/.test(trimmed);
    // A single bare statement with no separators (e.g. `document.title`) is
    // also an expression. Anything else is a statement body: it yields a value
    // only when it carries its own top-level `return`.
    const isSingleBareStatement = !isExpression && !/[;\n]/.test(trimmed) && !/^(?:const |let |var |await |return |if |for |while |try |function )/.test(trimmed);
    const hasTopLevelReturn = /(^|[;{}])\s*return\b/.test(script);
    const source = isExpression || isSingleBareStatement
      ? `(async () => { return (\n${script}\n); })()`
      : `(async () => { ${script}\n})()`;
    const result = await this.evaluatePage(tab, 'browser command', source, 12_000,
      'Timed out executing the browser command. Inspect the returned page state and retry with a smaller command.');
    return { tabId, result };
  }

  // Compose a web search in the given tab and return bounded organic results.
  // No summarization: the model reads titles/hrefs and chooses what to open.
  // engine: 'google' (default — real Google in the session's real tab with the
  // user's cookies; the occasional, human-paced search a normal user makes)
  // or 'duckduckgo' (the lightweight html endpoint — a known scraping entry
  // point that increasingly interstitials an anomaly challenge, so it is no
  // longer the research default).
  //
  // If a human-verification challenge appears, the call waits up to
  // CAPTCHA_HUMAN_WAIT_MS for the human to clear it in the visible window,
  // then collects results automatically. It never fills or bypasses the
  // challenge — defeating the anti-bot check is not something this app does;
  // it makes the user's IP and session look worse, not better.
  async search(tabId, { query, maxResults, engine = 'google' } = {}) {
    const text = String(query || '').trim();
    if (!text) throw new Error('browser_search requires a non-empty query string.');
    const limit = Math.min(Math.max(Number(maxResults) || 8, 1), 20);
    const useDuckDuckGo = engine === 'duckduckgo';
    const navigation = await this.navigate(tabId, useDuckDuckGo
      ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(text)}`
      : `https://www.google.com/search?q=${encodeURIComponent(text)}&num=${Math.min(limit + 4, 20)}`);
    // A challenge wall means zero organic results — detect it before reading
    // the DOM so the caller can tell "blocked" apart from "no hits", and give
    // the human the full wait window to clear it.
    const captchaKind = await this.waitForCaptchaClear(tabId);
    if (captchaKind) {
      return {
        query: text,
        url: navigation?.url || null,
        loading: false,
        results: [],
        resultCount: 0,
        captcha: true,
        captchaKind,
        notice: `The search engine is showing a human-verification challenge (${captchaKind}). ${CAPTCHA_HUMAN_WAIT_MS / 1000}s were left for a human to complete it in the visible browsing window, but it did not clear. Ask the user to solve the challenge, then search again.`
      };
    }
    const collected = await this.queryElements(tabId, useDuckDuckGo
      ? { selector: 'a.result__a', maxElements: 60, interactiveOnly: false }
      : { selector: 'a[href]:has(h3)', maxElements: 60, interactiveOnly: false });
    const seen = new Set();
    const results = [];
    for (const element of collected?.elements || []) {
      const rawHref = String(element.href || '');
      // DuckDuckGo wraps result links in /l/?uddg=<encoded-url> redirects.
      const href = useDuckDuckGo ? decodeDuckDuckGoHref(rawHref) : rawHref;
      const title = String(element.name || element.text || '').replace(/\s+/g, ' ').trim();
      if (!href.startsWith('http') || !title) continue;
      const key = href.split('#')[0];
      if (seen.has(key)) continue;
      if (!useDuckDuckGo && (/google\.[^/]+\/(?:search|preferences|intl|advanced)/.test(href) || /accounts\.google\.|policies\.google\./.test(href))) continue;
      if (useDuckDuckGo && /duckduckgo\.com\/(?:y\.js|l\/)/.test(href)) continue;
      seen.add(key);
      results.push({ title: title.slice(0, 200), href: key.slice(0, 500) });
      if (results.length >= limit) break;
    }
    if (results.length) return { query: text, url: navigation?.url || collected?.url || null, loading: Boolean(navigation?.loading), results, resultCount: results.length };
    const fallback = await this.queryElements(tabId, { maxElements: 20, interactiveOnly: false });
    return {
      query: text,
      url: navigation?.url || fallback?.url || null,
      loading: Boolean(navigation?.loading),
      results,
      resultCount: 0,
      notice: 'No organic result links were collected; the page elements below describe what actually rendered (for example a consent or captcha screen).',
      elements: (fallback?.elements || []).slice(0, 10).map(element => ({ tag: element.tag, text: String(element.name || element.text || '').slice(0, 120) }))
    };
  }

  // Detect a human-verification interstitial in the tab: Google's /sorry/
  // wall, an embedded reCAPTCHA widget, or DuckDuckGo's anomaly challenge.
  // Returns a short kind string, or '' when the page looks like a normal
  // results page. A destroyed or navigating tab reads as clear — the search
  // flow fails honestly downstream in that case.
  async detectCaptcha(tabId) {
    try {
      const tab = this.requireTab(tabId);
      const kind = await this.evaluatePage(tab, 'captcha detection', `(() => {
        const href = String(location.href || '');
        if (/google\\.[a-z.]+\\/sorry/i.test(href)) return 'google-sorry';
        if (document.querySelector('iframe[src*="recaptcha" i], iframe[title*="recaptcha" i], .g-recaptcha, #captcha-form, form[action*="captcha" i]')) return 'recaptcha-widget';
        const body = String((document.body && document.body.innerText) || '').slice(0, 4000);
        if (/unusual traffic|not a robot|confirm you are human|are you a robot/i.test(body)) return 'challenge-page';
        if (/duckduckgo\\.com/i.test(href) && /anomaly|captcha/i.test(body)) return 'ddg-anomaly';
        return '';
      })()`, 8_000, '');
      return String(kind || '').trim();
    } catch {
      return '';
    }
  }

  // If a challenge is up, give the human CAPTCHA_HUMAN_WAIT_MS to complete it
  // in the visible window, re-checking periodically. Returns null once the
  // page is clear (including "was never blocked"), or the lingering kind when
  // the wait expired with the wall still up.
  async waitForCaptchaClear(tabId) {
    let kind = await this.detectCaptcha(tabId);
    if (!kind) return null;
    const deadline = Date.now() + CAPTCHA_HUMAN_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, CAPTCHA_POLL_INTERVAL_MS));
      kind = await this.detectCaptcha(tabId);
      if (!kind) return null;
    }
    return kind;
  }

  // Node-side bounded text fetch (no CORS, no page interference): read-only,
  // scripts/styles stripped from HTML, size- and time-capped. The model gets
  // raw text to reason over; no summarization happens here.
  async fetchPage({ url, maxLength } = {}) {
    const limit = Math.min(Math.max(Number(maxLength) || 20_000, 200), 100_000);
    const target = String(url || '').trim();
    let parsed;
    try { parsed = new URL(target); } catch { return { ok: false, url: target, error: 'browser_fetch requires an absolute http(s) URL.' }; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, url: target, error: 'Only http and https URLs can be fetched.' };
    const signal = AbortSignal.timeout(15_000);
    try {
      const response = await fetch(parsed, { signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Browser-use/1.0' } });
      const contentType = String(response.headers.get('content-type') || '');
      if (!/text\/|json|xml/i.test(contentType)) {
        return { ok: false, url: response.url || target, status: response.status, contentType, error: `Unsupported content type ${contentType || 'unknown'}; use the browser tools for this resource.` };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const body = fetchBodyText(buffer, contentType).slice(0, limit);
      return {
        ok: true,
        url: response.url || target,
        status: response.status,
        contentType: contentType.split(';')[0] || null,
        truncated: body.length >= limit,
        body
      };
    } catch (error) {
      return { ok: false, url: target, error: String(error?.cause?.message || error?.message || error).slice(0, 300) };
    }
  }

  async domSnapshot(tabId, options = {}) {
    const tab = this.requireTab(tabId);
    const payload = await this.readElements(tab, options);
    this.elementSnapshots.set(tabId, { at: Date.now(), elements: payload.elements });
    // LORDE_OBSERVE_TEXT: the observation carried only interactive elements, so
    // an agent that needed the page's instructions dumped 26 KB of HTML twice.
    // A bounded text excerpt answers "what does this page say" directly.
    //
    // FRAME AWARENESS: the element collector below runs against ONE document, so
    // a page that renders inside a same-origin iframe reads as an empty shell.
    // That is not a per-site quirk — TikTok Business Suite, Stripe, Salesforce,
    // Intercom and most embedded dashboards all do it. Live cost of missing it:
    // reading one TikTok DM took 10 hand-written probes over 6m55s, because the
    // first snapshot reported "Business Suite | TikTok" plus footer links and
    // the agent had to discover the frame blind. One call now names every frame
    // and quotes it.
    try {
      const overview = await this.evaluatePage(tab, 'page text', buildFrameOverviewScript(), 4_000, '');
      if (typeof overview === 'string' && overview.trim()) payload.text = overview.trim();
      else {
        if (typeof overview?.text === 'string' && overview.text.trim()) payload.text = overview.text.trim();
        // Only advertise frames that actually exist; an empty array is noise on
        // the overwhelming majority of pages.
        if (Array.isArray(overview?.frames) && overview.frames.length) payload.frames = overview.frames;
      }
    }
    catch { /* text and frames are aids, never a reason to fail the snapshot */ }
    return payload;
  }

  async queryElements(tabId, options = {}) {
    const tab = this.requireTab(tabId);
    // LORDE_QUERY_TEXT_NODES: an explicit selector must return what it matched.
    // Defaulting to interactive-only made `browser_query { selector: '#log' }`
    // answer count: 0 on a page where that node exists and holds the evidence.
    const hasSelector = typeof options.selector === 'string' && options.selector.trim().length > 0;
    const payload = await this.readElements(tab, hasSelector
      ? { ...options, interactiveOnly: false }
      : options);
    // Query results expose element indices, so they must share the same current
    // index map that click/type resolve instead of creating a stale side channel.
    this.elementSnapshots.set(tabId, { at: Date.now(), elements: payload.elements });
    return payload;
  }

  async elementRect(tabId, { index }) {
    const snapshotElement = this.resolveElementIndex(tabId, index);
    const tab = this.requireTab(tabId);
    let [resolved] = (await this.readElements(tab, {
      selector: snapshotElement.selector,
      maxElements: 1,
      interactiveOnly: false,
      includeText: true,
      // Re-resolve in the frame the element was found in: the selector is
      // frame-local, so searching the top document would report it stale.
      framePath: snapshotElement.framePath || null
    })).elements;
    if (!resolved) {
      // Dynamic pages frequently rebuild hashed/nth-child DOM between observation
      // and action. Refresh once and rematch by stable identity before declaring
      // the model's index stale; never fall back to the same numeric index.
      const fresh = await this.readElements(tab, { maxElements: 250, interactiveOnly: true, includeText: true, framePath: snapshotElement.framePath || null });
      resolved = bestElementMatch(snapshotElement, fresh.elements);
      this.elementSnapshots.set(tabId, { at: Date.now(), elements: fresh.elements });
    }
    if (!resolved) throw new Error(`Element index ${index} is stale; observe the page again before retrying the action.`);
    return resolved;
  }

  // A device profile removes the mouse from the page's input model, so a mouse
  // tool called there would dispatch events nothing can receive. Refusing names
  // the gesture tool to use instead, so an agent can correct itself.
  assertPointerAllowed(tabId, toolName) {
    if (!this.deviceEmulator?.isTouchMode(tabId)) return;
    const state = this.deviceEmulator.state(tabId);
    throw new Error(`${toolName} is unavailable while the ${state.label} ${state.mode} profile is active: the page receives touch input only. Use browser_gesture (tap, swipe, scroll, pinch, longPress) instead, or switch to the desktop profile with browser_set_device_mode.`);
  }

  async clickElement(tabId, { index, button = 'left' } = {}, sessionId) {
    // The operation begins before the asynchronous DOM lookup. A session that
    // is revoked while a dynamic page is resolving the element must not regain
    // authority later by creating a fresh post-cancellation click token.
    const operation = this.inputOperationToken(sessionId, tabId);
    try {
      const element = await this.elementRect(tabId, { index });
      if (!this.inputOperationCurrent(operation)) {
        return { tabId, index, input: 'interrupted', button: normalizeButton(button), element, pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
      }
      // A disabled control swallows the click silently, which reads to the
      // model as success (the live run clicked a disabled Save button three
      // times and waited for a download that could never start).
      if (element && element.enabled === false) {
        return {
          tabId,
          index,
          input: 'none',
          button: normalizeButton(button),
          element,
          ok: false,
          recoverable: true,
          error: `"${element.name || element.id || 'The control'}" is disabled, so the click would do nothing. Satisfy whatever enables it first (attach a file, fill the form, accept the terms), then click again.`
        };
      }
      const center = element.center;
      // Clicking by index stays meaningful under a device profile; only the
      // delivery changes, so the same call taps instead of pressing a button.
      if (this.deviceEmulator?.isTouchMode(tabId)) {
        await this.deviceEmulator.performGesture(tabId, 'tap', { x: center.x, y: center.y });
        return { tabId, index, input: 'touch', gesture: 'tap', element };
      }
      const click = await this.clickAt(tabId, { ...center, button }, sessionId, operation);
      // clickAt already ran the post-input hit test at the element center;
      // dropping it left indexed clicks as the ONE delivery without landing
      // evidence (the live chess run repeated a dead button click six times
      // blind). Carry the hit so the model sees where the click actually
      // landed — for an element click the tag should match the target.
      return { tabId, index, input: click.input, button: normalizeButton(button), element, ...(click.pointer ? { pointer: safePointerProjection(click.pointer) } : {}), ...(click.hit ? { hit: click.hit } : {}), ...this.fileChooserHint() };
    } finally {
      this.finishInputOperation(operation);
    }
  }

  /**
   * LORDE_FILE_DIALOG_HINT: a click that opens a native picker must say so in
   * its own reply. Without this the model went hunting through desktop windows
   * (computer_observe, Alt+F4) while a chooser was already waiting on the tab.
   */
  fileChooserHint() {
    const pending = this.fileDialogBridge?.pending;
    if (!pending) return {};
    return {
      fileChooser: { pending: true, mode: pending.mode, multiple: pending.multiple, backendNodeId: pending.backendNodeId },
      nextAction: `A native file chooser just opened (${pending.mode}). Answer it with browser_file_dialog_accept { files: [absolute paths] } — do not use computer_* or look for an OS window.`
    };
  }

  async clickAt(tabId, { x, y, button = 'left' } = {}, sessionId, inputOperation = null) {
    const ownsOperation = !inputOperation;
    const operation = inputOperation || this.inputOperationToken(sessionId, tabId);
    // Every click route below either rides CDP mouse input or sendInputEvent,
    // and Chromium discards both for a hidden renderer. Prove the view can
    // receive input before animating, dispatching, or reporting a hit.
    // The gate is only awaited when it is active: yielding an extra microtask
    // here would reorder a click behind a newer pointer action issued in the
    // same tick.
    const pendingGate = this.mouseInputGate(tabId);
    const inputGate = pendingGate ? await pendingGate : {};
    const priorPointer = this.lastPointer.get(tabId);
    // Board games treat a click on the already-clicked point as a DESELECT:
    // the live chess run repeated the same square three and four times because
    // nothing in the reply told it that. Name the repeat in the reply so the
    // model can tell an aimed second click from an accidental re-click.
    const repeatPoint = Number(priorPointer?.x) === Number(x) && Number(priorPointer?.y) === Number(y);
    try {
      const prepared = this.prepareNativeInput(tabId);
      const normalizedButton = normalizeButton(button);
      const background = this.getSelectedTabId() !== tabId || prepared.forceBackground;
      if (!background && this.deliveryChannel.get(String(tabId)) === 'native') {
        // Learned channel: CDP input proved swallowed on this tab, so the
        // native pipeline IS the click path (one injection + probe, no dead
        // dispatch). Real-time sequences are impossible while paying for a
        // dead channel on every click.
        this.assertPointerAllowed(tabId, 'browser_click');
        if (!this.inputOperationCurrent(operation)) return { tabId, x, y, input: 'interrupted', button: normalizedButton, pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
        this.lastPointer.set(tabId, { x, y });
        const native = await this.clickViaNative(tabId, { x, y, button: normalizedButton, sessionId, operation });
        return {
          tabId, x, y, input: 'mouse', button: normalizedButton,
          ...(repeatPoint ? { repeatPoint: true } : {}),
          ...(native ? { delivered: native.delivered, delivery: 'native' } : {}),
          ...inputGate,
          hit: native?.hit || null
        };
      }
      if (background && typeof this.debuggerLeaseManager?.sendBatch === 'function') {
        this.assertPointerAllowed(tabId, 'browser_click');
        if (!this.inputOperationCurrent(operation)) return { tabId, x, y, input: 'interrupted', button: normalizedButton, pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
        this.lastPointer.set(tabId, { x, y });
        await this.debuggerLeaseManager.sendBatch(tabId, 'background click input', [
          { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } },
          { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: normalizedButton, buttons: mouseButtonMask(normalizedButton), clickCount: 1 } },
          { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: normalizedButton, buttons: 0, clickCount: 1 } }
        ]);
        const hit = await this.hitTest(tabId, { x, y }).catch(() => ({ hit: null, reason: 'hit-test-unavailable' }));
        return { tabId, x, y, input: 'cdp-background', button: normalizedButton, pointer: { mode: 'cdp-native-input', x, y, pageMutation: false }, batched: true, ...inputGate, hit };
      }
      const moved = await this.mouseMove(tabId, { x, y }, { operation, sessionId });
      if (!this.inputOperationCurrent(operation) || inputDeliveryFailed(moved)) return { tabId, x, y, input: 'interrupted', button: normalizeButton(button), pointer: safePointerProjection(moved.pointer) };
      const pressed = await this.mouseDown(tabId, { x, y, button }, sessionId, operation);
      if (inputDeliveryFailed(pressed)) return { tabId, x, y, input: 'interrupted', button: normalizeButton(button), pointer: safePointerProjection(pressed.pointer) };
      const released = await this.mouseUp(tabId, { x, y, button }, sessionId, operation);
      // Once mouse-down commits, mouse-up is always delivered as an edge event.
      // A newer visual target may change where the tip ends, but the real click is
      // complete and must never be reported as retryable interruption.
      const dispatchedAt = Date.now();
      const probed = await this.hitTest(tabId, { x, y });
      const enforced = await this.enforceClickDelivery(tabId, { x, y, button: normalizeButton(button), hit: probed, dispatchedAt });
      const hit = enforced.hit;
      return {
        tabId, x, y, input: 'mouse', button: normalizeButton(button),
        ...(repeatPoint ? { repeatPoint: true } : {}),
        pointer: committedClickPointer({ moved, pressed, released }),
        // WHY the cursor animation was unavailable (tab-not-visible /
        // pointer-unavailable / pointer-surface-unavailable / ack timeout):
        // without this the reply only said visualInterrupted:true and the
        // visualizer's own gate stayed invisible.
        ...(moved?.pointer?.reason ? { visualReason: String(moved.pointer.reason).slice(0, 80) } : {}),
        ...(enforced.delivered === null ? {} : { delivered: enforced.delivered, delivery: enforced.delivery }),
        ...inputGate,
        hit
      };
    } finally {
      if (ownsOperation) this.finishInputOperation(operation);
    }
  }

  // A tab whose CDP input is swallowed keeps the native channel: retrying the
  // dead channel on every click costs a full CDP dispatch plus a probe plus the
  // retry (~300ms) and makes real-time sequences impossible. The channel is
  // learned once per tab and reused.
  async clickViaNative(tabId, { x, y, button, sessionId = null, operation = null }) {
    const webContents = this.requireTab(tabId)?.webContents;
    if (!webContents || typeof webContents.sendInputEvent !== 'function' || webContents.isDestroyed?.()) return null;
    // Visualize the native click exactly like the CDP one (fast, non-blocking):
    // the cursor animation is the product's transparency guarantee.
    if (this.visualizerUsable(tabId)) {
      try {
        this.pointerVisualizer?.move?.(tabId, { x, y }, { waitForArrival: false, operationId: operation?.pointerAction });
        this.pointerVisualizer?.press?.(tabId, { x, y }, button, { operationId: operation?.pointerAction });
      } catch { /* the visual never blocks the input */ }
    }
    webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await new Promise((resolve) => setTimeout(resolve, 8));
    webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 8));
    webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    if (this.visualizerUsable(tabId)) {
      try {
        this.pointerVisualizer?.release?.(tabId, { x, y }, button, { operationId: operation?.pointerAction });
      } catch { /* the visual never blocks the input */ }
    }
    const dispatchedAt = Date.now();
    const probed = await this.hitTest(tabId, { x, y }).catch(() => null);
    const delivered = Array.isArray(probed?.pageClicks) && probed.pageClicks.some((entry) => Number(entry?.at) >= dispatchedAt - 80
      && Math.abs(Number(entry?.x) - x) <= 2 && Math.abs(Number(entry?.y) - y) <= 2);
    return { hit: probed, delivered, delivery: 'native' };
  }

  // VERIFIED CLICK DELIVERY: a dispatched click is not a delivered click. The
  // page probe (installed by the observation collector and the hit test)
  // records every mouse event the page receives. When the probe is armed and
  // the page shows NO click at the point, the click is re-sent through
  // Electron's NATIVE input injection — an independent pipeline from CDP —
  // and re-probed. The reply then names which channel landed, so a swallowed
  // click can never masquerade as a plain success (the click-order game: every
  // field reported hit:true while the page received nothing).
  async enforceClickDelivery(tabId, { x, y, button, hit, dispatchedAt }) {
    const clicks = Array.isArray(hit?.pageClicks) ? hit.pageClicks : null;
    if (!clicks) return { hit, delivered: null, delivery: 'cdp' };
    const armedBeforeClick = this.clickProbeArmed?.has(String(tabId)) === true;
    if (hit?.pageClicks !== undefined) this.clickProbeArmed?.add(String(tabId));
    const matched = clicks.some((entry) => Number(entry?.at) >= dispatchedAt - 60
      && Math.abs(Number(entry?.x) - x) <= 2 && Math.abs(Number(entry?.y) - y) <= 2);
    if (matched) return { hit, delivered: true, delivery: 'cdp' };
    if (!armedBeforeClick) {
      // First click on this tab: the probe only just installed, so an empty
      // list proves nothing. Never double-click on a guess.
      return { hit, delivered: null, delivery: 'cdp' };
    }
    const tab = this.requireTab(tabId);
    const webContents = tab?.webContents;
    if (!webContents || typeof webContents.sendInputEvent !== 'function' || webContents.isDestroyed?.()) {
      return { hit, delivered: false, delivery: 'cdp' };
    }
    try {
      webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await new Promise((resolve) => setTimeout(resolve, 24));
      webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 24));
      webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 90));
      const retried = await this.hitTest(tabId, { x, y }).catch(() => hit);
      const landed = Array.isArray(retried?.pageClicks) && retried.pageClicks.some((entry) => Number(entry?.at) >= dispatchedAt
        && Math.abs(Number(entry?.x) - x) <= 2 && Math.abs(Number(entry?.y) - y) <= 2);
      if (landed) this.deliveryChannel.set(String(tabId), 'native');
      return { hit: retried || hit, delivered: landed, delivery: 'electron-retry' };
    } catch {
      return { hit, delivered: false, delivery: 'cdp' };
    }
  }

  requireEmulator() {
    if (!this.deviceEmulator) throw new Error('Device emulation is unavailable in this build.');
    return this.deviceEmulator;
  }

  deviceState(tabId) {
    return this.requireEmulator().state(tabId);
  }

  setDeviceMode(tabId, { profileId, orientation, showTouches } = {}) {
    if (!profileId) throw new Error('profileId is required. Call browser_device_profiles to list the available ids.');
    // The emulated viewport changes the native surface (fitted device frame +
    // letterbox), so the host must re-run layout exactly like the renderer's
    // own set-device-mode IPC handler does. Without this, an AGENT-initiated
    // device switch leaves the native view at the previous size.
    return this.requireEmulator().setDeviceMode(tabId, { profileId, orientation, showTouches }).then((state) => {
      this.onDeviceModeChanged?.(tabId);
      return state;
    });
  }

  rotateDevice(tabId) {
    return this.requireEmulator().rotate(tabId).then((state) => {
      this.onDeviceModeChanged?.(tabId);
      return state;
    });
  }

  async gesture(tabId, { gesture, ...options } = {}) {
    if (typeof gesture !== 'string' || !gesture.trim()) throw new Error('gesture is required');
    const emulator = this.requireEmulator();
    // scroll is routed through the chunking path so a delta longer than the
    // screen still works, which a single raw gesture cannot express.
    if (gesture === 'scroll' && options.x === undefined && options.y === undefined) {
      const result = await emulator.scrollBy(tabId, options);
      return { ...result, gesture: 'scroll' };
    }
    return emulator.performGesture(tabId, gesture.trim(), options);
  }

  consoleEntries(tabId) {
    // Page console = THIS tab's entries only (run-forensics 2026-10-15,
    // corroborated by 2 audits): the old `|| !entry.tabId` fallback admitted
    // the harness's own tabId-less entries — agent/computer/download/history
    // kinds like [Timing]/[System One] telemetry — into the model's page
    // console view, burying real page errors in ~50% noise. Every page entry
    // (console-message, did-fail-load, webRequest) carries its tabId.
    return this.getConsoleEntries().filter((entry) => entry.tabId === tabId);
  }

  networkEntries(tabId) {
    return this.getConsoleEntries().filter((entry) => entry.kind === 'network' && entry.tabId === tabId);
  }

  navigationState(tabId) {
    const tab = this.requireTab(tabId);
    return {
      tabId,
      url: tab.webContents.getURL() || 'about:blank',
      loading: tab.webContents.isLoading(),
      canGoBack: tab.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.webContents.navigationHistory.canGoForward()
    };
  }

  async navigate(tabId, value) {
    const tab = this.requireTab(tabId);
    const url = this.normalizeUrl(value);
    // A prior search/consent page can keep loading subresources after its main
    // document is actionable. Starting another explicit route while Chromium
    // still owns that load occasionally suppresses the next main-frame event.
    // Stop only an in-flight *different* page; never interrupt an equivalent
    // requested route or a settled human page.
    try {
      const currentUrl = tab.webContents.getURL();
      if (tab.webContents.isLoading?.() && !matchesRequestedNavigation(currentUrl, url)) tab.webContents.stop?.();
    } catch {}
    const supportsNavigationEvents = typeof tab.webContents?.on === 'function' && typeof tab.webContents?.removeListener === 'function';
    const committed = supportsNavigationEvents
      ? waitForMainFrameCommit(tab.webContents, url, NAVIGATION_COMMIT_TIMEOUT_MS)
      : null;
    const loaded = Promise.resolve().then(() => tab.webContents.loadURL(url));
    if (!supportsNavigationEvents) {
      // Lightweight controller doubles do not emit Electron lifecycle events;
      // their load promise remains the only meaningful completion signal.
      await loaded;
      return this.navigationState(tabId);
    }
    // A real WebContents can resolve loadURL once the request has been handed
    // off, while getURL() still points at the old page. Do not let that early
    // fulfillment report a stale route as a successful browser_navigate. Only
    // a matching main-frame commit establishes actionable page evidence. A
    // genuine load failure still rejects promptly; -3 is a superseded request
    // and the commit observer remains authoritative for the target.
    const loadFailure = loaded.then(
      () => new Promise(() => {}),
      (error) => {
        if (Number(error?.errno) === -3) return new Promise(() => {});
        throw error;
      }
    );
    let commit;
    try {
      commit = await Promise.race([committed, loadFailure]);
    } catch (error) {
      // A BrowserView can occasionally update getURL without delivering the
      // paired navigation lifecycle event. The exact requested URL is still
      // real main-frame evidence, so do not manufacture a timeout failure.
      const settledState = this.navigationState(tabId);
      if (error?.code !== 'NAVIGATION_HTTP_STATUS' && matchesRequestedCompletion(settledState.url, url)) return settledState;
      throw error;
    }
    const state = this.navigationState(tabId);
    // Preserve the committed URL even if WebContents updates its synchronous
    // getter one microtask after did-navigate. This also reports legitimate
    // same-site redirects truthfully instead of treating them as a stale page.
    return matchesRequestedCompletion(state.url, url) || !commit?.url
      ? state
      : { ...state, url: String(commit.url), redirected: true };
  }

  goBack(tabId) {
    const tab = this.requireTab(tabId);
    if (tab.webContents.navigationHistory.canGoBack()) tab.webContents.navigationHistory.goBack();
    return this.navigationState(tabId);
  }

  mouseMove(tabId, { x, y }, { waitForPointer = true, pointerDurationMs, operation = null, sessionId, buttons } = {}) {
    assertCoordinates(x, y);
    this.assertPointerAllowed(tabId, 'browser_mousemove');
    const ownsOperation = !operation;
    const activeOperation = operation || this.inputOperationToken(sessionId, tabId);
    // CDP requires the mask of currently-held buttons on EVERY event; the old
    // sendInputEvent route inferred it. Without it, a move during a press
    // claims no button is held and the page never enters drag mode - drags
    // simply did nothing (the live drag failure).
    // A pinned operation is an in-flight drag: the left button is held for the
    // whole drag even if the held-button tracking was cleared mid-flight, so
    // every move must carry buttons=1 or the page never enters drag mode.
    // An explicit mask wins. The drag's own approach move happens BEFORE its
    // press, so it must report buttons=0 even though the operation is pinned;
    // the pinned override below exists only for the moves after the press.
    const heldMask = Number.isFinite(buttons)
      ? buttons
      : (this.heldButtonMask(sessionId, tabId) | (operation?.pinned ? 1 : 0));
    const moveEvent = { type: 'mouseMoved', x, y, buttons: heldMask };
    return this.runInputOperation(activeOperation, ownsOperation, () => {
      if (!this.inputOperationCurrent(activeOperation)) {
        return { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
      }
      const prepared = this.prepareNativeInput(tabId);
      const visualRequired = this.visualizerUsable(tabId);
      const visual = visualRequired ? this.pointerVisualizer?.move?.(tabId, { x, y }, {
        waitForArrival: waitForPointer,
        operationId: activeOperation.pointerAction,
        ...(Number.isFinite(pointerDurationMs) ? { durationMs: pointerDurationMs } : {})
      }) : null;
      return afterMaybePromise(visual, (visualResult) => {
        // A newer movement owns both the visual pointer and the final native
        // mouseMoved event. An interrupted older target must never reappear later.
        if (!this.inputOperationCurrent(activeOperation)) return { tabId, input: 'interrupted', pointer: visualResult };
        if (pointerCannotProceed(visualResult, {
          required: visualRequired,
          waitForArrival: waitForPointer
        })) {
          this.noteVisualizerStrike(tabId);
          // The cursor visual is decoration: deliver the hover position even
          // when its acknowledgement is lost.
          this.lastPointer.set(tabId, { x, y });
          const outcome = this.dispatchInput(tabId, prepared.tab.webContents, moveEvent, 'mouse', prepared.forceBackground);
          return addPointerOutcome(outcome, { ...safePointerProjection(visualResult), deliveryFallback: true });
        }
        this.lastPointer.set(tabId, { x, y });
        const outcome = this.dispatchInput(tabId, prepared.tab.webContents, moveEvent, 'mouse', prepared.forceBackground);
        return addPointerOutcome(outcome, visualResult);
      });
    });
  }

  mouseDown(tabId, { x, y, button = 'left' }, sessionId, inputOperation = null) {
    assertCoordinates(x, y);
    this.assertPointerAllowed(tabId, 'browser_mousedown');
    const normalizedButton = normalizeButton(button);
    const owner = inputOwner(sessionId);
    const ownsOperation = !inputOperation;
    const operation = inputOperation || this.inputOperationToken(sessionId, tabId);
    const continueAfterRelease = (release) => this.runInputOperation(operation, ownsOperation, () => (
      // A prior release that failed (slow or starved debugger queue) must NEVER
      // cancel the next press. With CDP the per-tab lease already guarantees
      // the release command reaches the page BEFORE this press command, so the
      // ordering this wait protected is safe even when the release's own
      // completion is unknown. Aborting here is what made "only the first
      // click register" across a click sequence (the live chess run: click 1
      // landed, every later click died on the prior release's rejection).
      Promise.resolve(release).catch(() => undefined).then(() => {
        if (!this.inputOperationCurrent(operation)) {
          return { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
        }
        return this.mouseDown(tabId, { x, y, button: normalizedButton }, sessionId, operation);
      })
    ));
    const pendingRelease = this.pendingButtonReleases.get(releasedButtonKey(owner, tabId, normalizedButton));
    if (pendingRelease) {
      // CDP releases are ordered through an asynchronous debugger queue. Never
      // let a new same-button press overtake the old release: its eventual
      // completion would otherwise clear the new hold and leave the page
      // pressed after session cleanup. Reuse the caller's operation token so a
      // cancellation during this wait still suppresses the delayed press.
      return continueAfterRelease(pendingRelease.promise);
    }
    const priorCleanup = this.consumeReleasedButtonTombstone(owner, tabId, normalizedButton);
    if (priorCleanup && typeof priorCleanup.then === 'function') {
      return continueAfterRelease(priorCleanup);
    }
    const prepared = this.prepareNativeInput(tabId);
    return this.runInputOperation(operation, ownsOperation, () => {
      if (!this.inputOperationCurrent(operation)) return { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
      const visualRequired = this.visualizerUsable(tabId);
      const visual = visualRequired ? this.pointerVisualizer?.move?.(tabId, { x, y }, { waitForArrival: true, operationId: operation.pointerAction }) : null;
      return afterMaybePromise(visual, (visualResult) => {
        if (!this.inputOperationCurrent(operation)) {
          return { tabId, input: 'interrupted', pointer: visualResult };
        }
        if (pointerCannotProceed(visualResult, { required: visualRequired, waitForArrival: true })) {
          this.noteVisualizerStrike(tabId);
          // The visual pointer is DECORATION. A cancelled, timed-out or
          // unacknowledged cursor move must never eat the press: deliver it
          // through the direct CDP route and report the fallback, so a canvas
          // sequence (select piece, then destination) is never reduced to a
          // stray mouseup.
          this.lastPointer.set(tabId, { x, y });
          this.clearReleasedButtonTombstone(owner, tabId, normalizedButton);
          this.trackHeld(sessionId, tabId, 'buttons', normalizedButton, { route: 'cdp' });
          const outcome = this.dispatchInput(tabId, prepared.tab.webContents, { type: 'mousePressed', x, y, button: normalizedButton, buttons: mouseButtonMask(normalizedButton), clickCount: 1 }, 'mouse', prepared.forceBackground);
          return addPointerOutcome(outcome, { ...safePointerProjection(visualResult), deliveryFallback: true });
        }
        this.lastPointer.set(tabId, { x, y });
        const pressVisual = this.pointerVisualizer?.press?.(tabId, { x, y }, normalizedButton, { operationId: operation.pointerAction });
        return afterMaybePromise(pressVisual, (pressResult) => {
          if (!this.inputOperationCurrent(operation)) {
            if (pressResult?.sequence) this.pointerVisualizer?.cancelPress?.(tabId, pressResult.sequence);
            return { tabId, input: 'interrupted', pointer: pressResult || visualResult };
          }
          if (pointerCannotProceed(pressResult, { required: visualRequired, waitForArrival: true })) {
            // Same contract: the press must land even when its visual
            // acknowledgement is lost. The release pairing below dispatches
            // through the same direct route, so the page still sees a click.
            if (pressResult?.sequence) this.pointerVisualizer?.cancelPress?.(tabId, pressResult.sequence);
            this.clearReleasedButtonTombstone(owner, tabId, normalizedButton);
            this.trackHeld(sessionId, tabId, 'buttons', normalizedButton, { route: 'cdp' });
            const outcome = this.dispatchInput(tabId, prepared.tab.webContents, { type: 'mousePressed', x, y, button: normalizedButton, buttons: mouseButtonMask(normalizedButton), clickCount: 1 }, 'mouse', prepared.forceBackground);
            return addPointerOutcome(outcome, { ...safePointerProjection(pressResult || visualResult), deliveryFallback: true });
          }
          this.clearReleasedButtonTombstone(owner, tabId, normalizedButton);
          this.trackHeld(sessionId, tabId, 'buttons', normalizedButton, { route: 'cdp' });
          const outcome = this.dispatchInput(tabId, prepared.tab.webContents, { type: 'mousePressed', x, y, button: normalizedButton, buttons: mouseButtonMask(normalizedButton), clickCount: 1 }, 'mouse', prepared.forceBackground);
          return addPointerOutcome(outcome, visualResult);
        });
      });
    });
  }

  mouseUp(tabId, { x, y, button = 'left' }, sessionId, inputOperation = null) {
    assertCoordinates(x, y);
    this.assertPointerAllowed(tabId, 'browser_mouseup');
    const normalizedButton = normalizeButton(button);
    const owner = inputOwner(sessionId);
    const trackedBeforeOperation = this.isHeld(sessionId, tabId, 'buttons', normalizedButton);
    const priorCleanup = trackedBeforeOperation ? null : this.consumeReleasedButtonTombstone(owner, tabId, normalizedButton);
    if (priorCleanup) {
      return afterMaybePromise(priorCleanup, (released) => released
        ? { tabId, input: 'electron-native', releasedByCleanup: true, pointer: { interrupted: true, reason: 'button-already-released-by-cleanup' } }
        : this.mouseUp(tabId, { x, y, button: normalizedButton }, sessionId, inputOperation));
    }
    const prepared = this.prepareNativeInput(tabId);
    const ownsOperation = !inputOperation;
    const operation = inputOperation || this.inputOperationToken(sessionId, tabId);
    const trackedAtStart = trackedBeforeOperation;
    const visualRequired = Boolean(this.pointerVisualizer) && this.getSelectedTabId() === tabId && this.isTabPaintable?.(tabId) !== false;
    return this.runInputOperation(operation, ownsOperation, () => {
      const operationStale = !this.inputOperationCurrent(operation);
      const visual = operationStale
        ? { interrupted: true, reason: 'input-operation-cancelled' }
        : (this.visualizerUsable(tabId) ? this.pointerVisualizer?.move?.(tabId, { x, y }, { waitForArrival: true, operationId: operation.pointerAction }) : null);
      return afterMaybePromise(visual, (visualResult) => {
        const deliverRelease = () => {
          // Releases are edge events and must never be dropped. If their requested
          // movement was superseded, release at the newest committed native point
          // instead of moving back to the stale coordinate.
          // A pinned drag owns its release point: the drop must land exactly at
          // the requested (x, y), never at a stale lastPointer fallback.
          const releasePoint = (operation?.pinned || !pointerCannotProceed(visualResult, {
            required: visualRequired,
            waitForArrival: true
          })) ? { x, y } : (this.lastPointer.get(tabId) || { x, y });
          this.lastPointer.set(tabId, releasePoint);
          // Native release is the safety edge. Only forget the held state after
          // dispatch succeeds; click feedback is best-effort and cannot block it.
          // A release that the debugger queue drops is retried ONCE: a lost
          // mouseup leaves the page's button stuck down, and the next click
          // then lands as a drag or is swallowed entirely.
          const releaseEvent = { type: 'mouseReleased', ...releasePoint, button: normalizedButton, buttons: 0, clickCount: 1 };
          const dispatched = Promise.resolve(this.dispatchInput(tabId, prepared.tab.webContents, releaseEvent, 'mouse', prepared.forceBackground))
            .catch((error) => {
              // A cancelled operation must not re-dispatch; anything else gets
              // ONE retry: a dropped release leaves the page's button stuck
              // down, and the next click then lands as a drag or is swallowed.
              if (!this.inputOperationCurrent(operation)) throw error;
              return this.dispatchInput(tabId, prepared.tab.webContents, releaseEvent, 'mouse', prepared.forceBackground);
            });
          const outcome = this.trackPendingButtonRelease(owner, tabId, normalizedButton, dispatched);
          return afterMaybePromise(outcome, (settledOutcome) => {
            this.forgetHeld(sessionId, tabId, 'buttons', normalizedButton);
            ignoreVisualFailure(() => this.pointerVisualizer?.release?.(tabId, releasePoint, normalizedButton, { operationId: operation.pointerAction }));
            return addPointerOutcome(settledOutcome, visualResult);
          });
        };
        // Session cleanup owns the release if it removed a button that was held
        // when this call began. A late visual ACK must not emit a second mouseUp.
        // Direct recovery mouseUp calls that were never tracked remain valid.
        if (trackedAtStart && !this.isHeld(sessionId, tabId, 'buttons', normalizedButton)) {
          const cleanup = this.consumeReleasedButtonTombstone(owner, tabId, normalizedButton);
          if (cleanup) {
            return afterMaybePromise(cleanup, (released) => released
              ? { tabId, input: 'electron-native', releasedByCleanup: true, pointer: visualResult }
              : deliverRelease());
          }
        }
        return deliverRelease();
      });
    });
  }

  // Does the page believe Chromium will deliver pointer input to it?
  // `document.visibilityState` is the renderer's own answer, costs one
  // Runtime.evaluate (~13ms measured), and needs no frames — so it is readable
  // in exactly the state where painting has already stopped.
  async rendererVisible(tabId) {
    let tab;
    try { tab = this.requireTab(tabId); } catch { return null; }
    try {
      const value = await this.evaluatePage(tab, 'renderer visibility', '(() => document.visibilityState)()', 1_500,
        'Timed out reading the page visibility state.');
      if (value === 'visible') return true;
      if (value === 'hidden') return false;
      return null;
    } catch {
      // An unreadable page must not block input: proceed and let the real
      // dispatch report its own failure.
      return null;
    }
  }

  async awaitRendererVisible(tabId, budgetMs) {
    const deadline = Date.now() + Math.max(0, Number(budgetMs) || 0);
    for (;;) {
      const visible = await this.rendererVisible(tabId);
      if (visible !== false) return visible;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, INPUT_VISIBILITY_POLL_MS));
    }
  }

  // Every pointer path funnels through here before dispatching. Returns the
  // extra result fields the caller must surface, or throws with the real reason.
  // A hidden renderer is NOT a retryable condition the caller can wait out: it
  // needs a window change, so the message has to name that.
  // Synchronous fast path. Without the shell hook there is nothing to check, and
  // callers must keep their original synchronous dispatch: making an unchanged
  // mouse move asynchronous would reorder it behind the caller's next statement.
  mouseInputGate(tabId) {
    if (!this.raiseForInput) return null;
    return this.ensureMouseInputLands(tabId);
  }

  async ensureMouseInputLands(tabId) {
    // Only the shell can change what a hidden renderer sees (raise the window,
    // select the tab). Without that hook there is nothing to try and no way to
    // verify the cure, so the check would only add a page round trip to every
    // pointer event. Unit harnesses construct the controller without it.
    if (!this.raiseForInput) return {};
    const cached = this.inputVisibility.get(tabId);
    if (cached && Date.now() - cached.at < INPUT_VISIBILITY_TTL_MS) {
      if (cached.error) throw new Error(cached.error);
      return cached.raised ? { raisedWindow: true } : {};
    }
    const selected = this.getSelectedTabId() === tabId;
    let visible = await this.rendererVisible(tabId);
    let raised = false;
    if (visible === false && selected && this.raiseForInput) {
      try { raised = this.raiseForInput(tabId) !== false; } catch { raised = false; }
      if (raised) visible = await this.awaitRendererVisible(tabId, INPUT_RAISE_SETTLE_MS);
    }
    if (visible === false) {
      const message = selected
        ? 'The bound tab\'s renderer is hidden (document.visibilityState=hidden), and Chromium discards mouse and wheel input for a hidden view — the event would land nowhere. This happens when the Browser-use window is minimised or fully covered by another window. Bring the Browser-use window to the front, then retry; DOM reads and browser_execute still work in this state.'
        : 'The bound tab is not the selected tab, so its renderer is hidden and Chromium discards mouse and wheel input for it. Bind a tab that is on screen (browser_bind_tab selects it) before using pointer tools.';
      this.inputVisibility.set(tabId, { at: Date.now(), error: message });
      throw new Error(message);
    }
    const verdict = { at: Date.now(), visible: visible !== false, raised };
    this.inputVisibility.set(tabId, verdict);
    return raised ? { raisedWindow: true } : {};
  }

  prepareNativeInput(tabId) {
    const tab = this.requireTab(tabId);
    const selected = this.getSelectedTabId() === tabId;
    if (this.isTabPaintable && !this.isTabPaintable(tabId) && selected) {
      // ensureTabPaintable re-lays-out the BrowserView, and the pointer
      // overlay reports that as a surface change that cancels pending
      // operations. That cancellation is for FOREIGN layout changes: our own
      // preparation must not kill the operation we are about to dispatch, or
      // the press is dropped and the page only ever sees a stray release.
      const previous = this.suppressPointerInvalidation;
      this.suppressPointerInvalidation = true;
      try { this.ensureTabPaintable?.(tabId); } finally { this.suppressPointerInvalidation = previous; }
    }
    // A selected WebContents can remain live while Windows temporarily gives
    // its BrowserView no compositor surface. Delivering through the same
    // tab-scoped debugger channel preserves the exact target and action instead
    // of converting a window-layout condition into a provider replan.
    const forceBackground = Boolean(selected && this.isTabPaintable && !this.isTabPaintable(tabId));
    return { tab, forceBackground };
  }

  async settleAfterInput(tab, selector, autocomplete = false) {
    try {
      await this.evaluatePage(tab, 'settle form input', buildPostInputSettleScript(selector, autocomplete), autocomplete ? 250 : 80,
        'Timed out settling the selected form control.');
    } catch {
      // Input already crossed the native boundary; a transient navigation or a
      // slow render must not replay the mutation. Verification owns the result.
    }
  }

  dispatchInput(tabId, webContents, event, kind, forceBackground = false) {
    // ALL mouse delivery rides the CDP Input pipeline, foreground included.
    // CDP coordinates are PAGE CSS pixels — the same space the DOM rects,
    // the screenshot mapping and the post-input hit test speak — so page
    // zoom, view offsets and display scaling can never desync where the
    // model aims from where the event lands. sendInputEvent's coordinate
    // handling had exactly that failure class: the live chess run committed
    // six foreground clicks on a visible button with zero page effect, then
    // a JavaScript element.click() worked instantly. The wheel path already
    // rides CDP for the same reason. The per-tab lease also SERIALIZES the
    // release ahead of the post-input hit test, so the hit test now reads
    // deterministic post-release state instead of racing injected events.
    // A failed delivery (for example DevTools holding the debugger) fails
    // loudly with its real error instead of landing silently nowhere.
    if (kind === 'mouse') {
      // A move is the one mouse event whose acknowledgement Chromium can delay
      // for seconds. Press and release are edge events and their reply is cheap,
      // so they keep the plain awaited path.
      const deliver = () => (event.type === 'mouseMoved'
        ? this.dispatchMouseBounded(tabId, 'native mouse input', event, MOUSE_MOVE_ACK_BUDGET_MS)
          .then((meta) => ({
            tabId,
            input: 'cdp',
            // Keep the success shape stable: only an unacknowledged move says so.
            ...(meta.acknowledged === false
              ? {
                  acknowledged: false,
                  ...(meta.ackDeferred ? { ackDeferred: true } : {}),
                  ...(meta.ackError ? { ackError: meta.ackError } : {})
                }
              : {})
          }))
        : this.dispatchCdp(tabId, 'native mouse input', 'Input.dispatchMouseEvent', event)
          .then(() => ({ tabId, input: 'cdp' })));
      const gate = this.mouseInputGate(tabId);
      if (!gate) return deliver();
      return gate.then((extra) => Promise.resolve(deliver()).then((result) => ({ ...result, ...extra })));
    }
    if (this.getSelectedTabId() === tabId && !forceBackground) {
      if (kind === 'text') {
        webContents.insertText(event.text);
        return { tabId, input: 'electron-native' };
      }
      const nativeEvent = kind === 'key' ? cdpKeyToElectronEvent(event) : null;
      if (nativeEvent) {
        webContents.sendInputEvent(nativeEvent);
        return { tabId, input: 'electron-native' };
      }
    }
    // CDP dispatch addresses this particular WebContents even while another
    // BrowserView remains focused. This keeps explicit background-tab control
    // from stealing focus or failing because the target is not selected.
    const dispatch = kind === 'key' ? this.dispatchCdp(tabId, 'background key input', 'Input.dispatchKeyEvent', event)
      : this.dispatchCdp(tabId, 'background text input', 'Input.insertText', { text: event.text });
    return dispatch.then(() => ({ tabId, input: 'cdp-background' }));
  }

  dispatchCdp(tabId, purpose, method, params, options = {}) {
    if (this.debuggerLeaseManager) return this.debuggerLeaseManager.send(tabId, purpose, method, params, options);
    const webContents = this.requireTab(tabId).webContents;
    return withDebugger(webContents, purpose, (debuggerClient) => debuggerClient.sendCommand(method, params));
  }

  // Dispatch one mouse event without letting a late acknowledgement become
  // dead time. Ordering is preserved by the CDP session itself, so the event is
  // still delivered before anything sent after it.
  dispatchMouseBounded(tabId, purpose, event, budgetMs) {
    const issued = Promise.resolve(this.dispatchCdp(tabId, purpose, 'Input.dispatchMouseEvent', event, { queueBudgetMs: budgetMs }))
      .then(() => ({ acknowledged: true }))
      .catch((error) => ({ acknowledged: false, ackError: String(error?.message || error).slice(0, 160) }));
    return withBudget(issued, budgetMs, { acknowledged: false, ackDeferred: true });
  }

  // Run-scoped debugger pinning: without a pin, EVERY CDP command pays an
  // attach -> command -> detach cycle (the lease's finally detaches any
  // un-pinned tab), ~100ms+ per command and four cycles per click — plus
  // attach/detach races between queued operations. The agent pins its bound
  // tab for the run's duration; input, hit tests and snapshots then ride one
  // stable attach.
  pinDebugger(tabId, owner) {
    if (!this.debuggerLeaseManager) return false;
    try { this.requireTab(tabId); } catch { return false; }
    this.debuggerLeaseManager.pin(String(tabId), String(owner || 'agent'));
    return true;
  }

  unpinDebugger(tabId, owner) {
    if (!this.debuggerLeaseManager) return false;
    this.debuggerLeaseManager.unpin(String(tabId), String(owner || 'agent'));
    return true;
  }

  async currentViewport(tabId, tab = this.requireTab(tabId)) {
    const known = this.lastViewport.get(tabId);
    if (known && known.width > 0 && known.height > 0) return known;
    const payload = await this.readElements(tab, { maxElements: 1, interactiveOnly: false, includeText: false });
    return payload.viewport;
  }

  wheelOrigin(tabId, viewport, { x, y } = {}) {
    const candidate = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : this.lastPointer.get(tabId);
    if (candidate && candidate.x >= 0 && candidate.y >= 0 && candidate.x < viewport.width && candidate.y < viewport.height) return candidate;
    return { x: Math.max(0, Math.floor(viewport.width / 2)), y: Math.max(0, Math.floor(viewport.height / 2)) };
  }

  async scrollEvidence(tab) {
    const payload = await this.readElements(tab, { maxElements: 1, interactiveOnly: false, includeText: false });
    return payload.viewport;
  }

  // Cheap scroll-position read used for polling. scrollEvidence() builds a DOM
  // snapshot, which is far too heavy to call repeatedly while waiting for a
  // wheel to land.
  async scrollPosition(tab) {
    try {
      const view = await this.evaluatePage(
        tab,
        'scroll position',
        '(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }))()',
        2_000,
        'Timed out reading the scroll position.'
      );
      if (view && Number.isFinite(Number(view.scrollY))) {
        return { scrollX: Number(view.scrollX) || 0, scrollY: Number(view.scrollY) || 0 };
      }
    } catch { /* fall through to the DOM read */ }
    return null;
  }

  // Watch the DOCUMENT for the effect of a wheel instead of trusting its
  // acknowledgement. A painted page moves within a frame or two, so this settles
  // in well under 100ms; an unpainted one never moves, and the caller gets the
  // honest answer instead of a six-second wait followed by a claim of success.
  async settleScroll(tab, before) {
    // One bounded viewport read is the contract for a normal scroll; the extra
    // polling below only runs when that read shows the wheel changed nothing.
    let after = await this.scrollEvidence(tab);
    if (!before || !after) return after;
    for (let attempt = 0; attempt < SCROLL_SETTLE_POLLS; attempt += 1) {
      if (before.scrollX !== after.scrollX || before.scrollY !== after.scrollY) break;
      await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_INTERVAL_MS));
      const next = await this.scrollPosition(tab);
      if (next) after = next;
    }
    return after;
  }

  async drag(tabId, { startX, startY, endX, endY, fromElement, toElement, steps = 10, durationMs = 300 } = {}, sessionId) {
    // ELEMENT-FIRST DRAG: the element form is the PREFERRED contract, so it
    // has to work for EVERY caller - the MCP bridge included. It resolves both
    // DOM indices to the exact centers the browser laid out, so the drag
    // carries no pixel arithmetic and no offset. The agent path resolves the
    // same indices from the observation the model actually saw; here the page
    // is re-read, so a stale index is reported instead of silently dragging
    // somewhere else.
    const fromIndex = coerceDragIndex(fromElement);
    const toIndex = coerceDragIndex(toElement);
    const elementForm = fromIndex !== undefined || toIndex !== undefined;
    if (elementForm && (fromIndex === undefined || toIndex === undefined)) {
      throw new Error('browser_drag needs BOTH fromElement and toElement, or a complete (startX, startY) to (endX, endY) coordinate pair.');
    }
    if (!elementForm) {
      assertCoordinates(startX, startY);
      assertCoordinates(endX, endY);
    }
    this.assertPointerAllowed(tabId, 'browser_drag');
    if (elementForm) {
      const [from, to] = await Promise.all([
        this.elementRect(tabId, { index: fromIndex }),
        this.elementRect(tabId, { index: toIndex })
      ]);
      if (!from?.center || !to?.center) {
        throw new Error('The drag source or destination has no resolvable center; observe the page again before dragging.');
      }
      startX = Math.round(from.center.x);
      startY = Math.round(from.center.y);
      endX = Math.round(to.center.x);
      endY = Math.round(to.center.y);
      assertCoordinates(startX, startY);
      assertCoordinates(endX, endY);
    }

    // Keep the drag bounded so it cannot outlive the MCP request deadline or hold
    // the process open indefinitely.
    const MAX_DRAG_DURATION_MS = 5_000;
    const clampedDurationMs = Math.max(5, Math.min(durationMs, MAX_DRAG_DURATION_MS));
    const requestedStepCount = Math.max(1, Math.min(steps, 100));
    const continuousStepCount = Math.ceil(clampedDurationMs / POINTER_DRAG_SEGMENT_MAX_MS);
    const stepCount = Math.min(100, Math.max(requestedStepCount, continuousStepCount));
    const delay = Math.max(5, Math.floor(clampedDurationMs / stepCount));

    const operation = this.inputOperationToken(sessionId, tabId);
    // A drag owns the pointer for its whole duration: pin the operation so a
    // mid-drag pointer-surface invalidation or a stray supersession cannot
    // cancel it and leave the drop without its intermediate moves.
    operation.pinned = true;
    try {
      // No button is held at the approach point. Pass the REAL held mask so a
      // caller that already holds a button keeps it, while a normal drag's
      // pre-press move honestly reports buttons=0 instead of entering drag mode
      // before the press has been dispatched.
      const initialMove = await this.mouseMove(tabId, { x: startX, y: startY }, { operation, sessionId, buttons: this.heldButtonMask(sessionId, tabId) });
      // The drag owns the pointer: abort only on an explicit cancellation
      // (active === false). Generation drift from the drag's own sub-calls
      // must not self-cancel the drag.
      if (operation.active === false) return { tabId, startX, startY, endX, endY, input: 'interrupted', pointer: initialMove?.pointer || { interrupted: true, reason: 'input-operation-cancelled' } };
      const down = await this.mouseDown(tabId, { x: startX, y: startY, button: 'left' }, sessionId, operation);
      if (operation.active === false) return { tabId, startX, startY, endX, endY, input: 'interrupted', pointer: down?.pointer || { interrupted: true, reason: 'input-operation-cancelled' } };
      let pressed = true;
      let interrupted = null;

      try {
        for (let i = 1; i <= stepCount; i++) {
          // The drag owns the pointer for its whole duration. Abort only on an
          // explicit cancellation (active === false); generation-counter drift
          // from the drag's own sub-calls must not self-cancel the drag.
          if (operation.active === false) {
            interrupted = { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
            break;
          }
          const stepStartedAt = Date.now();
          const cx = Math.round(startX + (endX - startX) * (i / stepCount));
          const cy = Math.round(startY + (endY - startY) * (i / stepCount));
          // Each native drag point is released only after the app pointer paints
          // that exact point. The per-step duration preserves the requested total
          // drag time without letting page hit-testing run ahead of the pointer.
          const movement = await this.mouseMove(tabId, { x: cx, y: cy }, {
            waitForPointer: true,
            pointerDurationMs: Math.max(16, delay),
            operation,
            sessionId
          });
          if (operation.active === false) {
            interrupted = { tabId, input: 'interrupted', pointer: movement?.pointer || { interrupted: true, reason: 'input-operation-cancelled' } };
            break;
          }
          // Wait out the rest of this segment while staying wakeable: a plain
          // sleep would keep dragging for up to a full segment after the
          // session was cancelled or a newer pointer action took the pointer,
          // and the next step would then paint a stale target.
          const remainingDelay = delay - (Date.now() - stepStartedAt);
          if (remainingDelay > 0 && !(await this.waitForInputOperationDelay(remainingDelay, operation))) {
            interrupted = { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
            break;
          }
        }
      } finally {
        if (pressed) {
          pressed = false;
          // A drag's release is an edge event and must never be dropped. Dispatch
          // it directly at the requested drop point: routing through mouseUp lets
          // a superseded visual move fall back to the stale grab coordinate, and
          // the page then registers the drop at the token's start position.
          // Cancellation is the one exception: session cleanup has already
          // released the button, and a second mouseup is a duplicate edge the
          // page can read as a separate release.
          if (this.isHeld(sessionId, tabId, 'buttons', 'left')) {
            const prepared = this.prepareNativeInput(tabId);
            const releaseEvent = { type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1 };
            await Promise.resolve(this.dispatchInput(tabId, prepared.tab.webContents, releaseEvent, 'mouse', prepared.forceBackground)).catch(() => {});
            this.lastPointer.set(tabId, { x: endX, y: endY });
          }
          this.forgetHeld(sessionId, tabId, 'buttons', 'left');
        }
      }

      return interrupted
        ? { tabId, startX, startY, endX, endY, input: 'interrupted', pointer: interrupted.pointer }
        : { tabId, startX, startY, endX, endY, input: 'mouse' };
    } finally {
      this.finishInputOperation(operation);
    }
  }

  // Scrolling is a real touch action, so under a device profile this becomes a
  // finger drag with momentum rather than a refusal — a wheel event would be
  // the one input a touchscreen genuinely cannot produce.
  async scroll(tabId, { deltaX = 0, deltaY = 0, x, y } = {}, sessionId) {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error('Scroll deltas must be finite numbers');
    if ((x !== undefined && !Number.isFinite(x)) || (y !== undefined && !Number.isFinite(y))) throw new Error('Scroll coordinates must be finite numbers');
    if (this.deviceEmulator?.isTouchMode(tabId)) {
      const result = await this.deviceEmulator.scrollBy(tabId, { deltaX, deltaY });
      return { tabId, deltaX, deltaY, input: 'touch', gesture: 'swipe', swipes: result.swipes };
    }
    const operation = this.inputOperationToken(sessionId, tabId);
    try {
      const prepared = this.prepareNativeInput(tabId);
      const tab = prepared.tab;
      // A wheel is discarded outright by a hidden renderer, so prove the view can
      // receive it BEFORE paying for evidence reads. This is what turns a 1.7s
      // "the wheel was never acknowledged" into a ~15ms answer that names the
      // real cause (an occluded or minimised window).
      const pendingGate = this.mouseInputGate(tabId);
      const inputGate = pendingGate ? await pendingGate : {};
      const before = await this.scrollEvidence(tab);
      if (!this.inputOperationCurrent(operation)) return { tabId, deltaX, deltaY, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
      const origin = this.wheelOrigin(tabId, before, { x, y });
      const visualRequired = Boolean(this.pointerVisualizer) && this.getSelectedTabId() === tabId && this.isTabPaintable?.(tabId) !== false;
      // Only pay for the cursor animation when the cursor is actually required.
      // This used to await the visualizer unconditionally and then ignore its
      // verdict when visualRequired was false — paying a full pointer timeout on
      // exactly the tabs where the visual was known to be unusable, which is
      // what pushed a background scroll past its ceiling.
      const pointer = visualRequired
        ? await this.pointerVisualizer?.move?.(tabId, origin, { waitForArrival: true, operationId: operation.pointerAction })
        : null;
      if (!this.inputOperationCurrent(operation)) return { tabId, deltaX, deltaY, input: 'interrupted', origin, pointer };
      if (pointerCannotProceed(pointer, {
        required: visualRequired,
        waitForArrival: true
      })) {
        // The wheel must scroll even when the cursor visual cannot proceed.
        const fallbackWheel = await this.dispatchMouseBounded(tabId, 'background wheel input', { type: 'mouseWheel', ...origin, deltaX, deltaY }, MOUSE_WHEEL_ACK_BUDGET_MS);
        // This branch used to return without any before/after evidence, so a wheel
        // that reached nothing still looked like a completed scroll.
        const fallbackAfter = await this.settleScroll(tab, before);
        assertScrollDelivered({ before, after: fallbackAfter, wheel: fallbackWheel, deltaX, deltaY });
        return {
          tabId,
          deltaX,
          deltaY,
          input: 'mouse',
          origin,
          before: { scrollX: before.scrollX, scrollY: before.scrollY },
          after: { scrollX: fallbackAfter.scrollX, scrollY: fallbackAfter.scrollY },
          moved: before.scrollX !== fallbackAfter.scrollX || before.scrollY !== fallbackAfter.scrollY,
          wheel: fallbackWheel,
          ...inputGate,
          pointer: { ...safePointerProjection(pointer), deliveryFallback: true }
        };
      }
      this.lastPointer.set(tabId, origin);
      this.pointerVisualizer?.activity?.(tabId, origin, { operationId: operation.pointerAction });
      const wheel = await this.dispatchMouseBounded(tabId, 'background wheel input', { type: 'mouseWheel', ...origin, deltaX, deltaY }, MOUSE_WHEEL_ACK_BUDGET_MS);
      // The wheel reply is not the proof; the document's own position is. Poll it
      // instead of paying a multi-second acknowledgement wait.
      const after = await this.settleScroll(tab, before);
      // Never report a completed scroll for a wheel nobody acknowledged.
      assertScrollDelivered({ before, after, wheel, deltaX, deltaY });
      return {
        tabId,
        deltaX,
        deltaY,
        input: 'mouse',
        origin,
        before: { scrollX: before.scrollX, scrollY: before.scrollY },
        after: { scrollX: after.scrollX, scrollY: after.scrollY },
        moved: before.scrollX !== after.scrollX || before.scrollY !== after.scrollY,
        ...inputGate,
        ...(wheel && wheel.acknowledged === false ? { wheel } : {}),
        ...(pointer ? { pointer } : {})
      };
    } finally {
      this.finishInputOperation(operation);
    }
  }

  key(tabId, { key, action = 'press' }, sessionId) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('Key is required');
    if (!['press', 'down', 'up'].includes(action)) throw new Error('Key action must be press, down, or up');
    const prepared = this.prepareNativeInput(tabId);
    const webContents = prepared.tab.webContents;
    // Carry the virtual key code and DOM `code`, not just the label. Without them
    // the page gets a keydown with key:"" and no default action — ArrowDown never
    // scrolls, Enter never submits, Tab never moves focus.
    const described = describeKey(key);
    const events = action === 'press'
      ? [cdpKeyParams(described, 'keyDown'), cdpKeyParams(described, 'keyUp')]
      : [cdpKeyParams(described, action === 'down' ? 'keyDown' : 'keyUp')];
    if (action === 'down') this.trackHeld(sessionId, tabId, 'keys', key);
    else this.forgetHeld(sessionId, tabId, 'keys', key);
    const background = this.getSelectedTabId() !== tabId || prepared.forceBackground;
    const outcomes = background && typeof this.debuggerLeaseManager?.sendBatch === 'function'
      ? [this.debuggerLeaseManager.sendBatch(tabId, 'background key input', events.map((event) => ({ method: 'Input.dispatchKeyEvent', params: event }))).then(() => ({ tabId, input: 'cdp-background', count: events.length }))]
      : events.map((event) => this.dispatchInput(tabId, webContents, event, 'key', prepared.forceBackground));
    return settleInputOutcomes(outcomes, { tabId, key, action });
  }

  type(tabId, { text }) {
    if (typeof text !== 'string') throw new Error('Text must be a string');
    const prepared = this.prepareNativeInput(tabId);
    const webContents = prepared.tab.webContents;
    return settleInputOutcomes([this.dispatchInput(tabId, webContents, { text }, 'text', prepared.forceBackground)], { tabId, length: text.length });
  }

  // Unlike native insertText(), this is deliberately idempotent. It targets a
  // freshly resolved snapshot element and returns compact proof without exposing
  // the text. Text-like controls select their own content during the same
  // page-side focus evaluation, then use the native input pipeline; native
  // selects retain the established setter path because browser_fill has
  // historically accepted their value directly.
  async fillElement(tabId, { index, text } = {}) {
    if (typeof text !== 'string') throw new Error('browser_fill text must be a string');
    const element = await this.elementRect(tabId, { index });
    const selector = String(element.selector || '').trim();
    if (!selector) throw new Error('The selected element has no stable selector; observe the page again before filling it.');
    const tab = this.requireTab(tabId);
    const focused = await this.evaluatePage(tab, 'focus form control', buildFocusElementScript(selector), 8_000,
      'Timed out focusing the selected page control. Inspect the current page and retry with a fresh observation.');
    let result;
    if (focused?.ok !== true) {
      result = { ok: false, changed: false, matched: false, valueLength: Number(focused?.valueLength) || 0, reason: focused?.reason || 'The selected control could not receive focus.' };
    } else if (focused.native === true) {
      const prepared = this.prepareNativeInput(tabId);
      await this.dispatchInput(tabId, prepared.tab.webContents, { text }, 'text', prepared.forceBackground);
      await this.settleAfterInput(tab, selector, focused.autocomplete === true);
      result = await this.evaluatePage(tab, 'form fill verification', buildReadFilledValueScript(selector, text, focused.value), 8_000,
        'Timed out verifying the selected page control. Inspect the current page and retry with a fresh observation.');
    } else {
      const script = buildFillElementScript(selector, text);
      result = await this.evaluatePage(tab, 'form fill verification', script, 8_000,
        'Timed out filling the selected page control. Inspect the current page and retry with a fresh observation.');
    }
    return {
      tabId,
      index: Number(index),
      element: { tag: element.tag, name: element.name, text: element.text },
      ok: result?.ok === true,
      changed: result?.changed === true,
      matched: result?.matched === true,
      valueLength: Number(result?.valueLength) || 0,
      reason: result?.reason ? String(result.reason).slice(0, 500) : undefined
    };
  }

  // LORDE_FILL_FORM_V1 — fill many controls in one tool call. Each field write
  // would otherwise cost its own model round trip, and the round trip is where
  // the latency lives, not the DOM write. fillElement already verifies every
  // control, so one batch call yields one verification block instead of N
  // interleaved snapshot-verify cycles. A bad index is reported, never fatal.
  async fillForm(tabId, { fields } = {}) {
    if (!Array.isArray(fields) || !fields.length) throw new Error('browser_fill_form needs a non-empty fields array.');
    if (fields.length > 40) throw new Error('browser_fill_form accepts at most 40 fields per call.');
    const results = [];
    for (const field of fields) {
      const index = Number(field && field.index);
      if (!Number.isFinite(index)) {
        results.push({ index: field && field.index !== undefined ? field.index : null, ok: false, changed: false, reason: 'Field index is not a number.' });
        continue;
      }
      try {
        results.push(await this.fillElement(tabId, { index, text: String(field && field.text !== undefined ? field.text : '') }));
      } catch (error) {
        results.push({ index, ok: false, changed: false, reason: String(error && error.message ? error.message : error).slice(0, 300) });
      }
    }
    const filled = results.filter(item => item.ok === true).length;
    return { tabId, requested: fields.length, filled, failed: fields.length - filled, fields: results };
  }

  // Idempotent: safe to call for an unknown owner, a closed tab, or twice.
  releaseSessionInput(sessionId) {
    const owner = inputOwner(sessionId);
    this.sessionInputGeneration.set(owner, (this.sessionInputGeneration.get(owner) || 0) + 1);
    this.cancelActivePointerOperations({ owner, reason: 'session-input-released' });
    const held = this.heldInput.get(owner);
    this.heldInput.delete(owner);
    if (!held) return { released: false, buttons: [], keys: [] };
    const buttons = [...held.buttons];
    const keys = [...held.keys];
    const webContents = this.findLiveWebContents(held.tabId);
    const releasePoint = this.lastPointer.get(held.tabId) || { x: 0, y: 0 };
    for (const button of buttons) {
      this.beginReleasedButtonCleanup(owner, held.tabId, button, webContents, held.buttonRoutes?.get(button));
    }
    for (const key of keys) {
      trySendInputEvent(webContents, { type: 'keyUp', keyCode: describeKey(key).electron || key });
    }
    const anotherButtonRemainsHeld = [...this.heldInput.values()].some((candidate) => candidate.tabId === held.tabId && candidate.buttons.size > 0);
    if (buttons.length > 0 && !anotherButtonRemainsHeld) {
      // Session cleanup is also the visual release edge. A completed standalone
      // mouseDown no longer has an active motion operation, but its permanently
      // mounted pointer must not carry pressed=true into the next action.
      ignoreVisualFailure(() => this.pointerVisualizer?.release?.(held.tabId, releasePoint, buttons.at(-1)));
    }
    return { released: buttons.length > 0 || keys.length > 0, tabId: held.tabId, buttons, keys };
  }

  releaseTabPointerButtons(tabId, reason = 'pointer-surface-invalidated') {
    // Our own preparation reports a surface change too; cancelling here would
    // drop the press of the click that triggered the preparation.
    if (!this.suppressPointerInvalidation) this.cancelActivePointerOperations({ tabId, reason });
    // A pinned drag owns the pointer for its whole duration. A surface
    // invalidation mid-drag must NOT dispatch a cleanup release at the stale
    // grab point — the page consumes it as the drop ("missed the slots").
    // The drag's own finally block releases at the real end coordinate.
    const pinnedDrag = this.activePointerOperations.get(tabId);
    if (pinnedDrag?.pinned && pinnedDrag.active !== false) {
      return { released: false, tabId, reason, owners: [] };
    }
    const webContents = this.findLiveWebContents(tabId);
    const released = [];
    for (const [owner, held] of [...this.heldInput]) {
      if (held.tabId !== tabId || held.buttons.size === 0) continue;
      const buttons = [...held.buttons];
      held.buttons.clear();
      if (held.keys.size === 0) this.heldInput.delete(owner);
      for (const button of buttons) {
        // This path is called because the app-owned pointer surface was
        // invalidated (resize, hide, minimise, tab switch, or renderer loss).
        // A selected BrowserView can still be reported as the selected tab
        // while it has no Windows compositor surface, so its native
        // sendInputEvent channel is not a reliable release edge. Address the
        // exact WebContents through CDP and only record the cleanup tombstone
        // after that delivery commits.
        this.beginReleasedButtonCleanup(owner, tabId, button, webContents, held.buttonRoutes?.get(button), true);
      }
      held.buttonRoutes?.clear();
      released.push({ owner, buttons });
    }
    return { released: released.length > 0, tabId, reason, owners: released };
  }

  releaseTabInput(tabId) {
    this.tabInputGeneration.set(tabId, (this.tabInputGeneration.get(tabId) || 0) + 1);
    this.cancelActivePointerOperations({ tabId, reason: 'tab-input-released' });
    const owners = [...this.heldInput].filter(([, held]) => held.tabId === tabId).map(([owner]) => owner);
    const released = owners.map((owner) => this.releaseSessionInput(owner));
    // Pointer memory for a destroyed tab is no longer useful.
    this.lastPointer.delete(tabId);
    this.pointerVisualizer?.forgetTab?.(tabId);
    return released;
  }

  releaseAllInput() {
    this.globalInputGeneration += 1;
    this.cancelActivePointerOperations({ reason: 'all-input-released' });
    return [...this.heldInput.keys()].map((owner) => this.releaseSessionInput(owner));
  }

  inputOperationToken(sessionId, tabId) {
    const owner = inputOwner(sessionId);
    const previous = this.activePointerOperations.get(tabId);
    if (previous?.active) this.cancelInputOperation(previous, 'superseded-by-new-input');
    const pointerAction = (this.pointerActionGeneration.get(tabId) || 0) + 1;
    this.pointerActionGeneration.set(tabId, pointerAction);
    const operation = {
      owner,
      tabId,
      global: this.globalInputGeneration,
      session: this.sessionInputGeneration.get(owner) || 0,
      tab: this.tabInputGeneration.get(tabId) || 0,
      pointerAction,
      active: true
    };
    this.activePointerOperations.set(tabId, operation);
    return operation;
  }

  inputOperationCurrent(operation) {
    return operation?.active !== false
      && operation.global === this.globalInputGeneration
      && operation.session === (this.sessionInputGeneration.get(operation.owner) || 0)
      && operation.tab === (this.tabInputGeneration.get(operation.tabId) || 0)
      && operation.pointerAction === (this.pointerActionGeneration.get(operation.tabId) || 0);
  }

  runInputOperation(operation, owned, action) {
    if (!owned) return action();
    try {
      const outcome = action();
      return finalizeMaybePromise(outcome, () => this.finishInputOperation(operation));
    } catch (error) {
      this.finishInputOperation(operation);
      throw error;
    }
  }

  finishInputOperation(operation) {
    if (!operation) return;
    operation.active = false;
    if (this.activePointerOperations.get(operation.tabId) === operation) {
      this.activePointerOperations.delete(operation.tabId);
    }
  }

  cancelInputOperation(operation, reason) {
    if (!operation?.active) return false;
    // Pinned operations (an in-flight drag) survive surface invalidation and
    // supersession; only an explicit session/tab/global input release cancels.
    if (operation.pinned
      && reason !== 'session-input-released'
      && reason !== 'tab-input-released'
      && reason !== 'all-input-released') return false;
    operation.active = false;
    if (this.activePointerOperations.get(operation.tabId) === operation) {
      this.activePointerOperations.delete(operation.tabId);
    }
    ignoreVisualFailure(() => this.pointerVisualizer?.cancelMotion?.(operation.tabId, operation.pointerAction, reason));
    return true;
  }

  cancelActivePointerOperations({ owner, tabId, reason } = {}) {
    let cancelled = 0;
    for (const operation of [...this.activePointerOperations.values()]) {
      if (owner !== undefined && operation.owner !== owner) continue;
      if (tabId !== undefined && operation.tabId !== tabId) continue;
      if (this.cancelInputOperation(operation, reason || 'input-operation-cancelled')) cancelled += 1;
    }
    return cancelled;
  }

  beginReleasedButtonCleanup(owner, tabId, button, webContents, originalRoute, forceCdp = false) {
    this.pruneReleasedButtonTombstones();
    const key = releasedButtonKey(owner, tabId, button);
    const existing = this.releasedButtonTombstones.get(key);
    if (existing) return existing.state === 'released' ? true : existing.promise;
    const entry = { state: 'pending', expiresAt: Date.now() + 30_000, promise: null };
    this.releasedButtonTombstones.set(key, entry);
    const dispatchCleanup = () => {
      const retry = this.dispatchCleanupMouseUp(tabId, button, webContents, originalRoute, forceCdp);
      if (!retry) throw new Error('Cleanup mouse release could not be delivered');
      return retry;
    };
    const pendingRelease = this.pendingButtonReleases.get(key);
    let delivery;
    try {
      // If the caller's ordinary release is already in the debugger queue,
      // cleanup owns that same promise. It retries only when that delivery
      // rejects, never merely because it has not settled yet.
      delivery = pendingRelease
        ? Promise.resolve(pendingRelease.promise).catch(dispatchCleanup)
        : dispatchCleanup();
    } catch {
      if (this.releasedButtonTombstones.get(key) === entry) this.releasedButtonTombstones.delete(key);
      return false;
    }
    if (typeof delivery.then !== 'function') {
      entry.state = 'released';
      entry.promise = Promise.resolve(true);
      return true;
    }
    entry.promise = Promise.resolve(delivery).then(
      () => {
        if (this.releasedButtonTombstones.get(key) === entry) {
          entry.state = 'released';
          entry.expiresAt = Date.now() + 30_000;
        }
        return true;
      },
      () => {
        if (this.releasedButtonTombstones.get(key) === entry) this.releasedButtonTombstones.delete(key);
        return false;
      }
    );
    return entry.promise;
  }

  trackPendingButtonRelease(owner, tabId, button, delivery) {
    if (!delivery || typeof delivery.then !== 'function') return delivery;
    const key = releasedButtonKey(owner, tabId, button);
    const entry = { promise: null };
    entry.promise = Promise.resolve(delivery).finally(() => {
      if (this.pendingButtonReleases.get(key) === entry) this.pendingButtonReleases.delete(key);
    });
    this.pendingButtonReleases.set(key, entry);
    return entry.promise;
  }

  dispatchCleanupMouseUp(tabId, button, webContents, originalRoute, forceCdp = false) {
    if (!webContents) return false;
    const selectedSurfaceUnavailable = this.getSelectedTabId() === tabId
      && this.isTabPaintable?.(tabId) === false;
    // Release where the pointer actually is. A hardcoded (0,0) release after a
    // press on a control makes the page fire its click on <body> instead of the
    // control — the live log shows lastDown: button(67,298) / lastUp: body(0,0)
    // and the button never activates. The release is an edge event: its
    // POSITION is what decides which element receives the click.
    const releasePoint = this.lastPointer.get(tabId) || { x: 0, y: 0 };
    const useCdp = forceCdp
      || originalRoute === 'cdp'
      || this.getSelectedTabId() !== tabId
      || selectedSurfaceUnavailable;
    if (useCdp) {
      return this.dispatchCdp(tabId, 'cleanup mouse release', 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: releasePoint.x, y: releasePoint.y, button, buttons: 0, clickCount: 1
      });
    }
    return trySendInputEvent(webContents, { type: 'mouseUp', x: releasePoint.x, y: releasePoint.y, button, clickCount: 1 });
  }

  clearReleasedButtonTombstone(owner, tabId, button) {
    this.releasedButtonTombstones.delete(releasedButtonKey(owner, tabId, button));
  }

  consumeReleasedButtonTombstone(owner, tabId, button) {
    this.pruneReleasedButtonTombstones();
    const key = releasedButtonKey(owner, tabId, button);
    const entry = this.releasedButtonTombstones.get(key);
    if (!entry) return false;
    if (entry.state === 'released') {
      this.releasedButtonTombstones.delete(key);
      return true;
    }
    return entry.promise.then((released) => {
      if (this.releasedButtonTombstones.get(key) === entry) this.releasedButtonTombstones.delete(key);
      return released;
    });
  }

  pruneReleasedButtonTombstones() {
    const now = Date.now();
    for (const [key, entry] of this.releasedButtonTombstones) {
      if (entry.expiresAt <= now) this.releasedButtonTombstones.delete(key);
    }
  }

  async waitForInputOperationDelay(delayMs, operation) {
    const deadline = Date.now() + Math.max(0, delayMs);
    while (Date.now() < deadline) {
      if (!this.inputOperationCurrent(operation)) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(16, Math.max(1, deadline - Date.now()))));
    }
    return this.inputOperationCurrent(operation);
  }

  isHeld(sessionId, tabId, kind, value) {
    const held = this.heldInput.get(inputOwner(sessionId));
    return Boolean(held && held.tabId === tabId && held[kind]?.has(value));
  }

  // Visualizer health: a tab whose overlay never acknowledges a move gets its
  // visual stages skipped entirely (the cursor is decoration; waiting on it
  // cost ~2 timeouts per click — the click-order run's 1.2s/click).
  visualizerUsable(tabId) {
    // The visualizer is NON-NEGOTIABLE (owner directive): every click is
    // visualized. Speed comes from short animations and bounded acks, never
    // from skipping the visual — a disconnected cursor fails the app's
    // transparency mission. Strikes are telemetry only.
    if (!this.pointerVisualizer) return false;
    return this.getSelectedTabId() === tabId && this.isTabPaintable?.(tabId) !== false;
  }

  noteVisualizerStrike(tabId) {
    const key = String(tabId);
    const strikes = (this.visualizerStrikes.get(key) || 0) + 1;
    this.visualizerStrikes.set(key, strikes);
    if (strikes >= 2) this.visualizerBroken.add(key);
    return strikes;
  }

  // The mask of buttons currently held in this tab for this owner — CDP
  // requires it on every mouse event (a move during a press must say which
  // button is down, or the page never starts a drag).
  heldButtonMask(sessionId, tabId) {
    const held = this.heldInput.get(inputOwner(sessionId));
    if (!held || held.tabId !== tabId || !held.buttons?.size) return 0;
    let mask = 0;
    for (const button of held.buttons) mask |= mouseButtonMask(button);
    return mask;
  }

  heldInputState(sessionId) {
    const held = this.heldInput.get(inputOwner(sessionId));
    return held ? { tabId: held.tabId, buttons: [...held.buttons], keys: [...held.keys] } : null;
  }

  trackHeld(sessionId, tabId, kind, value, metadata = null) {
    const owner = inputOwner(sessionId);
    const existing = this.heldInput.get(owner);
    // A caller only ever holds input in its currently bound tab.
    const held = existing && existing.tabId === tabId ? existing : { tabId, buttons: new Set(), keys: new Set(), buttonRoutes: new Map() };
    if (!held.buttonRoutes) held.buttonRoutes = new Map();
    held[kind].add(value);
    if (kind === 'buttons' && metadata?.route) held.buttonRoutes.set(value, metadata.route);
    this.heldInput.set(owner, held);
  }

  forgetHeld(sessionId, tabId, kind, value) {
    const owner = inputOwner(sessionId);
    const held = this.heldInput.get(owner);
    if (!held || held.tabId !== tabId) return;
    held[kind].delete(value);
    if (kind === 'buttons') held.buttonRoutes?.delete(value);
    if (held.buttons.size === 0 && held.keys.size === 0) this.heldInput.delete(owner);
  }

  findLiveWebContents(tabId) {
    const tab = this.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab || tab.webContents.isDestroyed?.()) return null;
    return tab.webContents;
  }

  async readElements(tab, options = {}) {
    const maxElements = clampInteger(options.maxElements ?? 200, 1, 500);
    const interactiveOnly = options.interactiveOnly !== false;
    const includeText = options.includeText !== false;
    const selector = typeof options.selector === 'string' && options.selector.trim().length > 0 ? options.selector.trim() : null;
    const text = typeof options.text === 'string' && options.text.trim().length > 0 ? options.text.trim().toLowerCase() : null;
    // Relevance anchor: on pages with MORE interactive elements than the cap,
    // the collector prefers the controls nearest the agent's last pointer
    // position (grounded in where work is happening) instead of DOM order.
    // Pages at or under the cap are unaffected — identical output.
    const anchor = options.anchor && Number.isFinite(options.anchor.x) && Number.isFinite(options.anchor.y)
      ? { x: Math.round(options.anchor.x), y: Math.round(options.anchor.y) }
      : null;
    // A frame path addresses a same-origin iframe reported by browser_dom_snapshot
    // (e.g. [0]). Reading inside it is what turns "this page is an empty shell"
    // into a usable snapshot on frame-based apps.
    const framePath = Array.isArray(options.framePath) && options.framePath.length
      ? options.framePath.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
      : null;
    const payload = await this.evaluatePage(tab, 'DOM snapshot', buildElementCollectorScript({ interactiveOnly, includeText, maxElements, selector, text, anchor, framePath: framePath && framePath.length ? framePath : null }), 8_000,
      'Timed out reading the bound tab structure. If the Browser-use window is still starting up, wait a moment and retry.');
    // Frame reads return frame-local rects. Lift them once, here, so every
    // consumer — indexed click, element_rect, screenshots — shares one coordinate
    // space: top-document CSS pixels.
    const offset = framePath && payload?.frameOffset && (payload.frameOffset.x || payload.frameOffset.y) ? payload.frameOffset : null;
    if (offset) {
      const lift = (entry) => {
        if (!entry) return;
        if (entry.rect) entry.rect = { ...entry.rect, x: entry.rect.x + offset.x, y: entry.rect.y + offset.y };
        if (entry.center) entry.center = { x: entry.center.x + offset.x, y: entry.center.y + offset.y };
        entry.framePath = framePath;
      };
      for (const key of ['elements', 'visualTargets', 'regions', 'landmarks']) {
        if (Array.isArray(payload[key])) payload[key].forEach(lift);
      }
    }
    const result = { tabId: tab.id, ...payload };
    delete result.frameOffset;
    if (framePath) {
      // The tab's viewport belongs to the top document; a frame read reports the
      // frame's box and must not replace it.
      const topViewport = this.lastViewport.get(tab.id);
      if (topViewport) result.viewport = { ...topViewport };
    } else if (result.viewport?.width > 0 && result.viewport?.height > 0) this.lastViewport.set(tab.id, result.viewport);
    return result;
  }

  // Current CSS viewport in page coordinates (window.innerWidth/innerHeight).
  // Bounded and failure-tolerant: coordinate metadata is advisory, never a
  // reason to fail the capture itself.
  async captureCssViewport(tabId) {
    try {
      const tab = this.requireTab(tabId);
      const viewport = await withTimeout(
        this.evaluatePage(tab, 'viewport geometry', `(() => ({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, dpr: window.devicePixelRatio || 1 }))()`,
          3_000, 'Timed out reading viewport geometry.'
        )
      );
      if (Number(viewport?.width) > 0 && Number(viewport?.height) > 0) return {
        width: Math.round(Number(viewport.width)),
        height: Math.round(Number(viewport.height)),
        scrollX: Number(viewport.scrollX) || 0,
        scrollY: Number(viewport.scrollY) || 0,
        devicePixelRatio: Number(viewport.dpr) || 1
      };
    } catch { /* metadata is best-effort */ }
    const remembered = this.lastViewport.get(String(tabId));
    return remembered ? { ...remembered } : null;
  }

  pageDevicePixelRatio(tabId) {
    return this.lastViewport.get(String(tabId))?.devicePixelRatio ?? null;
  }

  // Post-input hit test: what element actually sits at the clicked CSS point,
  // PLUS the page's text tail. Canvas surfaces report the canvas itself —
  // correct proof the coordinate reached page content, but for board/canvas
  // games it says NOTHING about what the click DID (selected? moved? nothing?).
  // The text tail carries exactly that state for most pages (move lists, turn
  // and status lines, button labels, validation errors), so the model can
  // verify a click's effect from the click result instead of re-screenshotting
  // and re-deriving the whole scene — the loop the live chess runs burned
  // minutes on.
  async hitTest(tabId, { x, y }) {
    const expression = `(() => {
          // CLICK-PROBE: the page itself records every click/mousedown/mouseup
          // it receives, with coordinates and target. A click that dispatches
          // (hit test says the element is under the point) but produces no
          // page event is a DELIVERY problem; a page event at a DIFFERENT
          // coordinate is a transform problem; a page event on the right
          // element with no app reaction is the page's own behavior. Without
          // this the agent (and the harness) cannot tell those apart — the
          // live click-order game showed hit:true on every field while
          // progress stayed 0/40.
          try {
            if (!window.__bdsClickProbe) {
              const probe = { clicks: [], lastDown: null, lastUp: null };
              const point = (event) => ({ x: Math.round(event.clientX), y: Math.round(event.clientY) });
              const target = (event) => ({
                tag: event.target?.tagName ? String(event.target.tagName).toLowerCase() : null,
                id: event.target?.id || null,
                cls: String(event.target?.className || '').slice(0, 60)
              });
              document.addEventListener('click', (event) => {
                probe.clicks.push({ ...point(event), ...target(event), at: Date.now() });
                if (probe.clicks.length > 20) probe.clicks.shift();
              }, true);
              document.addEventListener('mousedown', (event) => { probe.lastDown = { ...point(event), ...target(event), at: Date.now() }; }, true);
              document.addEventListener('mouseup', (event) => { probe.lastUp = { ...point(event), ...target(event), at: Date.now() }; }, true);
              window.__bdsClickProbe = probe;
            }
          } catch { /* probing is best-effort */ }
          const probe = window.__bdsClickProbe || null;
          const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
          // PAGE-TEXT THROTTLE: innerText forces a layout pass. Recomputing it
          // on every click made a 48-click batch 48 reflows - the whole machine
          // slowed down and clicks went stale. The tail is cached in the page
          // for 500ms, which still gives every burst its post-action state.
          let text = '';
          try {
            const cached = window.__bdsTextCache;
            if (cached && Date.now() - cached.at < 500) text = cached.text;
            else {
              text = String((document.body && document.body.innerText) || '');
              window.__bdsTextCache = { at: Date.now(), text };
            }
          } catch { text = ''; }
          const tail = text.replace(/\\s+/g, ' ').trim().slice(-240);
          if (!el) return { hit: false, tag: null, textLength: text.length, textTail: tail, ...(probe ? { pageClicks: probe.clicks.slice(-2), lastDown: probe.lastDown, lastUp: probe.lastUp } : {}) };
          const rect = el.getBoundingClientRect();
          return {
            hit: true,
            tag: el.tagName ? el.tagName.toLowerCase() : null,
            id: el.id || null,
            classes: typeof el.className === 'string' ? el.className.slice(0, 120) : null,
            role: el.getAttribute?.('role') || null,
            isCanvas: el.tagName === 'CANVAS',
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            textLength: text.length,
            textTail: tail,
            ...(probe ? { pageClicks: probe.clicks.slice(-2), lastDown: probe.lastDown, lastUp: probe.lastUp } : {})
          };
        })()`;
    const startedAt = Date.now();
    const attempt = () => {
      const tab = this.requireTab(tabId);
      // evaluatePage already bounds itself (3s + its own message). Wrapping it
      // in a SECOND withTimeout without arguments made that outer timer fire
      // immediately (setTimeout with an undefined delay) and killed EVERY hit
      // test with a messageless Error — the 100% hit-test failure on the live
      // chess run, and the reason the model never saw the board rect.
      return this.evaluatePage(tab, 'post-input hit test', expression, 3_000, 'Timed out hit-testing the clicked point.');
    };
    const describe = (error) => {
      if (!(error instanceof Error)) return String(error);
      if (error.message) return `${error.name}: ${error.message.slice(0, 160)}`;
      // A messageless Error names itself through its first stack frame.
      const frame = String(error.stack || '').split('\n').slice(1, 2).join(' | ').trim().slice(0, 160);
      return `${error.name}: (no message; thrown at ${frame || 'unknown frame'}; after ${Date.now() - startedAt}ms)`;
    };
    try {
      return await attempt();
    } catch (firstError) {
      // The read runs IMMEDIATELY after the release dispatch, and the live
      // chess run showed it failing right there while the SAME evaluate path
      // succeeded for browser_execute seconds later — a contention window,
      // not a broken page. Two bounded retries separate those cases; a third
      // failure is real and must name exactly what broke.
      for (let attempt_ = 1; attempt_ <= 2; attempt_ += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          return await attempt();
        } catch (error) {
          if (attempt_ === 2) {
            const detail = describe(error);
            const first = describe(firstError);
            return {
              hit: null,
              reason: 'hit-test-unavailable',
              error: detail.slice(0, 200),
              ...(detail === first ? {} : { firstError: first.slice(0, 200) })
            };
          }
        }
      }
    }
  }

  async evaluatePage(tab, purpose, expression, timeoutMs, timeoutMessage) {
    const evaluate = async () => {
      let cdpFailure = null;
      if (this.debuggerLeaseManager) {
        try {
          const response = await this.debuggerLeaseManager.send(tab.id, purpose, 'Runtime.evaluate', {
            expression: String(expression),
            awaitPromise: true,
            returnByValue: true,
            userGesture: false
          });
          if (response?.exceptionDetails) {
            const detail = String(response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || 'The page evaluation failed.').replace(/\s+/g, ' ').slice(0, 500);
            throw new Error(detail);
          }
          if (Object.prototype.hasOwnProperty.call(response?.result || {}, 'value')) return response.result.value;
          throw new Error('The page evaluation returned no serializable value.');
        } catch (error) {
          // A DevTools attachment or a transient CDP handoff issue must not
          // turn a healthy bound page into an agent dead end. Fall back to the
          // older isolated page evaluator; the bounded caller still owns the
          // timeout and error surface. Remember WHY the CDP path refused so a
          // fallback failure can name both stages instead of a bare Error.
          cdpFailure = String(error?.message || error).slice(0, 300);
        }
      }
      try {
        return await tab.webContents.executeJavaScript(String(expression), true);
      } catch (error) {
        const detail = String(error?.message || error);
        throw new Error(`page eval failed (${cdpFailure ? `cdp path: ${cdpFailure}; ` : ''}fallback: ${detail || 'no error text'})`.slice(0, 500));
      }
    };
    return withTimeout(evaluate(), timeoutMs, timeoutMessage);
  }

  resolveElementIndex(tabId, index) {
    const numericIndex = Number(index);
    if (!Number.isInteger(numericIndex) || numericIndex < 0) throw new Error('Element index must be a non-negative integer');
    const snapshot = this.elementSnapshots.get(tabId);
    if (!snapshot) throw new Error('No DOM snapshot is available for this tab. Call browser_dom_snapshot first.');
    const element = snapshot.elements.find((candidate) => candidate.index === numericIndex);
    if (!element) throw new Error(`Element index ${numericIndex} is stale; call browser_dom_snapshot again.`);
    return element;
  }

  requireTab(tabId) {
    const tab = this.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab) {
      const error = new Error('The bound tab is no longer available. Rebind or open a tab, then retry.');
      error.code = 'BOUND_TAB_MISSING';
      error.recoverable = true;
      throw error;
    }
    return tab;
  }
}

function normalizedIdentity(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function bestElementMatch(previous, candidates = []) {
  const scored = candidates.map((candidate) => {
    if (candidate.tag !== previous.tag) return { candidate, score: -1 };
    let score = 0;
    if (previous.id && candidate.id === previous.id) score += 10;
    if (previous.testId && candidate.testId === previous.testId) score += 9;
    if (previous.dataTool && candidate.dataTool === previous.dataTool) score += 9;
    if (previous.name && normalizedIdentity(candidate.name) === normalizedIdentity(previous.name)) score += 6;
    if (previous.text && normalizedIdentity(candidate.text) === normalizedIdentity(previous.text)) score += 5;
    if (previous.role && candidate.role === previous.role) score += 2;
    if (previous.selector && candidate.selector === previous.selector) score += 8;
    return { candidate, score };
  }).filter(({ score }) => score >= 5).sort((left, right) => right.score - left.score);
  if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) return null;
  return scored[0].candidate;
}

function inputOwner(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : ANONYMOUS_INPUT_OWNER;
}

function releasedButtonKey(owner, tabId, button) {
  return JSON.stringify([String(owner), String(tabId), String(button)]);
}

async function withDebugger(webContents, action, operation) {
  let attachedHere = false;
  try {
    if (!webContents.debugger?.isAttached?.()) {
      webContents.debugger.attach('1.3');
      attachedHere = true;
    }
    return await operation(webContents.debugger);
  } catch (error) {
    throw new Error(`Could not dispatch ${action}: ${error.message}. Close DevTools for this tab and retry.`);
  } finally {
    if (attachedHere) {
      try { webContents.debugger.detach(); } catch {}
    }
  }
}

async function dispatchNativeMouse(webContents, event) {
  return withDebugger(webContents, 'native mouse input', (debuggerClient) => debuggerClient.sendCommand('Input.dispatchMouseEvent', event));
}

async function dispatchNativeKey(webContents, event) {
  return withDebugger(webContents, 'native key input', (debuggerClient) => debuggerClient.sendCommand('Input.dispatchKeyEvent', event));
}

async function dispatchNativeText(webContents, text) {
  return withDebugger(webContents, 'native text input', (debuggerClient) => debuggerClient.sendCommand('Input.insertText', { text }));
}

async function dispatchNativeWheel(webContents, { x, y, deltaX, deltaY }) {
  // CDP targets the bound WebContents even when another BrowserView has focus.
  // It also preserves Chromium hit testing, nested scrolling, and cancellation.
  return dispatchNativeMouse(webContents, { type: 'mouseWheel', x, y, deltaX, deltaY });
}

function mouseButtonMask(button) {
  return button === 'left' ? 1 : button === 'right' ? 2 : 4;
}

function cdpMouseToElectronEvent(event) {
  const type = event.type === 'mouseMoved' ? 'mouseMove'
    : event.type === 'mousePressed' ? 'mouseDown'
      : event.type === 'mouseReleased' ? 'mouseUp' : null;
  if (!type) return null;
  return {
    type,
    x: event.x,
    y: event.y,
    ...(event.button ? { button: event.button } : {}),
    ...(event.clickCount ? { clickCount: event.clickCount } : {})
  };
}

// A key event needs a virtual key code to produce a DEFAULT ACTION. `key` alone
// only labels the event: the page sees keydown, but ArrowDown never scrolls,
// Enter never submits and Tab never moves focus, because the browser resolves
// default actions from the key code. The live measurement for this fork was a
// keydown arriving with key:"" and scrollY unchanged, on both the Electron and
// the CDP route. Electron's sendInputEvent is worse still: it wants its own
// accelerator names ("Down", "Return"), so passing "ArrowDown" produced an
// event with no key at all.
const NAMED_KEYS = {
  Enter: { vk: 13, code: 'Enter', electron: 'Return', text: '\r' },
  Tab: { vk: 9, code: 'Tab', electron: 'Tab' },
  Escape: { vk: 27, code: 'Escape', electron: 'Escape' },
  Backspace: { vk: 8, code: 'Backspace', electron: 'Backspace' },
  Delete: { vk: 46, code: 'Delete', electron: 'Delete' },
  Insert: { vk: 45, code: 'Insert', electron: 'Insert' },
  Home: { vk: 36, code: 'Home', electron: 'Home' },
  End: { vk: 35, code: 'End', electron: 'End' },
  PageUp: { vk: 33, code: 'PageUp', electron: 'PageUp' },
  PageDown: { vk: 34, code: 'PageDown', electron: 'PageDown' },
  ArrowLeft: { vk: 37, code: 'ArrowLeft', electron: 'Left' },
  ArrowUp: { vk: 38, code: 'ArrowUp', electron: 'Up' },
  ArrowRight: { vk: 39, code: 'ArrowRight', electron: 'Right' },
  ArrowDown: { vk: 40, code: 'ArrowDown', electron: 'Down' },
  ' ': { vk: 32, code: 'Space', electron: 'Space', text: ' ' },
  Shift: { vk: 16, code: 'ShiftLeft', electron: 'Shift' },
  Control: { vk: 17, code: 'ControlLeft', electron: 'Control' },
  Alt: { vk: 18, code: 'AltLeft', electron: 'Alt' },
  Meta: { vk: 91, code: 'MetaLeft', electron: 'Meta' },
  CapsLock: { vk: 20, code: 'CapsLock', electron: 'CapsLock' },
  NumLock: { vk: 144, code: 'NumLock', electron: 'NumLock' },
  ScrollLock: { vk: 145, code: 'ScrollLock', electron: 'ScrollLock' },
  Pause: { vk: 19, code: 'Pause', electron: 'Pause' },
  PrintScreen: { vk: 44, code: 'PrintScreen', electron: 'PrintScreen' },
  ContextMenu: { vk: 93, code: 'ContextMenu', electron: 'ContextMenu' }
};

// Names a model actually types, mapped onto the DOM key value above.
const KEY_ALIASES = {
  return: 'Enter', esc: 'Escape', spacebar: ' ', space: ' ',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown', pageup: 'PageUp', pagedown: 'PageDown',
  ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt',
  cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta', meta: 'Meta',
  enter: 'Enter', tab: 'Tab', backspace: 'Backspace', insert: 'Insert',
  home: 'Home', end: 'End', capslock: 'CapsLock', numlock: 'NumLock',
  scrolllock: 'ScrollLock', pause: 'Pause', printscreen: 'PrintScreen', menu: 'ContextMenu'
};

const PUNCTUATION_CODES = {
  '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5',
  '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
  '-': 'Minus', _: 'Minus', '=': 'Equal', '+': 'Equal',
  '[': 'BracketLeft', '{': 'BracketLeft', ']': 'BracketRight', '}': 'BracketRight',
  '\\': 'Backslash', '|': 'Backslash', ';': 'Semicolon', ':': 'Semicolon',
  "'": 'Quote', '"': 'Quote', ',': 'Comma', '<': 'Comma', '.': 'Period', '>': 'Period',
  '/': 'Slash', '?': 'Slash', '`': 'Backquote', '~': 'Backquote'
};

// One description per key, used by BOTH delivery routes so they can never drift.
function describeKey(rawKey) {
  const key = String(rawKey ?? '');
  const normalized = KEY_ALIASES[key.toLowerCase()] || key;
  const named = NAMED_KEYS[normalized];
  if (named) return { key: normalized, ...named };
  if (/^f([1-9]|1\d|2[0-4])$/i.test(normalized)) {
    const index = Number(normalized.slice(1));
    return { key: `F${index}`, code: `F${index}`, vk: 111 + index, electron: `F${index}` };
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const isLetter = /^[a-z]$/i.test(key);
    const isDigit = /^[0-9]$/.test(key);
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : (PUNCTUATION_CODES[key] || '');
    return { key, code, vk: upper.charCodeAt(0), electron: upper, text: key };
  }
  // Unknown key: keep the historical behaviour rather than inventing a code.
  return { key, code: '', vk: 0, electron: key };
}

// CDP params for one key edge. `text` is what actually inserts a character, and
// it belongs only on the down edge.
function cdpKeyParams(described, type) {
  return {
    type,
    key: described.key,
    ...(described.code ? { code: described.code } : {}),
    ...(described.vk ? { windowsVirtualKeyCode: described.vk, nativeVirtualKeyCode: described.vk } : {}),
    ...(described.text && type === 'keyDown' ? { text: described.text, unmodifiedText: described.text } : {})
  };
}

function cdpKeyToElectronEvent(event) {
  const bitmask = Number(event.modifiers) || 0;
  const modifiers = [];
  if (bitmask & 2) modifiers.push('control');
  if (bitmask & 4) modifiers.push('meta');
  if (bitmask & 8) modifiers.push('alt');
  if (bitmask & 1) modifiers.push('shift');
  return {
    type: event.type,
    keyCode: describeKey(event.key).electron || event.key,
    ...(modifiers.length ? { modifiers } : {})
  };
}

function settleInputOutcomes(outcomes, result) {
  const pending = outcomes.filter((outcome) => outcome && typeof outcome.then === 'function');
  if (pending.length === 0) return result;
  return Promise.all(pending).then((resolved) => ({ ...result, input: resolved.at(-1)?.input || 'cdp-background' }));
}

function afterMaybePromise(value, continuation) {
  return value && typeof value.then === 'function' ? value.then(continuation) : continuation(value);
}

function finalizeMaybePromise(value, finalizer) {
  if (value && typeof value.then === 'function') return value.finally(finalizer);
  finalizer();
  return value;
}

// Resolve with the real value when it arrives inside the budget, otherwise with
// a copy of `fallback`. The losing promise is always consumed, so a late
// rejection can never surface as an unhandled rejection.
function withBudget(promise, budgetMs, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ...fallback }), Math.max(1, Number(budgetMs) || 1));
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(finish, () => finish({ ...fallback }));
  });
}

// A wheel that was never acknowledged AND a document that did not move is an
// UNKNOWN delivery, not a successful scroll. Returning a success envelope there
// is the same class of lie as reporting `dispatched: true` for a click the page
// never received: the caller moves on believing the viewport advanced, and the
// next observation silently disagrees with the model's own plan. Fail loudly and
// say what the page actually shows.
function assertScrollDelivered({ before, after, wheel, deltaX, deltaY }) {
  if (!before || !after) return false;
  if ((Number(deltaX) || 0) === 0 && (Number(deltaY) || 0) === 0) return false;
  const moved = before.scrollX !== after.scrollX || before.scrollY !== after.scrollY;
  if (moved) return true;
  if (wheel?.acknowledged !== false) return false;
  throw new Error(
    `The wheel event was never acknowledged and the document did not scroll `
    + `(scrollX=${after.scrollX}, scrollY=${after.scrollY} unchanged after deltaY=${Number(deltaY) || 0}). `
    + 'The browsing view is most likely not painted or not visible, so the wheel never reached the '
    + 'renderer. Confirm the Browser-use window is not minimised or fully hidden behind another window, '
    + 'or scroll from the page itself with browser_execute window.scrollTo().'
  );
}

function ignoreVisualFailure(action) {
  try {
    const outcome = action();
    if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {});
  } catch {
    // The transparent pointer surface is nonessential feedback. Native input
    // lifecycle edges must remain safe if that renderer disappears mid-action.
  }
}

// Pointer visualizer results are returned by reference across move/press/release
// stages. Spreading them into the tool result kept a shared object graph, which
// the IPC projection serialized as "[Circular]" and the model saw as an opaque
// click output. Always hand the model a flat, JSON-safe copy.
function safePointerProjection(pointer) {
  if (!pointer || typeof pointer !== 'object') return pointer;
  try {
    return JSON.parse(JSON.stringify(pointer));
  } catch {
    return { status: 'dispatched' };
  }
}

function addPointerOutcome(outcome, pointer) {
  const projected = safePointerProjection(pointer);
  if (!projected) return outcome;
  if (outcome && typeof outcome.then === 'function') return outcome.then((result) => ({ ...result, pointer: projected }));
  return { ...outcome, pointer: projected };
}

function pointerCannotProceed(result, { required = false, waitForArrival = true } = {}) {
  if (result?.interrupted || result?.timedOut || result?.failed) return true;
  if (!required) return false;
  if (!result || result.ignored) return true;
  return waitForArrival && result.completed !== true;
}

function inputWasInterrupted(result) {
  return result?.input === 'interrupted' || pointerCannotProceed(result?.pointer);
}

// clickAt sequences its stages on DELIVERY truth, not on the animated pointer.
// A stage whose visual failed while the operation stayed current dispatched its
// native event through the direct route (pointer.deliveryFallback), so it did
// NOT fail: the click must continue and pair its release. Only a stage that
// genuinely did not deliver — a superseded or cancelled operation — vetoes.
function inputDeliveryFailed(result) {
  if (!result) return true;
  if (result.input === 'interrupted') return true;
  if (!pointerCannotProceed(result.pointer)) return false;
  return result.pointer?.deliveryFallback !== true;
}

// The pointer of a click whose down/up edges both committed. mouseUp always
// dispatches the release, so an interrupted-flavoured pointer here was a
// VISUAL cancellation (superseded trajectory, lost acknowledgement), never a
// failed click — and reporting it as one is what taught the model to
// re-screenshot and replan after clicks that actually landed. Report the last
// healthy visual stage, add the committed marker, and keep a visual failure
// only as informational visualInterrupted.
function committedClickPointer({ moved, pressed, released }) {
  const stages = [released?.pointer, pressed?.pointer, moved?.pointer];
  const visualFailed = stages.some((pointer) => pointerCannotProceed(pointer));
  const healthy = stages.find((pointer) => pointer && !pointerCannotProceed(pointer));
  const projected = safePointerProjection(healthy || released?.pointer || pressed?.pointer || moved?.pointer);
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) return { committed: true };
  const { interrupted, timedOut, failed, ...rest } = projected;
  return { ...rest, ...(visualFailed ? { visualInterrupted: true } : {}), committed: true };
}

function trySendInputEvent(webContents, event) {
  if (!webContents) return false;
  try {
    webContents.sendInputEvent(event);
    return true;
  } catch {
    return false;
  }
}

function assertCoordinates(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Pointer coordinates must be finite numbers');
}

// A DOM index may arrive as a number or as its string form (models and MCP
// clients disagree on the encoding). Anything else is not an index.
function coerceDragIndex(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  if (typeof value === 'string') {
    const match = value.match(/(?:index=)?(\d+)/);
    if (match) {
      const fromString = Number(match[1]);
      if (Number.isInteger(fromString) && fromString >= 0) return fromString;
    }
  }
  return undefined;
}

// DuckDuckGo result links are redirects: //duckduckgo.com/l/?uddg=<encoded>&rut=...
// Resolve them to the real target; anything else passes through untouched.
function decodeDuckDuckGoHref(href) {
  const raw = String(href || '');
  const match = raw.match(/(?:^|\/\/)[^/]*duckduckgo\.com\/l\/\?(.*)$/i) || raw.match(/^\/l\/\?(.*)$/);
  if (!match) return raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const uddg = new URLSearchParams(match[1]).get('uddg');
    return uddg ? decodeURIComponent(uddg) : raw;
  } catch {
    return raw;
  }
}

// Rejects with an explanation once the deadline passes. The underlying promise is
// abandoned rather than cancelled, because Electron offers no way to cancel a
// pending capture; the timer is unrefed so a stray wait cannot hold the app open.
function fetchBodyText(buffer, contentType) {
  let text = buffer.toString('utf8');
  if (!/html/i.test(contentType)) return text;
  return text
    .replace(/<(?:script|style|noscript|svg|template)[\s\S]*?<\/(?:script|style|noscript|svg|template)>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
}

function withTimeout(promise, timeoutMs, message) {  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function waitForMainFrameCommit(webContents, requestedUrl, timeoutMs) {
  // Unit doubles that only model a resolved loadURL keep their synchronous
  // behavior; a real Electron WebContents supplies the navigation events.
  if (typeof webContents?.on !== 'function' || typeof webContents?.removeListener !== 'function') return new Promise(() => {});
  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      webContents.removeListener('did-start-navigation', onStart);
      webContents.removeListener('did-navigate', onCommit);
      webContents.removeListener('did-navigate-in-page', onInPage);
      webContents.removeListener('did-fail-load', onFail);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onStart = (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame === false || !matchesRequestedNavigation(url, requestedUrl)) return;
      started = true;
    };
    const onCommit = (_event, url, httpResponseCode, httpStatusText, isMainFrame) => {
      // Some BrowserView navigations deliver the commit but omit the matching
      // did-start-navigation notification (notably when a prior document is
      // still settling). A commit to the requested route is authoritative, but
      // an HTTP error page is not successful app evidence: surface it as a
      // recoverable navigation failure so the agent cannot inspect a 404 page
      // or wander into an unrelated checkout to explain the missing app.
      if (isMainFrame === false || (requestedHashNavigation(requestedUrl) && !matchesRequestedCompletion(url, requestedUrl)) || (!started && !matchesRequestedNavigation(url, requestedUrl))) return;
      const status = Number(httpResponseCode);
      if (Number.isFinite(status) && status >= 400) {
        const error = new Error(`Navigation returned HTTP ${status}${httpStatusText ? ` ${httpStatusText}` : ''} for ${url || requestedUrl}.`);
        error.code = 'NAVIGATION_HTTP_STATUS';
        finish(reject, error);
        return;
      }
      finish(resolve, { source: 'commit', url, ...(Number.isFinite(status) && status > 0 ? { status } : {}) });
    };
    const onInPage = (_event, url, isMainFrame) => {
      // Electron emits did-navigate-in-page rather than did-navigate for a
      // fragment-only route. Waiting only for a full-document commit turns any
      // real same-document state transition into the full navigation timeout.
      if (isMainFrame === false || !matchesRequestedCompletion(url, requestedUrl)) return;
      finish(resolve, { source: 'in-page', url });
    };
    const onFail = (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame === false || !started || Number(errorCode) === -3) return;
      finish(reject, new Error(`Navigation failed for ${validatedUrl || requestedUrl}: ${errorDescription || errorCode}`));
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timed out waiting for the main frame to commit ${requestedUrl}.`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    webContents.on('did-start-navigation', onStart);
    webContents.on('did-navigate', onCommit);
    webContents.on('did-navigate-in-page', onInPage);
    webContents.on('did-fail-load', onFail);
  });
}

function matchesRequestedNavigation(candidate, requested) {
  try {
    const actual = new URL(String(candidate || ''));
    const target = new URL(String(requested || ''));
    return actual.origin === target.origin && actual.pathname === target.pathname && actual.search === target.search;
  } catch {
    return String(candidate || '') === String(requested || '');
  }
}

function requestedHashNavigation(requested) {
  try { return Boolean(new URL(String(requested || '')).hash); } catch { return false; }
}

function matchesRequestedCompletion(candidate, requested) {
  if (!matchesRequestedNavigation(candidate, requested)) return false;
  if (!requestedHashNavigation(requested)) return true;
  try {
    return new URL(String(candidate || '')).hash === new URL(String(requested || '')).hash;
  } catch {
    return String(candidate || '') === String(requested || '');
  }
}

function normalizeButton(button) {
  if (!['left', 'middle', 'right'].includes(button)) throw new Error('Button must be left, middle, or right');
  return button;
}

// selectedId: the controller reads it so every tab listing marks which tab is
// the visible active one — without the flag the model must guess what a
// "switch" would change.
function summarizeTab(tab, selectedId = null) {
  return {
    id: tab.id,
    title: tab.title || 'New tab',
    url: tab.webContents.getURL() || 'about:blank',
    loading: tab.webContents.isLoading(),
    active: String(tab.id) === String(selectedId),
    canGoBack: tab.webContents.navigationHistory.canGoBack(),
    canGoForward: tab.webContents.navigationHistory.canGoForward()
  };
}

function clampInteger(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function buildFocusElementScript(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, reason: 'The observed form control is no longer present.' };
    const before = String(element.value ?? element.textContent ?? '');
    try { element.focus?.({ preventScroll: true }); } catch {}
    const focusable = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      && !element.disabled && !element.readOnly
      && !['file', 'hidden', 'password'].includes(String(element.type || '').toLowerCase());
    let selected = false;
    if (focusable) {
      try {
        if (typeof element.select === 'function') {
          element.select();
          selected = true;
        } else if (typeof element.setSelectionRange === 'function') {
          element.setSelectionRange(0, String(element.value ?? '').length);
          selected = true;
        }
      } catch {}
    }
    const focused = document.activeElement === element;
    return {
      ok: focused || focusable === false,
      native: focused && focusable,
      selected,
      autocomplete: element.getAttribute('role') === 'combobox' || element.getAttribute('aria-controls') !== null || element.getAttribute('aria-owns') !== null,
      value: before,
      valueLength: before.length,
      reason: focused || focusable === false ? undefined : 'The selected control could not receive native focus.'
    };
  })()`;
}

function buildPostInputSettleScript(selector, autocomplete) {
  return `(() => new Promise((resolve) => {
    const selector = ${JSON.stringify(selector)};
    const autocomplete = ${Boolean(autocomplete)};
    let frames = 0;
    const ready = () => {
      frames += 1;
      const element = document.querySelector(selector);
      const ids = String(element?.getAttribute('aria-controls') || element?.getAttribute('aria-owns') || '').split(/\\s+/).filter(Boolean);
      const roots = ids.map((id) => document.getElementById(id)).filter(Boolean);
      const options = (roots.length ? roots : [document]).flatMap((root) => [...root.querySelectorAll('[role="option"]')]);
      const visibleOption = options.some((option) => {
        const rect = option.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      });
      if (frames >= 2 && (!autocomplete || visibleOption || options.length === 0)) return resolve({ settled: true, frames, visibleOption });
      requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  }))()`;
}

function buildReadFilledValueScript(selector, expected, before) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, changed: false, matched: false, valueLength: 0, reason: 'The observed form control was replaced before verification.' };
    const value = String(element.value ?? element.textContent ?? '');
    const previous = ${JSON.stringify(String(before ?? ''))};
    const expectedValue = ${JSON.stringify(String(expected))};
    return { ok: value === expectedValue, changed: value !== previous, matched: value === expectedValue, valueLength: value.length, reason: value === expectedValue ? undefined : 'The control did not retain the requested value.' };
  })()`;
}

function buildFillElementScript(selector, text) {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const nextValue = ${JSON.stringify(text)};
    const element = document.querySelector(selector);
    if (!element) return { ok: false, reason: 'The observed form control is no longer present.' };
    const dispatch = (type, init) => {
      try { element.dispatchEvent(new InputEvent(type, { bubbles: true, ...init })); }
      catch { element.dispatchEvent(new Event(type, { bubbles: true })); }
    };
    const setControlValue = () => {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype
        : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : null;
      const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, nextValue);
      else element.value = nextValue;
    };
    try {
      element.focus?.({ preventScroll: true });
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const before = String(element.value ?? '');
        setControlValue();
        dispatch('input', { inputType: 'insertText', data: null });
        element.dispatchEvent(new Event('change', { bubbles: true }));
        const value = String(element.value ?? '');
        return { ok: value === nextValue, changed: value !== before, matched: value === nextValue, valueLength: value.length, reason: value === nextValue ? undefined : 'The control did not retain the requested value.' };
      }
      if (element.isContentEditable) {
        const before = String(element.textContent ?? '');
        element.textContent = nextValue;
        dispatch('input', { inputType: 'insertText', data: null });
        const value = String(element.textContent ?? '');
        return { ok: value === nextValue, changed: value !== before, matched: value === nextValue, valueLength: value.length, reason: value === nextValue ? undefined : 'The editable element did not retain the requested value.' };
      }
      return { ok: false, reason: 'The selected element is not a fillable form control.' };
    } catch (error) {
      return { ok: false, reason: String(error?.message || 'The selected control could not be filled.').slice(0, 500) };
    }
  })()`;
}

const elementCollectorScriptCache = new Map();

// Anchor-biased element selection for over-cap pages: keep the `cap` elements
// nearest the anchor (the agent's last working point), then restore DOM order
// so element indices stay stable for indexed actions. Pure + exported so the
// unit tests run the exact code the in-page collector inlines.
function selectElementsByAnchor(elements, cap, anchor) {
  if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || elements.length <= cap) return elements;
  const distance = (element) => ((element.center.x - anchor.x) ** 2 + (element.center.y - anchor.y) ** 2);
  return elements
    .slice()
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, cap)
    .sort((a, b) => a.index - b.index);
}

// FRAME OVERVIEW: answers "what is on this page" for pages whose content lives
// inside iframes. The element collector is document-scoped by construction, so
// without this a frame-based app reports as an empty shell and the agent has to
// reverse-engineer `frame.contentDocument` by hand — which is exactly what cost
// 10 probes and 6m55s on the TikTok inbox read.
//
// Two things make the report actionable rather than decorative:
//  - `offset` is the frame's content origin in TOP-document CSS pixels, so a
//    coordinate measured inside the frame can be clicked directly.
//  - `path` is the iframe index chain ([] → [0] → [0,2]), which is stable for a
//    page load and is how a caller re-enters the same frame later.
// Cross-origin frames are reported as `crossOrigin: true` with no text: the
// agent needs to know a frame is there and opaque, not to be told it is empty.
function buildFrameOverviewScript({ maxText = 2_000, perFrameText = 1_200, maxDepth = 3, maxFrames = 8 } = {}) {
  return `(() => {
    const clampText = (raw, limit) => String(raw || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, limit);
    const MAX_TEXT = ${JSON.stringify(maxText)};
    const PER_FRAME_TEXT = ${JSON.stringify(perFrameText)};
    const MAX_DEPTH = ${JSON.stringify(maxDepth)};
    const MAX_FRAMES = ${JSON.stringify(maxFrames)};
    const frames = [];
    const walk = (doc, path, depth, base) => {
      if (depth >= MAX_DEPTH || frames.length >= MAX_FRAMES) return;
      let list = [];
      try { list = Array.from(doc.querySelectorAll('iframe,frame')); } catch { return; }
      for (let i = 0; i < list.length; i += 1) {
        if (frames.length >= MAX_FRAMES) return;
        const el = list[i];
        const childPath = path.concat(i);
        let rect = null;
        try { rect = el.getBoundingClientRect(); } catch { rect = null; }
        // The content viewport starts inside the frame's border, not at the
        // border box edge; clientLeft/clientTop is that inset.
        const offset = rect
          ? { x: Math.round(base.x + rect.left + (Number(el.clientLeft) || 0)), y: Math.round(base.y + rect.top + (Number(el.clientTop) || 0)) }
          : null;
        let src = '';
        try { src = String(el.getAttribute('src') || ''); } catch { src = ''; }
        let childDoc = null;
        try { childDoc = el.contentDocument; } catch { childDoc = null; }
        const size = rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null;
        if (!childDoc) {
          frames.push({ path: childPath, src: src.slice(0, 200), crossOrigin: true, offset, size, text: '' });
          continue;
        }
        let text = '';
        try { text = clampText(childDoc.body ? childDoc.body.innerText : '', PER_FRAME_TEXT); } catch { text = ''; }
        let viewport = null;
        try { viewport = { w: childDoc.documentElement.clientWidth, h: childDoc.documentElement.clientHeight }; } catch { viewport = null; }
        frames.push({ path: childPath, src: src.slice(0, 200), crossOrigin: false, offset, size, viewport, text });
        if (offset) { try { walk(childDoc, childPath, depth + 1, offset); } catch { /* one bad frame never fails the report */ } }
      }
    };
    walk(document, [], 0, { x: 0, y: 0 });
    return { text: clampText(document.body ? document.body.innerText : '', MAX_TEXT), frames };
  })()`;
}

function buildElementCollectorScript({ interactiveOnly, includeText, maxElements, selector, text, anchor, framePath }) {
  const frame = Array.isArray(framePath) && framePath.length ? framePath.map(Number) : null;
  const key = JSON.stringify([Boolean(interactiveOnly), Boolean(includeText), Number(maxElements), selector || null, text || null, anchor || null, frame]);
  const cached = elementCollectorScriptCache.get(key);
  if (cached) return cached;
  const script = `(() => {
    // FRAME SCOPE — an iframe is a separate JavaScript realm, so a collector that
    // hard-codes the top \`document\` cannot see inside it, and one that keeps the
    // top realm's constructors silently fails every \`instanceof HTMLElement\`
    // check on frame nodes. Both are rebound here to the frame reached through
    // the reported path. Rects stay frame-local; the caller adds \`frameOffset\`
    // so every coordinate it returns is in top-document CSS pixels and therefore
    // directly clickable.
    const __topUrl = location.href;
    const __topTitle = document.title;
    const __topReady = document.readyState;
    const __framePath = ${JSON.stringify(frame)};
    let __doc = document;
    let __win = window;
    let __frameOffset = { x: 0, y: 0 };
    if (__framePath) {
      for (const __index of __framePath) {
        let __el = null;
        try { __el = __doc.querySelectorAll('iframe,frame')[__index] || null; } catch { __el = null; }
        let __child = null;
        try { __child = __el ? __el.contentDocument : null; } catch { __child = null; }
        if (!__child) break;
        try {
          const __rect = __el.getBoundingClientRect();
          __frameOffset = { x: __frameOffset.x + __rect.left + (Number(__el.clientLeft) || 0), y: __frameOffset.y + __rect.top + (Number(__el.clientTop) || 0) };
        } catch { /* geometry is advisory; never abort the read */ }
        __doc = __child;
        __win = __el.contentWindow || __child.defaultView || __win;
      }
    }
    // The collector body below is unchanged: it receives the frame's realm as
    // PARAMETERS. Parameters shadow the globals cleanly, whereas a const
    // declaration of document/window would put every earlier read in the
    // temporal dead zone — which is exactly how the first version of this failed.
    const __run = (document, window, location, getComputedStyle, Node, HTMLElement, HTMLAnchorElement, CSS) => {
    // Arm the click probe at OBSERVATION time: the hit test also installs it,
    // but that runs AFTER a click, so the first click of a run would have no
    // delivery evidence. Same shape as the hit-test probe (window.__bdsClickProbe).
    try {
      if (!window.__bdsClickProbe) {
        const probe = { clicks: [], lastDown: null, lastUp: null };
        const point = (event) => ({ x: Math.round(event.clientX), y: Math.round(event.clientY) });
        const target = (event) => ({ tag: event.target?.tagName ? String(event.target.tagName).toLowerCase() : null, id: event.target?.id || null, cls: String(event.target?.className || '').slice(0, 60) });
        document.addEventListener('click', (event) => {
          probe.clicks.push({ ...point(event), ...target(event), at: Date.now() });
          if (probe.clicks.length > 20) probe.clicks.shift();
        }, true);
        document.addEventListener('mousedown', (event) => { probe.lastDown = { ...point(event), ...target(event), at: Date.now() }; }, true);
        document.addEventListener('mouseup', (event) => { probe.lastUp = { ...point(event), ...target(event), at: Date.now() }; }, true);
        window.__bdsClickProbe = probe;
      }
    } catch { /* probing is best-effort */ }
    const cap = ${JSON.stringify(maxElements)};
    const anchor = ${JSON.stringify(anchor || null)};
    const filterSelector = ${JSON.stringify(selector)};
    const filterText = ${JSON.stringify(text)};
    const includeText = ${JSON.stringify(includeText)};
    const interactiveOnly = ${JSON.stringify(interactiveOnly)};
    const INTERACTIVE_SELECTOR = 'a[href],button,input,select,textarea,[onclick],[contenteditable=""],[contenteditable="true"],[data-tool],[data-add-type],[data-testid],[data-test-id],[data-node-id],[data-transform-target-id],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="option"],[role="switch"],[tabindex]:not([tabindex="-1"])';
    const INTERACTION_REGION_SELECTOR = 'main,[role="main"],canvas,svg,[role="application"],[contenteditable=""],[contenteditable="true"],[data-testid],[data-test-id],[class*="board"],[id*="board"],[class*="game"],[id*="game"],[class*="canvas"],[id*="canvas"],[class*="surface"],[id*="surface"]';
    // Visual targets are non-semantic objects (pieces, tokens, sprites) that
    // must remain visible to an agent even when they are not clickable DOM
    // controls. This is deliberately generic: no chess/game rules are encoded.
    const VISUAL_TARGET_SELECTOR = '[class*="piece"],[class*="square-"],[data-piece],[data-square],[data-token],[data-sprite]';
    const TEXT_MATCH_LIMIT = 2000;
    const viewport = { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY };
    const hidden = (element, style, rect) => {
      if (rect.width <= 0 || rect.height <= 0) return true;
      // Stateful interfaces often hide an entire panel with opacity,
      // aria-hidden, inert, or display on an ancestor while descendants retain
      // their own default geometry. Hidden descendants are never evidence.
      try {
        if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
      } catch {}
      for (let current = element; current && current instanceof HTMLElement; current = current.parentElement) {
        const currentStyle = current === element ? style : getComputedStyle(current);
        if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return true;
        if (currentStyle.display === 'none' || currentStyle.visibility === 'hidden' || currentStyle.visibility === 'collapse' || currentStyle.contentVisibility === 'hidden' || Number(currentStyle.opacity || 1) === 0) return true;
      }
      return false;
    };
    const interactive = (element) => {
      if (element.matches('a[href],button,input,select,textarea,[onclick],[contenteditable=""],[contenteditable="true"]')) return true;
      const role = String(element.getAttribute('role') || '').toLowerCase();
      if (['button','link','tab','menuitem','checkbox','radio','option','switch'].includes(role)) return true;
      const tabindex = element.getAttribute('tabindex');
      if (tabindex && tabindex !== '-1') return true;
      if (element.hasAttribute('data-tool') || element.hasAttribute('data-add-type') || element.hasAttribute('data-node-id') || element.hasAttribute('data-transform-target-id') || element.hasAttribute('data-testid') || element.hasAttribute('data-test-id')) return true;
      return false;
    };
    const textMatches = (value) => {
      if (!filterText) return true;
      return String(value || '').toLowerCase().includes(filterText);
    };
    const cheapMatches = (element) => {
      if (!filterText) return true;
      return [
        element.id,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('alt'),
        element.getAttribute('placeholder'),
        element.getAttribute('data-tool'),
        element.getAttribute('data-add-type'),
        element.getAttribute('data-testid'),
        element.getAttribute('data-test-id'),
        element.getAttribute('role')
      ].some(textMatches);
    };
    const label = (element) => {
      // LORDE_S_ESCAPE_V309 — inside this template literal every regex class
      // escape MUST be doubled (\\s), otherwise the generated page script runs
      // /s+/g and strips the letter "s" from every element name and text.
      const textContent = includeText ? String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '';
      const labelledBy = String(element.getAttribute('aria-labelledby') || '')
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ');
      const formLabels = 'labels' in element && element.labels
        ? Array.from(element.labels)
          .map((node) => String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' ')
        : '';
      return {
        // Native inputs frequently carry their only accessible name in a
        // <label for=...>. Preserve that public label so the agent can prove
        // form state without extracting a typed value or guessing from layout.
        name: [element.getAttribute('aria-label'), labelledBy, formLabels, element.getAttribute('title'), element.getAttribute('alt'), element.getAttribute('placeholder'), textContent].find((value) => String(value || '').trim()) || '',
        text: textContent
      };
    };
    const safeHref = (element) => {
      if (!(element instanceof HTMLAnchorElement)) return '';
      try {
        const url = new URL(element.href, location.href);
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        // Keep only a public route identity. Link queries can contain one-time
        // tokens, which are never needed in agent context or action history.
        url.username = '';
        url.password = '';
        url.search = '';
        return url.toString();
      } catch {
        return '';
      }
    };
    const cssPath = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let part = current.localName;
        if (!part) break;
        const testId = current.getAttribute('data-testid') || current.getAttribute('data-test-id');
        if (testId) {
          part += '[data-testid="' + String(testId).replace(/"/g, '\\"') + '"]';
          parts.unshift(part);
          break;
        }
        const dataTool = current.getAttribute('data-tool') || current.getAttribute('data-add-type');
        if (dataTool) {
          part += '[data-tool="' + String(dataTool).replace(/"/g, '\\"') + '"]';
          parts.unshift(part);
          break;
        }
        let index = 1;
        let sibling = current;
        while ((sibling = sibling.previousElementSibling)) if (sibling.localName === current.localName) index += 1;
        part += ':nth-of-type(' + index + ')';
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };
    const scope = filterSelector
      ? Array.from(document.querySelectorAll(filterSelector))
      : Array.from(document.querySelectorAll(interactiveOnly ? INTERACTIVE_SELECTOR : '*'));
    const seen = new Set();
    const elements = [];
    for (const element of scope) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      if (interactiveOnly && !interactive(element)) continue;
      // A cheap ATTRIBUTE miss is not a TEXT miss. Rejecting here meant the text
      // filter only ever matched elements whose text also appeared in an
      // attribute, so content search returned nothing on ordinary pages —
      // measured on the TikTok inbox, where { text: 'Cottiny' } returned 0 rows
      // that plainly contain it. The full check below still decides.
      if (filterText && !cheapMatches(element) && !String(element.textContent || '').toLowerCase().includes(filterText)) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (hidden(element, style, rect)) continue;
      if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) continue;
      const info = label(element);
      const searchable = [
        info.name,
        info.text,
        element.id || '',
        element.getAttribute('data-tool') || '',
        element.getAttribute('data-add-type') || ''
      ].join(' ').toLowerCase();
      if (filterText && !searchable.includes(filterText)) continue;
      if (elements.length >= TEXT_MATCH_LIMIT && filterText) break;
      elements.push({
        index: elements.length,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        name: info.name,
        text: info.text,
        href: safeHref(element),
        id: element.id || '',
        testId: element.getAttribute('data-testid') || element.getAttribute('data-test-id') || '',
        dataTool: element.getAttribute('data-tool') || element.getAttribute('data-add-type') || '',
        selector: cssPath(element),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
        visible: true,
        enabled: !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true',
        pressed: element.hasAttribute('aria-pressed') ? element.getAttribute('aria-pressed') === 'true' : null,
        selected: element.hasAttribute('aria-selected') ? element.getAttribute('aria-selected') === 'true' : null,
        expanded: element.hasAttribute('aria-expanded') ? element.getAttribute('aria-expanded') === 'true' : null,
        checked: typeof element.checked === 'boolean' ? element.checked : null,
        value: 'value' in element ? String(element.value || '').slice(0, 120) : ''
      });
      if (elements.length >= cap && !anchor) break;
      // Anchor mode collects a bounded superset first (cap x 6, still cheap),
      // then keeps the cap elements nearest the anchor below — DOM order and
      // original indices are preserved for the survivors.
      if (elements.length >= cap * 6) break;
    }
    // Anchor-biased selection: over-cap pages keep the elements nearest the
    // agent's working point. Original indices survive so clickElement and the
    // element snapshots stay deterministic; under-cap pages are untouched.
    // The helper is inlined from the module below so tests exercise the SAME
    // code the page runs.
    const finalElements = (${selectElementsByAnchor.toString()})(elements, cap, anchor);
    // CUSTOM ELEMENTS are how canvas/board interfaces expose their visual
    // objects: a <piece> sprite, a <tile> card, a <marker> token. The tag
    // carries the object kind, the class names the instance ("black queen"),
    // and the rect gives the position. No mainstream layout framework uses
    // dashed tag names, so collecting them inside interaction regions is
    // generic - and it is the only way an agent can READ a canvas board's
    // state instead of re-deriving it from pixels every decision (the live
    // chess run clicked one square repeatedly because it never saw the
    // pieces).
    const regionElements = Array.from(document.querySelectorAll(INTERACTION_REGION_SELECTOR));
    const customElements = [];
    for (const region of regionElements) {
      for (const candidate of region.querySelectorAll('*')) {
        if (candidate.tagName && candidate.tagName.includes('-')) {
          customElements.push(candidate);
          if (customElements.length >= 256) break;
        }
      }
      if (customElements.length >= 256) break;
    }
    // POSITIONED VISUAL OBJECTS: a plain <div> with position:absolute/fixed and
    // a real box is how most pages (and every game) draw their draggable
    // objects — no role, no tabindex, no label. Without this rule the agent
    // cannot even SEE such an object in the snapshot and is forced to guess
    // from pixels (the drag-relay failure). Generic: geometry, not vocabulary.
    const positionedVisuals = [];
    try {
      const seen = new Set();
      for (const region of regionElements) {
        for (const candidate of region.querySelectorAll('div,span,img,svg,li,button')) {
          if (seen.has(candidate)) continue;
          seen.add(candidate);
          if (positionedVisuals.length >= 128) break;
          const style = getComputedStyle(candidate);
          if (style.position !== 'absolute' && style.position !== 'fixed') continue;
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const box = candidate.getBoundingClientRect();
          if (box.width < 40 || box.height < 40) continue;
          if (box.right < 0 || box.bottom < 0 || box.left > window.innerWidth || box.top > window.innerHeight) continue;
          positionedVisuals.push(candidate);
        }
        if (positionedVisuals.length >= 128) break;
      }
    } catch { /* best effort */ }
    const visualTargetElements = Array.from(new Set([...document.querySelectorAll(VISUAL_TARGET_SELECTOR), ...customElements, ...positionedVisuals]));
    const visualTargets = visualTargetElements
      .slice(0, 256)
      .map((element) => {
        if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (hidden(element, style, rect) || rect.width * rect.height < 100) return null;
        if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return null;
        const classes = typeof element.className === 'string' ? element.className : element.getAttribute('class') || '';
        // A SHORT ancestor class chain: state and orientation markers live on
        // ancestors (a flipped board, a selected row, an active panel), and
        // without them the agent cannot interpret the object's position.
        const ancestors = [];
        for (let parent = element.parentElement, depth = 0; parent && depth < 3; parent = parent.parentElement, depth += 1) {
          const parentClasses = typeof parent.className === 'string' ? parent.className : '';
          if (parentClasses) ancestors.push(parentClasses.slice(0, 80));
        }
        return {
          tag: element.tagName.toLowerCase(),
          classes: String(classes).slice(0, 160),
          ...(ancestors.length ? { ancestors } : {}),
          role: element.getAttribute('role') || '',
          label: String(element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('data-piece') || element.getAttribute('data-square') || '').slice(0, 120),
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
          center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        };
      })
      .filter(Boolean)
      .slice(0, 96);
    const regions = regionElements
      .map((element) => {
        if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (hidden(element, style, rect)) return null;
        if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return null;
        if (rect.width * rect.height < 1_200) return null;
        const labelledBy = String(element.getAttribute('aria-labelledby') || '')
          .split(/\\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' ');
        const publicName = [
          element.getAttribute('aria-label'), labelledBy, element.getAttribute('title'),
          element.getAttribute('data-testid'), element.getAttribute('data-test-id'),
          element.getAttribute('role'), element.tagName.toLowerCase()
        ].find((value) => String(value || '').trim()) || 'interaction region';
        return {
          kind: element.tagName.toLowerCase(),
          name: String(publicName).replace(/\\s+/g, ' ').trim().slice(0, 120),
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
          center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
          childCount: Math.min(element.childElementCount || 0, 10_000),
          descendantCount: Math.min(element.querySelectorAll('*').length, 10_000)
        };
      })
      .filter(Boolean)
      .sort((left, right) => (right.rect.w * right.rect.h) - (left.rect.w * left.rect.h))
      .slice(0, 16);
    const landmarks = Array.from(document.querySelectorAll('main h1, main h2, main h3, main form, main [role="status"], main [aria-live]'))
      // Multi-state pages often keep several panels in one DOM tree and toggle
      // them with CSS. Hidden headings and forms are not browser evidence.
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return !hidden(element, style, rect) && rect.right >= 0 && rect.bottom >= 0 && rect.left <= window.innerWidth && rect.top <= window.innerHeight;
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        label: element.getAttribute('aria-label') || '',
        text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240)
      }))
      .filter((landmark) => landmark.text || landmark.label)
      .slice(0, 20);
    return {
      url: __topUrl,
      title: __topTitle,
      readyState: __topReady,
      viewport,
      // Top-document pixel offset of the frame that was read, so the caller can
      // lift frame-local rects into clickable page coordinates.
      frameOffset: __frameOffset,
      elements: finalElements,
      visualTargets,
      regions,
      landmarks,
      truncated: finalElements.length >= cap
    };
    };
    return __run(__doc, __win, __win.location, __win.getComputedStyle.bind(__win), __win.Node, __win.HTMLElement, __win.HTMLAnchorElement, __win.CSS);
  })();`;
  elementCollectorScriptCache.set(key, script);
  if (elementCollectorScriptCache.size > 32) elementCollectorScriptCache.delete(elementCollectorScriptCache.keys().next().value);
  return script;
}

module.exports = { BrowserViewController, summarizeTab, ANONYMOUS_INPUT_OWNER, decodeDuckDuckGoHref, selectElementsByAnchor, assertCoordinates };

