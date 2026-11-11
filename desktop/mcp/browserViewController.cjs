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
// When a search engine interstitials a human-verification challenge, the
// search call waits this long for a human to clear it in the visible window
// (the agent surfaces a notice), then resumes automatically. The user's own
// hand must complete the challenge — the app never fills or bypasses it.
const CAPTCHA_HUMAN_WAIT_MS = 90_000;
const CAPTCHA_POLL_INTERVAL_MS = 3_000;

class BrowserViewController {
  constructor({ getTabs, getSelectedTabId, getConsoleEntries, normalizeUrl, createTab = null, closeTab = null, isTabPaintable = null, ensureTabPaintable = null, deviceEmulator = null, debuggerLeaseManager = null, pointerVisualizer = null, onDeviceModeChanged = null }) {
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
    // Present when device emulation is available. Under a mobile or tablet
    // profile the pointer is not an input device at all, so the mouse tools
    // refuse rather than silently sending events the page cannot receive.
    this.deviceEmulator = deviceEmulator;
    this.onDeviceModeChanged = typeof onDeviceModeChanged === 'function' ? onDeviceModeChanged : null;
    this.debuggerLeaseManager = debuggerLeaseManager;
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
        'Timed out capturing the background tab. Continue with DOM observation or select the tab manually.'
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
    return payload;
  }

  async queryElements(tabId, options = {}) {
    const tab = this.requireTab(tabId);
    const payload = await this.readElements(tab, options);
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
      includeText: true
    })).elements;
    if (!resolved) {
      // Dynamic pages frequently rebuild hashed/nth-child DOM between observation
      // and action. Refresh once and rematch by stable identity before declaring
      // the model's index stale; never fall back to the same numeric index.
      const fresh = await this.readElements(tab, { maxElements: 250, interactiveOnly: true, includeText: true });
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
      const center = element.center;
      // Clicking by index stays meaningful under a device profile; only the
      // delivery changes, so the same call taps instead of pressing a button.
      if (this.deviceEmulator?.isTouchMode(tabId)) {
        await this.deviceEmulator.performGesture(tabId, 'tap', { x: center.x, y: center.y });
        return { tabId, index, input: 'touch', gesture: 'tap', element };
      }
      const click = await this.clickAt(tabId, { ...center, button }, sessionId, operation);
      return { tabId, index, input: click.input, button: normalizeButton(button), element, ...(click.pointer ? { pointer: safePointerProjection(click.pointer) } : {}) };
    } finally {
      this.finishInputOperation(operation);
    }
  }

  async clickAt(tabId, { x, y, button = 'left' } = {}, sessionId, inputOperation = null) {
    const ownsOperation = !inputOperation;
    const operation = inputOperation || this.inputOperationToken(sessionId, tabId);
    try {
      const prepared = this.prepareNativeInput(tabId);
      const normalizedButton = normalizeButton(button);
      const background = this.getSelectedTabId() !== tabId || prepared.forceBackground;
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
        return { tabId, x, y, input: 'cdp-background', button: normalizedButton, pointer: { mode: 'cdp-native-input', x, y, pageMutation: false }, batched: true, hit };
      }
      const moved = await this.mouseMove(tabId, { x, y }, { operation });
      if (!this.inputOperationCurrent(operation) || inputDeliveryFailed(moved)) return { tabId, x, y, input: 'interrupted', button: normalizeButton(button), pointer: safePointerProjection(moved.pointer) };
      const pressed = await this.mouseDown(tabId, { x, y, button }, sessionId, operation);
      if (inputDeliveryFailed(pressed)) return { tabId, x, y, input: 'interrupted', button: normalizeButton(button), pointer: safePointerProjection(pressed.pointer) };
      const released = await this.mouseUp(tabId, { x, y, button }, sessionId, operation);
      // Once mouse-down commits, mouse-up is always delivered as an edge event.
      // A newer visual target may change where the tip ends, but the real click is
      // complete and must never be reported as retryable interruption.
      const hit = await this.hitTest(tabId, { x, y });
      return { tabId, x, y, input: 'mouse', button: normalizeButton(button), pointer: committedClickPointer({ moved, pressed, released }), hit };
    } finally {
      if (ownsOperation) this.finishInputOperation(operation);
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

  mouseMove(tabId, { x, y }, { waitForPointer = true, pointerDurationMs, operation = null, sessionId } = {}) {
    assertCoordinates(x, y);
    this.assertPointerAllowed(tabId, 'browser_mousemove');
    const ownsOperation = !operation;
    const activeOperation = operation || this.inputOperationToken(sessionId, tabId);
    return this.runInputOperation(activeOperation, ownsOperation, () => {
      if (!this.inputOperationCurrent(activeOperation)) {
        return { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
      }
      const prepared = this.prepareNativeInput(tabId);
      const visualRequired = Boolean(this.pointerVisualizer) && this.getSelectedTabId() === tabId && this.isTabPaintable?.(tabId) !== false;
      const visual = this.pointerVisualizer?.move?.(tabId, { x, y }, {
        waitForArrival: waitForPointer,
        operationId: activeOperation.pointerAction,
        ...(Number.isFinite(pointerDurationMs) ? { durationMs: pointerDurationMs } : {})
      });
      return afterMaybePromise(visual, (visualResult) => {
        // A newer movement owns both the visual pointer and the final native
        // mouseMoved event. An interrupted older target must never reappear later.
        if (!this.inputOperationCurrent(activeOperation)) return { tabId, input: 'interrupted', pointer: visualResult };
        if (pointerCannotProceed(visualResult, {
          required: visualRequired,
          waitForArrival: waitForPointer
        })) {
          // The cursor visual is decoration: deliver the hover position even
          // when its acknowledgement is lost.
          this.lastPointer.set(tabId, { x, y });
          const outcome = this.dispatchInput(tabId, prepared.tab.webContents, { type: 'mouseMoved', x, y }, 'mouse', prepared.forceBackground);
          return addPointerOutcome(outcome, { ...safePointerProjection(visualResult), deliveryFallback: true });
        }
        this.lastPointer.set(tabId, { x, y });
        const outcome = this.dispatchInput(tabId, prepared.tab.webContents, { type: 'mouseMoved', x, y }, 'mouse', prepared.forceBackground);
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
    const continueAfterRelease = (release, requireCommittedCleanup = false) => this.runInputOperation(operation, ownsOperation, () => (
      Promise.resolve(release).then((released) => {
        if (!this.inputOperationCurrent(operation) || (requireCommittedCleanup && released !== true)) {
          return { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'prior-button-release-unavailable' } };
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
      return continueAfterRelease(priorCleanup, true);
    }
    const prepared = this.prepareNativeInput(tabId);
    return this.runInputOperation(operation, ownsOperation, () => {
      if (!this.inputOperationCurrent(operation)) return { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
      const visualRequired = Boolean(this.pointerVisualizer) && this.getSelectedTabId() === tabId && this.isTabPaintable?.(tabId) !== false;
      const visual = this.pointerVisualizer?.move?.(tabId, { x, y }, { waitForArrival: true, operationId: operation.pointerAction });
      return afterMaybePromise(visual, (visualResult) => {
        if (!this.inputOperationCurrent(operation)) {
          return { tabId, input: 'interrupted', pointer: visualResult };
        }
        if (pointerCannotProceed(visualResult, { required: visualRequired, waitForArrival: true })) {
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
          this.trackHeld(sessionId, tabId, 'buttons', normalizedButton, {
            route: this.getSelectedTabId() === tabId && !prepared.forceBackground ? 'electron' : 'cdp'
          });
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
        : this.pointerVisualizer?.move?.(tabId, { x, y }, { waitForArrival: true, operationId: operation.pointerAction });
      return afterMaybePromise(visual, (visualResult) => {
        const deliverRelease = () => {
          // Releases are edge events and must never be dropped. If their requested
          // movement was superseded, release at the newest committed native point
          // instead of moving back to the stale coordinate.
          const releasePoint = pointerCannotProceed(visualResult, {
            required: visualRequired,
            waitForArrival: true
          }) ? (this.lastPointer.get(tabId) || { x, y }) : { x, y };
          this.lastPointer.set(tabId, releasePoint);
          // Native release is the safety edge. Only forget the held state after
          // dispatch succeeds; click feedback is best-effort and cannot block it.
          const dispatched = this.dispatchInput(tabId, prepared.tab.webContents, { type: 'mouseReleased', ...releasePoint, button: normalizedButton, buttons: 0, clickCount: 1 }, 'mouse', prepared.forceBackground);
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
    if (this.getSelectedTabId() === tabId && !forceBackground) {
      if (kind === 'text') {
        webContents.insertText(event.text);
        return { tabId, input: 'electron-native' };
      }
      const nativeEvent = kind === 'mouse' ? cdpMouseToElectronEvent(event) : kind === 'key' ? cdpKeyToElectronEvent(event) : null;
      if (nativeEvent) {
        webContents.sendInputEvent(nativeEvent);
        return { tabId, input: 'electron-native' };
      }
    }
    // CDP dispatch addresses this particular WebContents even while another
    // BrowserView remains focused. This keeps explicit background-tab control
    // from stealing focus or failing because the target is not selected.
    const dispatch = kind === 'mouse' ? this.dispatchCdp(tabId, 'background mouse input', 'Input.dispatchMouseEvent', event)
      : kind === 'key' ? this.dispatchCdp(tabId, 'background key input', 'Input.dispatchKeyEvent', event)
        : this.dispatchCdp(tabId, 'background text input', 'Input.insertText', { text: event.text });
    return dispatch.then(() => ({ tabId, input: 'cdp-background' }));
  }

  dispatchCdp(tabId, purpose, method, params) {
    if (this.debuggerLeaseManager) return this.debuggerLeaseManager.send(tabId, purpose, method, params);
    const webContents = this.requireTab(tabId).webContents;
    return withDebugger(webContents, purpose, (debuggerClient) => debuggerClient.sendCommand(method, params));
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

  async drag(tabId, { startX, startY, endX, endY, steps = 10, durationMs = 300 } = {}, sessionId) {
    assertCoordinates(startX, startY);
    assertCoordinates(endX, endY);
    this.assertPointerAllowed(tabId, 'browser_drag');

    // Keep the drag bounded so it cannot outlive the MCP request deadline or hold
    // the process open indefinitely.
    const MAX_DRAG_DURATION_MS = 5_000;
    const clampedDurationMs = Math.max(5, Math.min(durationMs, MAX_DRAG_DURATION_MS));
    const requestedStepCount = Math.max(1, Math.min(steps, 100));
    const continuousStepCount = Math.ceil(clampedDurationMs / POINTER_DRAG_SEGMENT_MAX_MS);
    const stepCount = Math.min(100, Math.max(requestedStepCount, continuousStepCount));
    const delay = Math.max(5, Math.floor(clampedDurationMs / stepCount));

    const operation = this.inputOperationToken(sessionId, tabId);
    try {
      const initialMove = await this.mouseMove(tabId, { x: startX, y: startY }, { operation });
      if (inputWasInterrupted(initialMove)) return { tabId, startX, startY, endX, endY, input: 'interrupted', pointer: initialMove.pointer };
      const down = await this.mouseDown(tabId, { x: startX, y: startY, button: 'left' }, sessionId, operation);
      if (inputWasInterrupted(down)) return { tabId, startX, startY, endX, endY, input: 'interrupted', pointer: down.pointer };
      let pressed = true;
      let interrupted = null;

      try {
        for (let i = 1; i <= stepCount; i++) {
          if (!this.inputOperationCurrent(operation)) {
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
            operation
          });
          if (inputWasInterrupted(movement)) {
            interrupted = movement;
            break;
          }
          const remainingDelay = delay - (Date.now() - stepStartedAt);
          if (remainingDelay > 0 && !(await this.waitForInputOperationDelay(remainingDelay, operation))) {
            interrupted = { tabId, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
            break;
          }
        }
      } finally {
        if (pressed) {
          if (this.isHeld(sessionId, tabId, 'buttons', 'left')) {
            const releaseOperation = interrupted ? { ...operation, global: -1 } : operation;
            await this.mouseUp(tabId, { x: endX, y: endY, button: 'left' }, sessionId, releaseOperation);
          }
          pressed = false;
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
      const before = await this.scrollEvidence(tab);
      if (!this.inputOperationCurrent(operation)) return { tabId, deltaX, deltaY, input: 'interrupted', pointer: { interrupted: true, reason: 'input-operation-cancelled' } };
      const origin = this.wheelOrigin(tabId, before, { x, y });
      const visualRequired = Boolean(this.pointerVisualizer) && this.getSelectedTabId() === tabId && this.isTabPaintable?.(tabId) !== false;
      const pointer = await this.pointerVisualizer?.move?.(tabId, origin, { waitForArrival: true, operationId: operation.pointerAction });
      if (!this.inputOperationCurrent(operation)) return { tabId, deltaX, deltaY, input: 'interrupted', origin, pointer };
      if (pointerCannotProceed(pointer, {
        required: visualRequired,
        waitForArrival: true
      })) {
        // The wheel must scroll even when the cursor visual cannot proceed.
        await this.dispatchCdp(tabId, 'background wheel input', 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...origin, deltaX, deltaY });
        return { tabId, deltaX, deltaY, origin, pointer: { ...safePointerProjection(pointer), deliveryFallback: true } };
      }
      this.lastPointer.set(tabId, origin);
      this.pointerVisualizer?.activity?.(tabId, origin, { operationId: operation.pointerAction });
      await this.dispatchCdp(tabId, 'background wheel input', 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...origin, deltaX, deltaY });
      // Give Chromium one event-loop turn to apply the default wheel action before
      // reporting whether this native event actually moved the document.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const after = await this.scrollEvidence(tab);
      return {
        tabId,
        deltaX,
        deltaY,
        input: 'mouse',
        origin,
        before: { scrollX: before.scrollX, scrollY: before.scrollY },
        after: { scrollX: after.scrollX, scrollY: after.scrollY },
        moved: before.scrollX !== after.scrollX || before.scrollY !== after.scrollY,
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
    const events = action === 'press'
      ? [{ type: 'keyDown', key }, { type: 'keyUp', key }]
      : [{ type: action === 'down' ? 'keyDown' : 'keyUp', key }];
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
      trySendInputEvent(webContents, { type: 'keyUp', keyCode: key });
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
    const useCdp = forceCdp
      || originalRoute === 'cdp'
      || this.getSelectedTabId() !== tabId
      || selectedSurfaceUnavailable;
    if (useCdp) {
      return this.dispatchCdp(tabId, 'cleanup mouse release', 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: 0, y: 0, button, buttons: 0, clickCount: 1
      });
    }
    return trySendInputEvent(webContents, { type: 'mouseUp', x: 0, y: 0, button, clickCount: 1 });
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
    const payload = await this.evaluatePage(tab, 'DOM snapshot', buildElementCollectorScript({ interactiveOnly, includeText, maxElements, selector, text, anchor }), 8_000,
      'Timed out reading the bound tab structure. If the Browser-use window is still starting up, wait a moment and retry.');
    const result = { tabId: tab.id, ...payload };
    if (result.viewport?.width > 0 && result.viewport?.height > 0) this.lastViewport.set(tab.id, result.viewport);
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

  // Post-input hit test: what element actually sits at the clicked CSS point.
  // Canvas surfaces report the canvas itself, which is the correct proof that
  // the coordinate reached page content rather than an off-board overlay.
  async hitTest(tabId, { x, y }) {
    try {
      const tab = this.requireTab(tabId);
      const hit = await withTimeout(
        this.evaluatePage(tab, 'post-input hit test', `(() => {
          const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
          if (!el) return { hit: false, tag: null };
          const rect = el.getBoundingClientRect();
          return {
            hit: true,
            tag: el.tagName ? el.tagName.toLowerCase() : null,
            id: el.id || null,
            classes: typeof el.className === 'string' ? el.className.slice(0, 120) : null,
            role: el.getAttribute?.('role') || null,
            isCanvas: el.tagName === 'CANVAS',
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        })()`,
          3_000, 'Timed out hit-testing the clicked point.'
        )
      );
      return hit;
    } catch (error) {
      // The blanket sentinel hid WHY the post-input read failed (3s timeout
      // under load, a dead tab, a page-eval error), so neither the model nor
      // the operator could tell a slow page from a broken one — the model just
      // re-screenshotted to compensate. Surface the real reason; the sentinel
      // shape stays for compatibility.
      return { hit: null, reason: 'hit-test-unavailable', error: String(error?.message || error).slice(0, 200) };
    }
  }

  async evaluatePage(tab, purpose, expression, timeoutMs, timeoutMessage) {
    const evaluate = async () => {
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
        } catch {
          // A DevTools attachment or a transient CDP handoff issue must not
          // turn a healthy bound page into an agent dead end. Fall back to the
          // older isolated page evaluator; the bounded caller still owns the
          // timeout and error surface.
        }
      }
      return tab.webContents.executeJavaScript(String(expression), true);
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

function cdpKeyToElectronEvent(event) {
  const bitmask = Number(event.modifiers) || 0;
  const modifiers = [];
  if (bitmask & 2) modifiers.push('control');
  if (bitmask & 4) modifiers.push('meta');
  if (bitmask & 8) modifiers.push('alt');
  if (bitmask & 1) modifiers.push('shift');
  return {
    type: event.type,
    keyCode: event.code === 'KeyA' ? 'A' : event.key,
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

function buildElementCollectorScript({ interactiveOnly, includeText, maxElements, selector, text, anchor }) {
  const key = JSON.stringify([Boolean(interactiveOnly), Boolean(includeText), Number(maxElements), selector || null, text || null, anchor || null]);
  const cached = elementCollectorScriptCache.get(key);
  if (cached) return cached;
  const script = `(() => {
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
      if (!cheapMatches(element)) continue;
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
    const visualTargets = Array.from(document.querySelectorAll(VISUAL_TARGET_SELECTOR))
      .slice(0, 256)
      .map((element) => {
        if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (hidden(element, style, rect) || rect.width * rect.height < 100) return null;
        if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return null;
        const classes = typeof element.className === 'string' ? element.className : element.getAttribute('class') || '';
        return {
          tag: element.tagName.toLowerCase(),
          classes: String(classes).slice(0, 160),
          role: element.getAttribute('role') || '',
          label: String(element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('data-piece') || element.getAttribute('data-square') || '').slice(0, 120),
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
          center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        };
      })
      .filter(Boolean)
      .slice(0, 96);
    const regions = Array.from(document.querySelectorAll(INTERACTION_REGION_SELECTOR))
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
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport,
      elements: finalElements,
      visualTargets,
      regions,
      landmarks,
      truncated: finalElements.length >= cap
    };
  })();`;
  elementCollectorScriptCache.set(key, script);
  if (elementCollectorScriptCache.size > 32) elementCollectorScriptCache.delete(elementCollectorScriptCache.keys().next().value);
  return script;
}

module.exports = { BrowserViewController, summarizeTab, ANONYMOUS_INPUT_OWNER, decodeDuckDuckGoHref, selectElementsByAnchor };

